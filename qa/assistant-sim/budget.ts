// QA-only metering. These are deliberately conservative USD-per-million-token rates.
// For the pinned 2.5 Flash model they match Google's published standard prices.
// Unrecognised model aliases get a much higher fallback, never a free pass.
type Rates = { input: number; output: number };

function ratesFor(model: string): Rates {
  if (/gemini-2\.5-flash(?:$|[-/])/.test(model)) return { input: 0.3, output: 2.5 };
  if (/flash/i.test(model)) return { input: 2, output: 10 };
  return { input: 10, output: 80 };
}

export type GeminiUsage = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
};

export function measuredCostUsd(
  model: string,
  usage: GeminiUsage | null | undefined,
): number | null {
  if (!usage || !Number.isFinite(usage.promptTokenCount) || usage.promptTokenCount! < 0)
    return null;
  const rates = ratesFor(model);
  // Cached tokens are deliberately charged at the full input price here. That overstates,
  // rather than understates, actual charges. Gemini includes them in promptTokenCount.
  const input = usage.promptTokenCount! + Math.max(0, usage.toolUsePromptTokenCount ?? 0);
  const output =
    Math.max(0, usage.candidatesTokenCount ?? 0) + Math.max(0, usage.thoughtsTokenCount ?? 0);
  return (input * rates.input + output * rates.output) / 1_000_000;
}

export function pendingUpperBoundUsd(model: string, requestBody: string): number {
  const rates = ratesFor(model);
  let maxOutputTokens = 8_192;
  let usesCache = false;
  try {
    const body = JSON.parse(requestBody);
    const configured = Number(body?.generationConfig?.maxOutputTokens);
    if (Number.isFinite(configured) && configured > 0) maxOutputTokens = configured;
    usesCache = Boolean(body?.cachedContent);
  } catch {
    // Unparseable requests receive the cautious default output bound.
  }
  // UTF-8 byte length is an intentionally loose ceiling for input token count.
  // A cached prompt isn't in this body, so reserve an additional $0.05 for it.
  return (
    (Buffer.byteLength(requestBody) * rates.input + maxOutputTokens * rates.output) / 1_000_000 +
    (usesCache ? 0.05 : 0) +
    0.005
  );
}

export function canStartRequest(spentUsd: number, reserveUsd: number, capUsd: number): boolean {
  return (
    Number.isFinite(spentUsd) &&
    Number.isFinite(reserveUsd) &&
    Number.isFinite(capUsd) &&
    spentUsd >= 0 &&
    reserveUsd >= 0 &&
    capUsd > 0 &&
    spentUsd + reserveUsd <= capUsd
  );
}
