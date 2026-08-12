// Parser for the "weekly grid" schedule spreadsheet that salons keep before they move to
// Qabyl: a block of 7 date columns, one row per 30-minute slot, and a free-text cell per
// booking written by whoever answered the phone that day.
//
// WHY A PARSER AND NOT A MANUAL RE-ENTRY
// --------------------------------------
// The alternative to this module is a person retyping ~60 appointments, which is both slower
// and less accurate than a parser whose mistakes are VISIBLE. That last word is the whole
// design principle here: this module never tries to be clever enough to be trusted blindly.
// It returns a confidence level and the untouched source text for every row, the importer
// stores that source text verbatim in client_notes, and a human approves the preview before
// anything is written. A parse that is 85% right and 100% auditable beats one that is 95%
// right and opaque.
//
// The file is pure — no DB, no network, no clock beyond the `today` passed in — so the whole
// thing is unit-testable against the real spreadsheet (see schedule-import.test.ts).

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/**
 * What kind of visit the cell describes. Deliberately a small closed set: these are the four
 * things this practice actually sells, and the mapping from kind → service row is supplied by
 * the caller rather than hardcoded, so prices and durations stay owner-editable.
 */
export type VisitKind = "consultation" | "repeat" | "program" | "injection" | "unknown";

export type ParsedBooking = {
  /** Salon-local date, YYYY-MM-DD. */
  date: string;
  /** Salon-local start time, HH:MM. */
  startTime: string;
  /** Salon-local end time, HH:MM — the slot's own end, NOT the service duration (see note below). */
  endTime: string;
  /** Best-effort client name. May be imperfect; `raw` is the source of truth. */
  clientName: string;
  visitKind: VisitKind;
  /** Amount already paid, in som, when the cell states one. */
  paid: number | null;
  /** Outstanding balance, in som, when the cell states one ("ост 15000"). */
  remainder: number | null;
  /** Curator/administrator credited in the cell — kept for the owner's own bookkeeping. */
  curator: string | null;
  /** Section header the block sat under: ОФФЛАЙН / ОНЛАЙН. */
  section: string | null;
  /** The cell exactly as written. Never discarded — it is stored on the appointment. */
  raw: string;
  /**
   * high   — name, time and money all parsed cleanly.
   * medium — parsed, but something was unusual (no amount, odd punctuation, >4 name words).
   * low    — we found a booking-shaped cell but are unsure what it says; needs a human read.
   */
  confidence: "high" | "medium" | "low";
  /** Human-readable reasons the confidence is not "high". Shown in the preview. */
  warnings: string[];
  /** Spreadsheet coordinates, so the preview can point a human at the exact cell. */
  cell: { row: number; column: number };
};

export type SheetParseResult = {
  bookings: ParsedBooking[];
  /** Problems that prevented a row/block from being read at all. */
  issues: Array<{ message: string; row: number; column?: number; raw?: string }>;
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Minimal RFC-4180 reader. Google's CSV export quotes any cell containing a comma or a
 * newline — and this sheet has both (a family booking is written as one multi-line cell) —
 * so a naive split(",") silently shreds those rows into garbage.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  // Drop a trailing empty line produced by a final newline.
  if (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// Both the genitive ("20 июля") and the nominative ("18 август", "03 октябрь") appear in the
// same sheet, sometimes capitalised ("22 Октябрь"). Matching on a stem covers all of them.
const MONTH_STEMS: Array<[RegExp, number]> = [
  [/^янв/i, 1],
  [/^фев/i, 2],
  [/^мар/i, 3],
  [/^апр/i, 4],
  [/^ма[йя]/i, 5],
  [/^июн/i, 6],
  [/^июл/i, 7],
  [/^авг/i, 8],
  [/^сен/i, 9],
  [/^окт/i, 10],
  [/^ноя/i, 11],
  [/^дек/i, 12],
];

function monthFromWord(word: string): number | null {
  for (const [re, n] of MONTH_STEMS) if (re.test(word)) return n;
  return null;
}

/**
 * "20 июля" → 2026-07-20.
 *
 * The sheet records no year, which is the classic way a spreadsheet import silently lands a
 * whole calendar 12 months off. Rather than assume "current year", we pick the candidate year
 * (last / this / next) whose resulting date is closest to `today`. A sheet written in December
 * that lists "5 января" then correctly resolves to next January, not last.
 */
export function parseDateHeader(header: string, today: string): string | null {
  const cleaned = (header ?? "").trim();
  if (!cleaned) return null;
  const m = cleaned.match(/(\d{1,2})\s*([А-Яа-яЁё]+)/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = monthFromWord(m[2]);
  if (!month || day < 1 || day > 31) return null;

  const todayMs = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  const baseYear = Number(today.slice(0, 4));
  let best: { iso: string; distance: number } | null = null;
  for (const year of [baseYear - 1, baseYear, baseYear + 1]) {
    const ms = Date.UTC(year, month - 1, day);
    // Guard against 31 April and friends rolling into the next month.
    const d = new Date(ms);
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) continue;
    const distance = Math.abs(ms - todayMs);
    if (!best || distance < best.distance) {
      best = {
        iso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        distance,
      };
    }
  }
  return best?.iso ?? null;
}

/** "09:00-09:30" / "09.00 – 09.30" → { start, end }. */
export function parseSlotLabel(label: string): { start: string; end: string } | null {
  const m = (label ?? "")
    .trim()
    .match(/^(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const hh1 = Number(m[1]);
  const hh2 = Number(m[3]);
  const mm1 = Number(m[2]);
  const mm2 = Number(m[4]);
  if (hh1 > 23 || hh2 > 24 || mm1 > 59 || mm2 > 59) return null;
  return {
    start: `${String(hh1).padStart(2, "0")}:${String(mm1).padStart(2, "0")}`,
    end: `${String(hh2).padStart(2, "0")}:${String(mm2).padStart(2, "0")}`,
  };
}

// ---------------------------------------------------------------------------
// Cell text
// ---------------------------------------------------------------------------

// Words that end the client's name and begin the "what/how much" part of the cell. Includes
// the misspellings that are actually in the sheet ("павторна", "кансультатция") — a matcher
// tuned to correct Russian would swallow them into the name.
//
// Split into two lists on purpose. Matching every keyword as a PREFIX was the first version's
// worst bug: the stems "с" and "ай" then matched «Сулайманова», «Сезим», «Аймээрим» and
// «Айтолкун», so a third of the real client names were silently truncated or lost. Short
// keywords must match a WHOLE token; only stems long enough to be unambiguous match as a
// prefix.
const KEYWORD_PREFIXES = [
  "консультац",
  "кансультат",
  "консултац",
  "повтор",
  "павтор",
  "первичн",
  "проект",
  "программ",
  "толук",
  "толоду",
  "остаток",
  "оплат",
  "доплат",
  "барганда",
  "катталган",
  "возможно",
  "цифров",
];
const KEYWORD_EXACT = [
  "повт",
  "пов",
  "укол",
  "бронь",
  "семейный",
  "семейная",
  "семейн",
  "ост",
  "опл",
  "барып",
  "келет",
  "барат",
  "жасайт",
  "кылат",
  "если",
  "жаш",
  "жашта",
  "ай",
  "с",
  "га",
  "ке",
];
const KEYWORD_PREFIX_RE = new RegExp(`^(?:${KEYWORD_PREFIXES.join("|")})`, "i");
const KEYWORD_EXACT_RE = new RegExp(`^(?:${KEYWORD_EXACT.join("|")})$`, "i");

function isKeyword(token: string): boolean {
  return KEYWORD_EXACT_RE.test(token) || KEYWORD_PREFIX_RE.test(token);
}

// Name particles that are lowercase but genuinely part of a Kyrgyz name:
// "Тилек кызы Адина", "Турдали к Айтурган", "Асан уулу Бек".
const NAME_PARTICLE_RE = /^(кызы|к|уулу|у|кыз)\.?$/i;

// Alternation, not a character class. ✅/✔/☑ are often followed by U+FE0F (variation selector),
// and putting that combining character INSIDE a class silently makes the class match the
// selector on its own — leaving stray invisible codepoints in the client's name. Matching each
// mark together with its optional selector strips the whole thing.
const CHECKMARK_RE = /(?:✅|✔|☑)️?|️/gu;

/**
 * Pull every money amount out of a cell.
 *
 * Handles the three ways amounts are written in this sheet: plain ("7000"), space-grouped
 * ("20 000"), and dot-grouped ("21.000"). The dot form is why we cannot simply strip
 * punctuation and read digits — "21.000" is twenty-one thousand som, not twenty-one.
 */
export function extractAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:[ .]\d{3})+|\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1].replace(/[ .]/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Interpret one free-text booking cell.
 *
 * Exported separately from the grid walker because this is the part with genuine ambiguity,
 * and it is where the tests earn their keep.
 */
export function parseCellText(raw: string): {
  clientName: string;
  visitKind: VisitKind;
  paid: number | null;
  remainder: number | null;
  curator: string | null;
  confidence: ParsedBooking["confidence"];
  warnings: string[];
} {
  const warnings: string[] = [];
  const text = raw.replace(CHECKMARK_RE, " ").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  // A bare capitalised word in brackets is always the curator, wherever it sits:
  // «7000(Аймира)», «Айгерим (Перизат) 21.000». Lifting it out first stops it from being
  // read as part of the client's name when it happens to appear before the amount.
  let parenCurator: string | null = null;
  const nameForScan = text.replace(/\(\s*([А-ЯЁӨҮҢ][а-яёөүң]{2,})\s*\)/g, (_m, who: string) => {
    parenCurator = who;
    return " ";
  });

  // ── Name: the leading run of word-shaped tokens before the first keyword or digit.
  const tokens = nameForScan.split(/[\s,]+/).filter(Boolean);
  const nameTokens: string[] = [];
  for (const tok of tokens) {
    // Strip surrounding punctuation BEFORE the keyword test — abbreviations in this sheet are
    // written with a trailing dot («пов. консультация»), and testing the dotted form against
    // the keyword list misses it and drags "пов" into the client's name.
    const bare = tok.replace(/^[^\p{L}\d]+/u, "").replace(/[.,;:)]+$/, "");
    if (!bare) break;
    if (/\d/.test(bare)) break;
    if (NAME_PARTICLE_RE.test(bare)) {
      nameTokens.push(bare);
      continue;
    }
    if (isKeyword(bare)) break;
    if (!/^\p{L}/u.test(bare)) break;
    nameTokens.push(bare);
    if (nameTokens.length >= 5) break;
  }
  const clientName = nameTokens.join(" ").trim();
  if (!clientName) {
    warnings.push("не удалось выделить имя клиента");
  } else if (nameTokens.length > 4) {
    warnings.push("имя длиннее 4 слов — проверьте, не попал ли в имя комментарий");
  }

  // A family cell books two or more people into one slot ("Мирланова Аяна 20жаш, Мирланов
  // Бекхан 10жашта (семейный)"). One appointment cannot represent two patients honestly, so
  // flag it and let a human split it rather than importing half the family.
  if (/семейн/i.test(lower) || /\d+\s*жаш/i.test(lower)) {
    warnings.push("похоже на семейную запись (несколько человек) — проверьте вручную");
  }

  // ── Money. "ост"/"остаток" introduces the balance; what was paid is the amount stated
  // BEFORE it. Keying off position rather than value matters: «10000 остаток 10000» is a
  // 10 000 deposit against a 10 000 balance, and a value-based "the one that isn't the
  // remainder" filter loses the deposit entirely whenever the two happen to be equal.
  let paid: number | null = null;
  let remainder: number | null = null;

  const remainderMatch = text.match(/ост(?:аток)?\.?\s*[:=]?\s*(\d{1,3}(?:[ .]\d{3})+|\d+)/i);
  let remainderAt = Infinity;
  if (remainderMatch) {
    remainder = Number(remainderMatch[1].replace(/[ .]/g, ""));
    remainderAt = remainderMatch.index ?? Infinity;
  }

  // Amounts below 100 are ages ("20жаш"), clock digits ("12:30 га келет") or stray numbering —
  // never prices in this sheet.
  const before = remainderAt === Infinity ? text : text.slice(0, remainderAt);
  const paidCandidates = extractAmounts(before).filter((n) => n >= 100);
  if (paidCandidates.length) paid = paidCandidates[0];
  if (paid === null && remainder === null) warnings.push("в ячейке нет суммы");

  // ── Visit kind. Order matters: an explicit "3 ай"/"проект" outranks the amount heuristic,
  // and "повтор" outranks "консультация" because "пов. консультация" is a repeat visit.
  const total = (paid ?? 0) + (remainder ?? 0);
  let visitKind: VisitKind = "unknown";

  // A hedge turns a statement into a maybe: «7000 (если что проект)» is a consultation that
  // MIGHT become a programme, not a programme. Reading it as a programme would put a 20 000
  // som service on a 7 000 som visit, so hedged programme words are ignored.
  const hedged = /если\s*что|возможно|вероятно|мүмкүн/i.test(lower);
  const saysProgram = /\b3\s*-?\s*ай|3-?ай|проект|программ|толук/i.test(lower);
  const isProgram = (saysProgram && !hedged) || (total >= 18000 && total <= 22000);
  if (saysProgram && hedged) {
    warnings.push("в ячейке «проект» под вопросом («если что»/«возможно») — вид приёма уточните");
  }
  const isRepeat = /повтор|павтор|повт\b|пов\./i.test(lower);
  const isInjection = /укол/i.test(lower);
  const isConsult = /консультац|кансультат|консултац|первичн/i.test(lower);

  if (isProgram) visitKind = "program";
  else if (isRepeat) visitKind = "repeat";
  else if (isInjection) visitKind = "injection";
  else if (isConsult) visitKind = "consultation";
  else if (paid !== null && paid >= 6000 && paid <= 8000) visitKind = "consultation";

  if (visitKind === "unknown") warnings.push("не удалось определить вид приёма");

  // ── Curator: the bracketed one if we found it, else a trailing capitalised word that is
  // not part of the name.
  let curator: string | null = parenCurator;
  const trailing = tokens[tokens.length - 1]?.replace(/[^\p{L}]/gu, "") ?? "";
  if (
    !curator &&
    trailing &&
    tokens.length > nameTokens.length &&
    /^\p{Lu}/u.test(trailing) &&
    !isKeyword(trailing) &&
    trailing.length >= 3
  ) {
    curator = trailing;
  }

  const confidence: ParsedBooking["confidence"] = !clientName
    ? "low"
    : warnings.length
      ? "medium"
      : "high";

  return { clientName, visitKind, paid, remainder, curator, confidence, warnings };
}

// ---------------------------------------------------------------------------
// Grid walker
// ---------------------------------------------------------------------------

const SECTION_RE = /^(ОФФЛАЙН|ОНЛАЙН|OFFLINE|ONLINE)$/i;

/**
 * Walk the sheet block by block.
 *
 * The layout repeats: a header row whose label column holds ОФФЛАЙН/ОНЛАЙН and whose
 * remaining columns hold date headers, then slot rows until the next header or a blank run.
 * We do not assume a fixed number of blocks, a fixed column offset, or seven columns per
 * block — the sheet already violates all three (the last block has two dates, and October's
 * blocks skip a column).
 *
 * NOTE ON DURATION: end time comes from the SLOT, not from the service's configured duration.
 * The grid is the practice's real timetable — two clients booked into 10:00 and 10:30 are 30
 * minutes apart in reality, and stretching each to the service's 40-minute duration would
 * manufacture overlaps that the double-booking constraint then rejects.
 */
export function parseScheduleSheet(csvText: string, today: string): SheetParseResult {
  const grid = parseCsv(csvText);
  const bookings: ParsedBooking[] = [];
  const issues: SheetParseResult["issues"] = [];

  let section: string | null = null;
  let dateByColumn = new Map<number, string>();

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    const labelIdx = row.findIndex((c) => c.trim() !== "");
    if (labelIdx === -1) continue;
    const label = row[labelIdx].trim();

    // ── Block header?
    if (SECTION_RE.test(label)) {
      section = label.toUpperCase();
      dateByColumn = new Map();
      for (let c = labelIdx + 1; c < row.length; c++) {
        const header = row[c].trim();
        if (!header) continue;
        const iso = parseDateHeader(header, today);
        if (iso) dateByColumn.set(c, iso);
        else issues.push({ message: `не разобрана дата «${header}»`, row: r + 1, column: c + 1 });
      }
      continue;
    }

    // ── Slot row?
    const slot = parseSlotLabel(label);
    if (!slot) continue;
    if (dateByColumn.size === 0) {
      // Slot rows before any header would be silently dropped otherwise.
      issues.push({ message: `строка со временем «${label}» вне блока с датами`, row: r + 1 });
      continue;
    }

    for (const [col, date] of dateByColumn) {
      const cellRaw = (row[col] ?? "").trim();
      if (!cellRaw) continue;
      const parsed = parseCellText(cellRaw);
      bookings.push({
        date,
        startTime: slot.start,
        endTime: slot.end,
        section,
        raw: cellRaw,
        cell: { row: r + 1, column: col + 1 },
        ...parsed,
      });
    }
  }

  return { bookings, issues };
}

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

/**
 * "2026-08-13" + "10:00" in `tz` → the UTC instant to store in `starts_at`.
 *
 * Re-implemented here rather than imported from `@/lib/tz` on purpose: that module pulls in
 * the browser Supabase client, and this file is imported by server functions where dragging
 * a client module into the graph is asking for trouble.
 *
 * The two-step correction handles any zone including DST ones. Asia/Bishkek is a fixed +06:00
 * with no DST, so for this importer the first guess is already exact — but hardcoding +6
 * would quietly break the day a salon in a DST zone uses the same importer.
 */
export function localTimeToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset = tzOffsetMs(new Date(guess), tz);
  const corrected = guess - offset;
  // A second pass settles the rare case where the first guess landed on the other side of a
  // DST boundary and therefore used the wrong offset.
  const offset2 = tzOffsetMs(new Date(corrected), tz);
  return new Date(guess - offset2);
}

function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - at.getTime();
}

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

/**
 * Stable fingerprint of a source row, stored on the appointment and uniquely indexed per
 * salon. Re-running the import recomputes the same key and the row is recognised instead of
 * duplicated.
 *
 * Built from date + slot start + a normalised name, and deliberately NOT from the raw text:
 * the owner routinely edits a cell after the fact (adds "✅", records a top-up), and a key
 * that changed on every edit would turn every re-import into a duplicate. Name normalisation
 * (case, ё/е, punctuation, whitespace) absorbs the same class of harmless edit.
 *
 * The trade-off is deliberate and stated: two DIFFERENT people with the same name in the same
 * slot on the same day would collide. That cannot happen for a single-doctor practice with a
 * one-appointment-per-slot grid, and the preview surfaces any collision before it is written.
 */
export function importKeyFor(b: Pick<ParsedBooking, "date" | "startTime" | "clientName">): string {
  const name = b.clientName
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-");
  return `sheet:${b.date}:${b.startTime}:${name || "unnamed"}`;
}
