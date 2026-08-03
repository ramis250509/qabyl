// Bank adapter registry. Adding a bank = create a new file in this folder that
// exports a BankAdapter, then register it here. Keep the file order stable —
// detect() runs top-to-bottom, first match wins.

import { mbankAdapter } from "./mbank";

// The raw material a parser can look at:
//   * text  — best-effort text extraction (PDF text layer, or OCR result)
//   * hints — optional metadata: mime type, filename, embedded logos, etc.
export interface ExtractContext {
  text: string;
  mime: string;
  filename?: string;
  // If Vision was used, structured fields it returned (may be sparse).
  visionFields?: Partial<ExtractedReceipt>;
}

// What every bank adapter tries to produce. All fields optional at parse
// time — the verify pipeline decides what "missing" means per field.
export interface ExtractedReceipt {
  amount: number | null;
  currency: string | null;
  txnAt: Date | null; // when the transfer happened
  txnId: string | null; // квитанция / receipt / txn number
  recipientName: string | null;
  recipientPhone: string | null;
  recipientAccount: string | null; // card / account tail, if visible
  operationType: string | null;
  status: string | null;
  bank: string;
  // Adapter's own read of how well it recognized the receipt (0..1).
  parserConfidence: number;
  // Free-form debug (which regex matched, etc.).
  debug?: Record<string, unknown>;
}

export interface BankAdapter {
  bank: string; // canonical name, e.g. "MBANK"
  displayName: string; // user-facing, e.g. "MBank"
  detect(ctx: ExtractContext): boolean;
  parse(ctx: ExtractContext): ExtractedReceipt;
}

const ADAPTERS: BankAdapter[] = [mbankAdapter];

export function detectBank(ctx: ExtractContext): BankAdapter | null {
  for (const a of ADAPTERS) {
    try {
      if (a.detect(ctx)) return a;
    } catch {
      // A broken detector must never crash the pipeline — skip it.
    }
  }
  return null;
}

export function listSupportedBanks(): { bank: string; displayName: string }[] {
  return ADAPTERS.map((a) => ({ bank: a.bank, displayName: a.displayName }));
}
