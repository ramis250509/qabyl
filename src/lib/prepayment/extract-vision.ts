// Text extraction via Gemini for images (and text-layer-less PDFs). The bank
// parsers run on the returned plain text — Gemini is a "smart OCR" only, not a
// verifier. Zero domain knowledge lives here; MBANK regexes stay in mbank.ts.
//
// Runs server-side (Cloudflare Worker). Requires GEMINI_API_KEY.

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Same prompt for images and PDFs. Ask for verbatim text — Gemini is far
// better at reading receipt-like documents than plain-OCR CV models, but we
// don't want it "helpfully" reformatting numbers.
const PROMPT = `Read the attached bank receipt and return its content verbatim as plain text.
Preserve every number, every currency symbol, and every phone/account fragment exactly as printed, including original spacing where it disambiguates fields.
Do NOT interpret, translate, summarize, or add commentary. Output ONLY the raw text of the receipt.`;

export interface VisionExtractInput {
  bytes: Uint8Array;
  mime: string;
}

export interface VisionExtractResult {
  ok: boolean;
  text: string;
  error?: string;
}

export async function extractTextWithVision(
  input: VisionExtractInput,
): Promise<VisionExtractResult> {
  const apiKey = (process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);
  if (!apiKey) {
    return { ok: false, text: "", error: "GEMINI_API_KEY missing" };
  }
  const base64 = uint8ArrayToBase64(input.bytes);
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: PROMPT }, { inlineData: { mimeType: input.mime, data: base64 } }],
      },
    ],
    generationConfig: { temperature: 0.0, maxOutputTokens: 2048 },
  };

  const url = `${GEMINI_URL(GEMINI_MODEL)}?key=${apiKey}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { ok: false, text: "", error: `Gemini ${resp.status}: ${await resp.text()}` };
    }
    const data = (await resp.json()) as any;
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p?.text ?? "")
        .join("\n")
        .trim() ?? "";
    return { ok: true, text };
  } catch (e: any) {
    return { ok: false, text: "", error: e?.message ?? String(e) };
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // btoa can't handle raw bytes >0xff — build with a chunked binary string.
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
