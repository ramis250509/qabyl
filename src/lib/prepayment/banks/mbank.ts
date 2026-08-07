// MBANK receipt parser. Based on the real sample supplied by the user:
//
//   Итого 200,00 ~
//   Детали операции   Перевод по номеру телефона.
//                     996704669575/ Бекжан Э./ /
//                     Сумма 200.00 KGS
//   Дата и время      29.07.2026 12:16
//   Квитанция №P0729061645710
//   По вопросам зачисления обратитесь к отправителю
//   Телефон службы поддержки  3333
//
// PDF receipts have a text layer (see extract-pdf.ts); screenshot PNGs are
// handed off to Gemini Vision, which returns a text approximation that we
// then run through the SAME regexes below. In both cases the code below is
// the source of truth for MBANK field extraction.

import type { BankAdapter, ExtractContext, ExtractedReceipt } from "./registry";
import { normalizePhone, parseAmount, normalizeCurrency, parseReceiptDateTime } from "../normalize";

// Detect: the word "mbank" (case-insensitive) has to appear somewhere — the
// logo/stamp text always shows "Mbank" — and at least ONE of the marker
// phrases below has to match, so an incidental mention of "mbank" in a note
// doesn't hijack detection.
const MBANK_MARKERS: RegExp[] = [
  /квитанция\s*№\s*P\d{10,}/i,
  /Детали\s+операции/i,
  /Дата\s+и\s+время/i,
];

// Regex bank. Each is anchored loosely to survive OCR noise.
const RE_TXN = /Квитанция\s*№\s*([A-Z0-9]{6,})/i;
const RE_AMOUNT_KGS = /Сумма\s+([\d\s.,]+)\s*(KGS|USD|RUB|KZT|EUR|сом|С|с)/i;
const RE_TOTAL = /Итого\s+([\d\s.,]+)\s*(с|С|KGS|USD|₽|RUB|₸|KZT|€|EUR)?/i;
const RE_DATETIME =
  /Дата\s+и\s+время\s+(\d{2}[./]\d{2}[./]\d{4}(?:[\sT]+\d{1,2}:\d{2}(?::\d{2})?)?)/i;
// Recipient line looks like:  "996704669575/ Бекжан Э./ /"   (phone / name / masked-card / )
// The tokens are split by " / " with irregular spacing. We accept 2..4 tokens.
const RE_RECIPIENT = /(\d{9,15})\s*\/\s*([^\/\n]+?)\s*\/(?:\s*([^\/\n]*)\s*\/)?/;

const RE_OPERATION = /Детали\s+операции\s+([^\n]+?)(?:\n|$)/i;

export const mbankAdapter: BankAdapter = {
  bank: "MBANK",
  displayName: "MBank",
  detect(ctx: ExtractContext): boolean {
    const t = (ctx.text ?? "").toLowerCase();
    if (!t.includes("mbank")) return false;
    return MBANK_MARKERS.some((re) => re.test(ctx.text ?? ""));
  },
  parse(ctx: ExtractContext): ExtractedReceipt {
    const text = ctx.text ?? "";
    const debug: Record<string, unknown> = {};

    let amount: number | null = null;
    let currency: string | null = null;
    const mAmount = text.match(RE_AMOUNT_KGS);
    if (mAmount) {
      amount = parseAmount(mAmount[1]);
      currency = normalizeCurrency(mAmount[2]) ?? "KGS";
      debug.amountVia = "Сумма";
    } else {
      const mTotal = text.match(RE_TOTAL);
      if (mTotal) {
        amount = parseAmount(mTotal[1]);
        currency = normalizeCurrency(mTotal[2] ?? "") ?? "KGS";
        debug.amountVia = "Итого";
      }
    }

    const mDate = text.match(RE_DATETIME);
    const txnAt = mDate ? parseReceiptDateTime(mDate[1]) : null;

    const mTxn = text.match(RE_TXN);
    const txnId = mTxn ? mTxn[1] : null;

    let recipientPhone: string | null = null;
    let recipientName: string | null = null;
    let recipientAccount: string | null = null;
    const mRcp = text.match(RE_RECIPIENT);
    if (mRcp) {
      recipientPhone = normalizePhone(mRcp[1]);
      recipientName = (mRcp[2] ?? "").trim() || null;
      recipientAccount = (mRcp[3] ?? "").trim() || null;
    } else {
      // Fallback: a bare 12-digit number preceded by "телефона" also names
      // the recipient phone.
      const m2 = text.match(/номер\w*\s+телефона[^\d]*(\d{9,15})/i);
      if (m2) recipientPhone = normalizePhone(m2[1]);
    }

    const mOp = text.match(RE_OPERATION);
    const operationType = mOp ? mOp[1].trim() : null;

    // Confidence heuristic: 1.0 if all 4 anchor fields hit, 0.25 per hit else.
    let hits = 0;
    if (amount !== null) hits += 1;
    if (txnAt) hits += 1;
    if (txnId) hits += 1;
    if (recipientPhone || recipientName) hits += 1;
    const parserConfidence = hits / 4;

    return {
      amount,
      currency: currency ?? "KGS",
      txnAt,
      txnId,
      recipientName,
      recipientPhone,
      recipientAccount,
      operationType,
      status: null,
      bank: "MBANK",
      parserConfidence,
      debug,
    };
  },
};
