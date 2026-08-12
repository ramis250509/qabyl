// Bank-agnostic field extraction: ask the model for the fields, not the text.
//
// The per-bank regex parsers only work for a bank someone has written a parser
// for, and only for the exact layout they were written from — the MBANK parser
// was built from a PDF and did not recognise the same bank's in-app screen.
// Kyrgyz clients pay from Optima, Demir, Bakai, Kompanion, O!Dengi and a dozen
// more, and their layouts change without notice. Chasing that with regexes is a
// permanent tax.
//
// The image is already being read by Gemini, so the cheaper answer is to ask it
// for the six fields the verifier actually checks. No layout knowledge, no bank
// list, and a new bank costs nothing.
//
// This does NOT decide anything. It only reports what is printed on the receipt;
// every comparison against the salon's requisites, the amount and the hold
// window stays in verify.ts, where a human can read the rules.

import type { ExtractedReceipt } from "./banks/registry";
import { normalizePhone, parseAmount } from "./normalize";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// "null when not printed" is repeated because the expensive failure here is an
// invented value: a hallucinated recipient phone would confirm a payment that
// never arrived. A missing field only costs a manual review.
const PROMPT = `You are reading a bank payment receipt (any bank, any country, any language).
Return ONLY a JSON object, no markdown fence, with exactly these keys:

{
  "bank": string|null,            // name of the bank/app that ISSUED this receipt, as printed
  "amount": number|null,          // the amount actually transferred, digits only, dot decimal
  "currency": string|null,        // ISO code if determinable: KGS, USD, RUB, KZT, EUR
  "txn_at": string|null,          // date+time of the operation, ISO 8601 with no timezone
  "txn_id": string|null,          // receipt / document / operation number, verbatim
  "recipient_name": string|null,  // WHO RECEIVED the money
  "recipient_phone": string|null, // phone the money was sent TO, digits only
  "recipient_account": string|null, // card/account the money was sent TO, as printed
  "status": string|null           // e.g. "Исполнен", "Успешно", "Failed", as printed
}

Rules:
- If a field is not printed on the receipt, return null. NEVER guess or infer it.
- recipient_* means the DESTINATION. Do not use the payer's own name, phone, or the
  account the money was debited from.
- recipient_name is the PERSON or company receiving the money. If the receipt only
  names the destination bank or wallet ("MBANK по номеру телефона", "Optima"),
  recipient_name is null — a bank is not a recipient name.
- txn_at is wall-clock time as printed on the receipt. Do NOT convert it to UTC and
  do NOT append a timezone; return it exactly as shown, e.g. "2026-08-12T12:58:00".
- If the receipt names a destination bank different from the issuing bank, "bank"
  is still the ISSUING one.
- amount is the transferred sum, not the fee and not the remaining balance.`;

export interface FieldExtractResult {
  ok: boolean;
  fields: ExtractedReceipt | null;
  error?: string;
}

export async function extractReceiptFields(input: {
  bytes: Uint8Array;
  mime: string;
  /** Salon timezone. A receipt prints local wall-clock with no offset. */
  timezone?: string;
}): Promise<FieldExtractResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, fields: null, error: "GEMINI_API_KEY missing" };

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: PROMPT },
          { inlineData: { mimeType: input.mime, data: uint8ArrayToBase64(input.bytes) } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  };

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { ok: false, fields: null, error: `Gemini ${resp.status}: ${await resp.text()}` };
    }
    const data = (await resp.json()) as any;
    const raw =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p?.text ?? "")
        .join("")
        .trim() ?? "";
    if (!raw) return { ok: false, fields: null, error: "empty response" };

    let parsed: any;
    try {
      // responseMimeType asks for bare JSON, but a fenced block still shows up
      // occasionally and is not worth failing a payment over.
      parsed = JSON.parse(raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    } catch {
      return { ok: false, fields: null, error: "response was not JSON" };
    }

    const amount =
      typeof parsed.amount === "number" ? parsed.amount : parseAmount(String(parsed.amount ?? ""));
    const txnAt = parseWallClock(parsed.txn_at, input.timezone);

    // How much of what the verifier needs actually came back. Kept in the same
    // 0..1 shape the regex parsers report, so verify.ts treats both the same.
    let hits = 0;
    if (amount !== null && Number.isFinite(amount)) hits += 1;
    if (txnAt && !Number.isNaN(txnAt.getTime())) hits += 1;
    if (parsed.txn_id) hits += 1;
    if (parsed.recipient_phone || parsed.recipient_name || parsed.recipient_account) hits += 1;

    return {
      ok: true,
      fields: {
        amount: amount !== null && Number.isFinite(amount) ? amount : null,
        currency: parsed.currency ? String(parsed.currency).toUpperCase() : null,
        txnAt: txnAt && !Number.isNaN(txnAt.getTime()) ? txnAt : null,
        txnId: parsed.txn_id ? String(parsed.txn_id) : null,
        recipientName: parsed.recipient_name ? String(parsed.recipient_name) : null,
        recipientPhone: parsed.recipient_phone
          ? normalizePhone(String(parsed.recipient_phone))
          : null,
        recipientAccount: parsed.recipient_account ? String(parsed.recipient_account) : null,
        operationType: null,
        status: parsed.status ? String(parsed.status) : null,
        bank: parsed.bank ? String(parsed.bank) : "UNKNOWN",
        parserConfidence: hits / 4,
        debug: { via: "vision-fields" },
      },
    };
  } catch (e: any) {
    return { ok: false, fields: null, error: e?.message ?? String(e) };
  }
}

/**
 * A receipt prints local time with no offset — "12 авг. 2026, 12:58" is 12:58 in
 * Bishkek. Reading that as UTC shifted every Kyrgyz payment six hours into the
 * future, and the verifier then rejected it as made after the hold expired.
 *
 * A string that already carries an offset (or Z) is trusted as-is.
 */
export function parseWallClock(raw: unknown, timezone?: string): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (hasOffset || !timezone) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Pretend the wall-clock is UTC, ask what that instant looks like in the salon's
  // zone, and shift by the difference. Handles DST because the offset is computed
  // for that very instant.
  const asIfUtc = new Date(`${s.replace(/\s+/, "T")}${/[zZ]$/.test(s) ? "" : "Z"}`);
  if (Number.isNaN(asIfUtc.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(asIfUtc)
      .reduce<Record<string, string>>((acc, p) => {
        if (p.type !== "literal") acc[p.type] = p.value;
        return acc;
      }, {});
    const back = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour === "24" ? "0" : parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return new Date(asIfUtc.getTime() - (back - asIfUtc.getTime()));
  } catch {
    return asIfUtc;
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      // @ts-expect-error TS's overload has trouble with Uint8Array chunk
      bytes.subarray(i, i + chunk),
    );
  }
  return btoa(bin);
}
