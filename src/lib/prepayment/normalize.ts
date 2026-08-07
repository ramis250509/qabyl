// Normalization helpers used by every bank parser. Kept pure so they can be
// unit-tested without any DB or network.

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 9) return null;
  // KG numbers: 12 digits with country code (996XXXXXXXXX), or 9 without,
  // or 10 with leading 0 (mobile short-form). Canonicalize to 12 where we can.
  if (digits.length === 9) return "996" + digits;
  if (digits.length === 10 && digits.startsWith("0")) return "996" + digits.slice(1);
  return digits;
}

// Compare two phones. Direct match on canonical form wins first; if either
// side is masked (e.g. "996 XXX XX 95 75") we fall back to a tail-4 match
// gated by the visible prefix.
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (da.length === 0 || db.length === 0) return false;

  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (na && nb) {
    if (na === nb) return true;
    if (na.slice(-7) === nb.slice(-7)) return true;
  }
  const tailLen = Math.min(4, Math.min(da.length, db.length));
  if (tailLen < 4) return false;
  if (da.slice(-tailLen) !== db.slice(-tailLen)) return false;
  const preA = da.slice(0, -tailLen);
  const preB = db.slice(0, -tailLen);
  // Country/operator code sits at the START in KG masks, so one prefix is a
  // PREFIX of the other (not suffix).
  return preA === "" || preB === "" || preA.startsWith(preB) || preB.startsWith(preA);
}

// Parse "1 234,56" / "1234.56" / "1,234.56" / "200" / "200,00" as a number.
export function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // Strip regular + non-breaking (U+00A0) + narrow-no-break (U+202F) spaces,
  // then anything that isn't a digit / decimal separator / sign.
  const cleaned = raw.replace(/\s/g, "").replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  // If BOTH , and . appear, the later one is the decimal separator.
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalized: string;
  if (lastDot === -1 && lastComma === -1) {
    normalized = cleaned;
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, "");
  } else {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// Currency alias map. Cyrillic "СОМ" appears once — variants that looked
// duplicated in the previous version were Cyrillic vs Latin lookalikes that
// prettier tried to sort. Keep this list narrow and add more only if a bank
// receipt uses them verbatim.
const CURRENCY_ALIASES: Record<string, string> = {
  KGS: "KGS",
  СОМ: "KGS",
  SOM: "KGS",
  С: "KGS",
  USD: "USD",
  $: "USD",
  ДОЛЛ: "USD",
  RUB: "RUB",
  "₽": "RUB",
  РУБ: "RUB",
  KZT: "KZT",
  "₸": "KZT",
  ТЕНГЕ: "KZT",
  EUR: "EUR",
  "€": "EUR",
  ЕВРО: "EUR",
};

export function normalizeCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase().replace(/\.$/, "");
  if (CURRENCY_ALIASES[key]) return CURRENCY_ALIASES[key];
  if (raw.trim().toLowerCase() === "с") return "KGS";
  return null;
}

// Loose name equality: case-insensitive, punctuation-stripped, and — for
// bank receipts that abbreviate to "First LAST." vs "First Last" — matches
// on shared word initials + tail. Direction-independent.
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokens(na);
  const tb = tokens(nb);
  return oneWayMatch(ta, tb) || oneWayMatch(tb, ta);
}

function oneWayMatch(short: string[], long: string[]): boolean {
  return short.every((t) => {
    if (t.length === 1) return long.some((lt) => lt.startsWith(t));
    return long.some((lt) => lt === t || lt.startsWith(t) || t.startsWith(lt));
  });
}

function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[.,;/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return s.split(" ").filter(Boolean);
}

// Parse "29.07.2026 12:16" / "29/07/2026 12:16" / "2026-07-29 12:16"
export function parseReceiptDateTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  // dd.mm.yyyy hh:mm
  let m = s.match(/(\d{2})[./](\d{2})[./](\d{4})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, dd, mo, yy, hh, mi, ss] = m;
    return new Date(
      Number(yy),
      Number(mo) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      ss ? Number(ss) : 0,
    );
  }
  // yyyy-mm-dd hh:mm
  m = s.match(/(\d{4})-(\d{2})-(\d{2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, yy, mo, dd, hh, mi, ss] = m;
    return new Date(
      Number(yy),
      Number(mo) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      ss ? Number(ss) : 0,
    );
  }
  // dd.mm.yyyy (no time)
  m = s.match(/(\d{2})[./](\d{2})[./](\d{4})/);
  if (m) {
    const [, dd, mo, yy] = m;
    return new Date(Number(yy), Number(mo) - 1, Number(dd));
  }
  return null;
}
