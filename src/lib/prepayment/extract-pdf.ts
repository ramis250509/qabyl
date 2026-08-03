// PDF text extraction. In Cloudflare Workers we don't have access to node
// libs like pdf-parse (Buffer, streams). The strategy:
//
//   1. Try to strip the text layer from a PDF using a lightweight, purely-JS
//      parser (very small; only handles the "obvious" text-stream case that
//      MBANK and most Kyrgyz banks emit).
//   2. If that returns nothing usable, fall back to Gemini via extract-vision
//      — Gemini handles PDFs (image and text) natively.
//
// The naive parser here understands PDF's "BT ... ET" text-object blocks and
// their `Tj` / `TJ` string operators. It is deliberately dumb — no font
// substitution, no encoding tables, no CMap. That is good enough for MBANK's
// receipt (verified against the sample supplied by the user). For any bank
// where this parser returns garbage or empty, the pipeline drops to Vision.

const MIN_USEFUL_CHARS = 40;

export interface PdfExtractResult {
  ok: boolean;
  text: string;
  usedFallback: boolean;
  error?: string;
}

export async function extractTextFromPdf(bytes: Uint8Array): Promise<PdfExtractResult> {
  try {
    // Only look at chunks that look like a PDF. Bail otherwise; caller decides.
    const header = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
    if (!header.startsWith("%PDF")) {
      return { ok: false, text: "", usedFallback: false, error: "not a pdf" };
    }
    const asString = new TextDecoder("latin1").decode(bytes);
    const text = stripPdfTextStreams(asString);
    if (text.trim().length >= MIN_USEFUL_CHARS) {
      return { ok: true, text, usedFallback: false };
    }
    return { ok: false, text, usedFallback: false, error: "pdf text layer too small" };
  } catch (e: any) {
    return { ok: false, text: "", usedFallback: false, error: e?.message ?? String(e) };
  }
}

// Pull every string literal that appears inside a BT ... ET block, using either
// Tj (single string) or TJ (array of strings) as the paint operator. This
// discards positioning info — which is fine, since the bank parsers use regex
// on the concatenated content.
function stripPdfTextStreams(pdf: string): string {
  const chunks: string[] = [];
  const btRe = /BT\s([\s\S]*?)\sET/g;
  let m: RegExpExecArray | null;
  while ((m = btRe.exec(pdf)) !== null) {
    const block = m[1];
    const s = extractStringsFromTextBlock(block);
    if (s) chunks.push(s);
  }
  return chunks
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function extractStringsFromTextBlock(block: string): string {
  const out: string[] = [];
  // (...) strings, possibly with escaped parens \( \)
  const strRe = /\(((?:[^()\\]|\\[\s\S])*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(block)) !== null) {
    out.push(unescapePdfString(m[1]));
  }
  // <hex> strings
  const hexRe = /<([0-9A-Fa-f]+)>/g;
  while ((m = hexRe.exec(block)) !== null) {
    const hex = m[1].length % 2 === 0 ? m[1] : m[1] + "0";
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    // Assume WinAnsi-ish or UTF-16BE (leading FE FF). If UTF-16, decode as such;
    // otherwise treat as latin1 — good enough as a first pass; anything that
    // comes out mojibake falls through to Vision.
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      out.push(new TextDecoder("utf-16be").decode(bytes.subarray(2)));
    } else {
      out.push(new TextDecoder("latin1").decode(bytes));
    }
  }
  return out.join(" ").trim();
}

function unescapePdfString(raw: string): string {
  // PDF's string escapes are similar to C's. We only handle the common ones
  // — anything exotic (\ooo octal, \) etc.) just gets its backslash dropped.
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}
