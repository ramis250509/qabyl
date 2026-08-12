// Bank-agnostic field extraction.
//
// Written after two receipts were refused for reasons that had nothing to do
// with the payment: MBANK's in-app screen shares no labels with its PDF, and an
// Optima receipt was claimed by the MBANK parser because it mentioned "MBANK по
// номеру телефона" as the destination, then parsed into nothing.
//
// Run: bun test prepayment-fields.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { extractReceiptFields } from "@/lib/prepayment/extract-fields";

const realFetch = globalThis.fetch;
process.env.GEMINI_API_KEY = "test-key";

function mockGemini(payload: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }),
      { status },
    )) as any;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

test("reads an Optima receipt no hand-written parser covers", async () => {
  mockGemini({
    bank: "Optima Digital",
    amount: 10,
    currency: "KGS",
    txn_at: "2026-08-12T12:58:00",
    txn_id: "OP-99887766",
    recipient_name: "Рамис А.",
    recipient_phone: "996707111726",
    recipient_account: null,
    status: "Исполнен",
  });

  const r = await extractReceiptFields({ bytes: BYTES, mime: "image/jpeg" });

  expect(r.ok).toBe(true);
  expect(r.fields?.bank).toBe("Optima Digital");
  expect(r.fields?.amount).toBe(10);
  expect(r.fields?.currency).toBe("KGS");
  expect(r.fields?.recipientPhone).toBe("996707111726");
  expect(r.fields?.txnAt?.getDate()).toBe(12);
  // Everything the verifier needs was present.
  expect(r.fields?.parserConfidence).toBe(1);
});

test("a field the receipt does not print stays null instead of being invented", async () => {
  mockGemini({
    bank: "Demir Bank",
    amount: 500,
    currency: "KGS",
    txn_at: null,
    txn_id: null,
    recipient_name: null,
    recipient_phone: null,
    recipient_account: null,
    status: null,
  });

  const r = await extractReceiptFields({ bytes: BYTES, mime: "image/jpeg" });

  expect(r.fields?.recipientPhone).toBeNull();
  expect(r.fields?.txnAt).toBeNull();
  // A quarter of the anchors — verify.ts turns this into a manual review, which
  // is the right outcome: a missing recipient must never auto-confirm.
  expect(r.fields?.parserConfidence).toBe(0.25);
});

test("survives a fenced JSON block", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: '```json\n{"bank":"Bakai","amount":42,"currency":"KGS"}\n```' }],
            },
          },
        ],
      }),
      { status: 200 },
    )) as any;

  const r = await extractReceiptFields({ bytes: BYTES, mime: "image/jpeg" });
  expect(r.ok).toBe(true);
  expect(r.fields?.amount).toBe(42);
});

test("a Gemini failure is reported, not turned into empty fields", async () => {
  globalThis.fetch = (async () => new Response("quota", { status: 429 })) as any;
  const r = await extractReceiptFields({ bytes: BYTES, mime: "image/jpeg" });
  expect(r.ok).toBe(false);
  expect(r.fields).toBeNull();
});

// ---------------------------------------------------------------------------
// Receipt timestamps are local wall-clock. A real payment made at 12:58 in
// Bishkek was read as 12:58 UTC — six hours into the future — and the verifier
// rejected it as "совершён после истечения срока брони".
// ---------------------------------------------------------------------------
test("wall-clock on a receipt is read in the salon's timezone", async () => {
  const { parseWallClock } = await import("@/lib/prepayment/extract-fields");
  const d = parseWallClock("2026-08-12T12:58:00", "Asia/Bishkek");
  // Bishkek is UTC+6, so 12:58 local is 06:58 UTC.
  expect(d?.toISOString()).toBe("2026-08-12T06:58:00.000Z");
});

test("a timestamp that already carries an offset is left alone", async () => {
  const { parseWallClock } = await import("@/lib/prepayment/extract-fields");
  expect(parseWallClock("2026-08-12T12:58:00Z", "Asia/Bishkek")?.toISOString()).toBe(
    "2026-08-12T12:58:00.000Z",
  );
  expect(parseWallClock("2026-08-12T12:58:00+06:00", "Asia/Bishkek")?.toISOString()).toBe(
    "2026-08-12T06:58:00.000Z",
  );
});

test("without a timezone nothing is shifted", async () => {
  const { parseWallClock } = await import("@/lib/prepayment/extract-fields");
  expect(parseWallClock("2026-08-12T12:58:00")?.toISOString()).toBe("2026-08-12T12:58:00.000Z");
});
