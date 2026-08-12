// Verification pipeline for a prepayment receipt.
//
//   extract → detect bank → parse → validate → dedup → verdict + reasons
//
// The result is used by prepayment.functions.ts to:
//   - stamp appointment_prepayments (status, verdict, extracted, confidence)
//   - insert prepayment_receipt_hashes for anti-reuse
//   - insert prepayment_audit
//   - flip appointment to 'confirmed' if verify_mode allows it
//
// This file is deliberately DB-free — all persistence lives in the calling
// server-fn. That keeps the verifier unit-testable with a fixture bytes array.

import type { ExtractedReceipt } from "./banks/registry";
import { detectBank } from "./banks/registry";
import { extractReceiptFields } from "./extract-fields";
import { extractTextFromPdf } from "./extract-pdf";
import { extractTextWithVision } from "./extract-vision";
import { normalizePhone, phonesMatch, namesMatch } from "./normalize";

// Kinds of decisions the pipeline can produce.
export type Verdict = "verified" | "manual_review" | "rejected";

// The caller supplies these expectations — what the receipt has to prove.
export interface VerifyExpectations {
  expectedAmount: number;
  expectedCurrency: string;
  recipientName: string | null;
  // At least one of these should match. The verifier logs a reason if neither
  // is present in settings — that's a misconfiguration on the salon side.
  recipientPhone: string | null;
  recipientAccount: string | null;
  // The receipt's txn time must fall inside [holdStartedAt - graceStart,
  // holdExpiresAt + graceEnd]. Both are half-hour by default.
  holdStartedAt: Date;
  holdExpiresAt: Date;
  // Optional: reject if amount tolerance breach exceeds this fraction (0..1).
  // Small overpayments (client paid a little more) are always fine.
  amountTolerance?: number;
  // For anti-reuse. Caller passes what already exists in the DB.
  existingFileSha256s?: Set<string>;
  existingTxnIds?: Set<string>;
  // Also seen phashes (for cropped/re-saved screenshots).
  existingPhashes?: string[];
}

export interface VerifyInput {
  bytes: Uint8Array;
  mime: string;
  filename?: string;
  fileSha256: string;
  filePhash?: string;
  expectations: VerifyExpectations;
}

export interface VerifyResult {
  verdict: Verdict;
  reasons: string[]; // human-readable, i18n-ready
  reasonCodes: string[]; // stable identifiers ("wrong_recipient", ...)
  bank: string | null;
  extracted: ExtractedReceipt | null;
  confidence: number; // 0..1
  usedFallback: boolean; // true if we had to hit Vision
  rawText: string; // for debugging + admin viewer
  meta: {
    parserConfidence: number;
    overallConfidence: number;
  };
}

// Verdict thresholds. Kept liberal — anything ambiguous goes to manual_review
// rather than auto-approving. Auto-rejection is reserved for clear negatives.
const AUTO_VERIFY_MIN_CONFIDENCE = 0.75;
const AMOUNT_TOLERANCE_DEFAULT = 0.02; // 2 %
const TXN_TIME_GRACE_BEFORE_MS = 10 * 60 * 1000; // 10 min before hold started
const TXN_TIME_GRACE_AFTER_MS = 60 * 60 * 1000; // 60 min after hold expired

export async function verifyReceipt(input: VerifyInput): Promise<VerifyResult> {
  const reasons: string[] = [];
  const reasonCodes: string[] = [];

  // 1) Anti-reuse: same file twice for THIS salon = reject before anything else.
  if (input.expectations.existingFileSha256s?.has(input.fileSha256)) {
    return {
      verdict: "rejected",
      reasons: ["Этот чек уже был отправлен ранее"],
      reasonCodes: ["duplicate_file"],
      bank: null,
      extracted: null,
      confidence: 0,
      usedFallback: false,
      rawText: "",
      meta: { parserConfidence: 0, overallConfidence: 0 },
    };
  }
  if (
    input.filePhash &&
    input.expectations.existingPhashes?.some((h) => hamming(h, input.filePhash!) <= 5)
  ) {
    return {
      verdict: "rejected",
      reasons: ["Похоже, что этот чек уже присылался"],
      reasonCodes: ["duplicate_phash"],
      bank: null,
      extracted: null,
      confidence: 0,
      usedFallback: false,
      rawText: "",
      meta: { parserConfidence: 0, overallConfidence: 0 },
    };
  }

  // 2) Extract text. PDFs → try text layer first; images → Vision.
  let rawText = "";
  let usedFallback = false;
  if (input.mime === "application/pdf" || (input.filename ?? "").toLowerCase().endsWith(".pdf")) {
    const pdfRes = await extractTextFromPdf(input.bytes);
    if (pdfRes.ok) {
      rawText = pdfRes.text;
    } else {
      const vis = await extractTextWithVision({ bytes: input.bytes, mime: "application/pdf" });
      rawText = vis.text;
      usedFallback = true;
      if (!vis.ok) {
        return {
          verdict: "manual_review",
          reasons: ["Не удалось прочитать PDF автоматически"],
          reasonCodes: ["extract_failed"],
          bank: null,
          extracted: null,
          confidence: 0,
          usedFallback: true,
          rawText: "",
          meta: { parserConfidence: 0, overallConfidence: 0 },
        };
      }
    }
  } else if (input.mime.startsWith("image/")) {
    const vis = await extractTextWithVision({ bytes: input.bytes, mime: input.mime });
    rawText = vis.text;
    usedFallback = true;
    if (!vis.ok) {
      return {
        verdict: "manual_review",
        reasons: ["Не удалось прочитать изображение автоматически"],
        reasonCodes: ["extract_failed"],
        bank: null,
        extracted: null,
        confidence: 0,
        usedFallback: true,
        rawText: "",
        meta: { parserConfidence: 0, overallConfidence: 0 },
      };
    }
  } else {
    return {
      verdict: "rejected",
      reasons: ["Файл не является изображением или PDF"],
      reasonCodes: ["unsupported_type"],
      bank: null,
      extracted: null,
      confidence: 0,
      usedFallback: false,
      rawText: "",
      meta: { parserConfidence: 0, overallConfidence: 0 },
    };
  }

  // 3) Get the fields. A hand-written parser when one recognises this layout,
  //    otherwise — and this is the normal case — straight from the image.
  //
  //    Clients pay from whatever bank they use, and a regex parser only covers
  //    the one bank someone wrote it for, in the one layout they wrote it from.
  //    Two real failures made that plain: MBANK's own in-app screen shares no
  //    labels with its PDF, and an Optima receipt that merely mentioned "MBANK
  //    по номеру телефона" was claimed by the MBANK adapter and then parsed into
  //    nothing. So a parser that produces nothing usable is treated as no parser
  //    at all, and the model is asked for the fields directly.
  const adapter = detectBank({ text: rawText, mime: input.mime, filename: input.filename });
  let extracted = adapter
    ? adapter.parse({ text: rawText, mime: input.mime, filename: input.filename })
    : null;

  const USABLE_PARSE = 0.5; // at least half the anchor fields
  if (!extracted || extracted.parserConfidence < USABLE_PARSE) {
    const viaFields = await extractReceiptFields({ bytes: input.bytes, mime: input.mime });
    if (viaFields.ok && viaFields.fields) {
      // Keep whichever read more of the receipt; a specific parser that did well
      // is still preferred, since it knows the layout exactly.
      if (!extracted || viaFields.fields.parserConfidence > extracted.parserConfidence) {
        extracted = viaFields.fields;
        usedFallback = true;
      }
    }
  }

  if (!extracted) {
    return {
      verdict: "manual_review",
      reasons: ["Не удалось разобрать чек"],
      reasonCodes: ["unparsed_receipt"],
      bank: null,
      extracted: null,
      confidence: 0,
      usedFallback,
      rawText,
      meta: { parserConfidence: 0, overallConfidence: 0 },
    };
  }

  // 4) Anti-reuse by txn.
  if (extracted.txnId && input.expectations.existingTxnIds?.has(extracted.txnId)) {
    return {
      verdict: "rejected",
      reasons: ["Номер квитанции уже использовался"],
      reasonCodes: ["duplicate_txn"],
      bank: extracted.bank ?? adapter?.bank ?? null,
      extracted,
      confidence: extracted.parserConfidence,
      usedFallback,
      rawText,
      meta: {
        parserConfidence: extracted.parserConfidence,
        overallConfidence: extracted.parserConfidence,
      },
    };
  }

  // 5) Field-by-field validation.
  const exp = input.expectations;

  // Amount
  if (extracted.amount === null) {
    reasons.push("Не удалось распознать сумму");
    reasonCodes.push("amount_missing");
  } else {
    const tolerance = exp.amountTolerance ?? AMOUNT_TOLERANCE_DEFAULT;
    const diff = extracted.amount - exp.expectedAmount;
    if (diff < -exp.expectedAmount * tolerance) {
      reasons.push(
        `Сумма меньше требуемой (${extracted.amount} < ${exp.expectedAmount} ${exp.expectedCurrency})`,
      );
      reasonCodes.push("amount_too_low");
    }
    // Overpayment is fine — no reason added.
  }

  // Currency
  if (extracted.currency && exp.expectedCurrency && extracted.currency !== exp.expectedCurrency) {
    reasons.push(`Валюта не совпадает (${extracted.currency} vs ${exp.expectedCurrency})`);
    reasonCodes.push("wrong_currency");
  }

  // Recipient — phone OR account has to match if the salon supplied one.
  const wantPhone = normalizePhone(exp.recipientPhone ?? "");
  const wantAcct = (exp.recipientAccount ?? "").replace(/\s/g, "");
  const gotPhone = normalizePhone(extracted.recipientPhone ?? "");
  const gotAcct = (extracted.recipientAccount ?? "").replace(/\s/g, "");

  const phoneOk = wantPhone && gotPhone && phonesMatch(wantPhone, gotPhone);
  const acctOk = wantAcct && gotAcct && gotAcct.includes(wantAcct.slice(-4));

  if (wantPhone || wantAcct) {
    if (!phoneOk && !acctOk) {
      reasons.push("Получатель не совпадает с реквизитами салона");
      reasonCodes.push("wrong_recipient");
    }
  } else {
    reasons.push("Реквизиты салона не заданы — сверка получателя пропущена");
    reasonCodes.push("recipient_missing_settings");
  }

  // Name — soft-check. Mismatch does NOT auto-reject (name spellings vary a
  // lot), but it downgrades to manual review if phone/account also missed.
  if (exp.recipientName && extracted.recipientName) {
    if (!namesMatch(exp.recipientName, extracted.recipientName)) {
      reasons.push("Имя получателя отличается");
      reasonCodes.push("name_mismatch");
    }
  }

  // Txn time — must be inside [holdStarted - grace, holdExpires + grace].
  if (!extracted.txnAt) {
    reasons.push("Не удалось распознать время операции");
    reasonCodes.push("txn_time_missing");
  } else {
    const t = extracted.txnAt.getTime();
    const lo = exp.holdStartedAt.getTime() - TXN_TIME_GRACE_BEFORE_MS;
    const hi = exp.holdExpiresAt.getTime() + TXN_TIME_GRACE_AFTER_MS;
    if (t < lo) {
      reasons.push("Перевод был совершён раньше, чем создана бронь");
      reasonCodes.push("txn_too_early");
    } else if (t > hi) {
      reasons.push("Перевод был совершён после истечения срока брони");
      reasonCodes.push("txn_too_late");
    }
  }

  // 6) Verdict.
  const parserConf = extracted.parserConfidence;
  const overallConf = clamp01(parserConf * (reasons.length === 0 ? 1 : 0.5));

  const hardRejects = new Set([
    "amount_too_low",
    "wrong_currency",
    "wrong_recipient",
    "duplicate_txn",
    "duplicate_file",
  ]);
  const anyHardReject = reasonCodes.some((c) => hardRejects.has(c));
  if (anyHardReject) {
    return {
      verdict: "rejected",
      reasons,
      reasonCodes,
      bank: extracted.bank ?? adapter?.bank ?? null,
      extracted,
      confidence: overallConf,
      usedFallback,
      rawText,
      meta: { parserConfidence: parserConf, overallConfidence: overallConf },
    };
  }

  if (reasons.length === 0 && overallConf >= AUTO_VERIFY_MIN_CONFIDENCE) {
    return {
      verdict: "verified",
      reasons: ["Все проверки пройдены"],
      reasonCodes: ["ok"],
      bank: extracted.bank ?? adapter?.bank ?? null,
      extracted,
      confidence: overallConf,
      usedFallback,
      rawText,
      meta: { parserConfidence: parserConf, overallConfidence: overallConf },
    };
  }

  return {
    verdict: "manual_review",
    reasons: reasons.length ? reasons : ["Требуется ручная проверка"],
    reasonCodes: reasonCodes.length ? reasonCodes : ["low_confidence"],
    bank: extracted.bank ?? adapter?.bank ?? null,
    extracted,
    confidence: overallConf,
    usedFallback,
    rawText,
    meta: { parserConfidence: parserConf, overallConfidence: overallConf },
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}
