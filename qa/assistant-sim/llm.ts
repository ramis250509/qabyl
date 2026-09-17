// Provider-agnostic JSON LLM call for the simulated CUSTOMER and the independent JUDGE.
//
// Deliberately not the assistant's own client (callGeminiTools): the judge must not share
// prompts, temperature or failure modes with what it is judging. Point SIM_JUDGE_* at a
// different model family (any OpenAI-compatible endpoint) for a fully independent verdict.
//
// Env:
//   SIM_LLM_PROVIDER     gemini (default) | openai
//   SIM_LLM_API_KEY      default: GEMINI_API_KEY
//   SIM_LLM_BASE_URL     for openai-compatible, e.g. https://openrouter.ai/api/v1
//   SIM_CUSTOMER_MODEL   default gemini-flash-latest
//   SIM_JUDGE_MODEL      default gemini-pro-latest
//   SIM_JUDGE_PROVIDER / SIM_JUDGE_API_KEY / SIM_JUDGE_BASE_URL — override the judge only
//
// МОДЕЛИ ЗАДАНЫ АЛИАСАМИ, А НЕ ВЕРСИЯМИ. Пин `gemini-2.5-pro` протух молча: Google закрыл его
// для новых аккаунтов, судья начал падать с 404, и качество разговоров перестало проверяться
// вообще — прогон при этом «проходил», потому что проверки по базе живут отдельно от судьи.
// Алиас `*-latest` переживает смену поколения; конкретную версию всегда можно вернуть через env.

export type LlmConfig = {
  provider: "gemini" | "openai";
  model: string;
  apiKey: string;
  baseUrl?: string;
};

export function customerLlm(): LlmConfig {
  return {
    provider: (process.env.SIM_LLM_PROVIDER as any) === "openai" ? "openai" : "gemini",
    model: process.env.SIM_CUSTOMER_MODEL ?? "gemini-flash-latest",
    apiKey: process.env.SIM_LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
    baseUrl: process.env.SIM_LLM_BASE_URL,
  };
}

export function judgeLlm(): LlmConfig {
  const provider =
    (process.env.SIM_JUDGE_PROVIDER ?? process.env.SIM_LLM_PROVIDER) === "openai"
      ? "openai"
      : "gemini";
  return {
    provider,
    model: process.env.SIM_JUDGE_MODEL ?? "gemini-pro-latest",
    apiKey:
      process.env.SIM_JUDGE_API_KEY ??
      process.env.SIM_LLM_API_KEY ??
      process.env.GEMINI_API_KEY ??
      "",
    baseUrl: process.env.SIM_JUDGE_BASE_URL ?? process.env.SIM_LLM_BASE_URL,
  };
}

/** The simulator's own outbound fetch, captured before any per-scenario fault wrapper is installed. */
const rawFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export async function llmJson<T>(
  cfg: LlmConfig,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<T> {
  if (!cfg.apiKey) throw new Error("LLM API key is not set (GEMINI_API_KEY or SIM_LLM_API_KEY)");
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const text =
        cfg.provider === "gemini"
          ? await callGemini(cfg, system, user, opts)
          : await callOpenAi(cfg, system, user, opts);
      return parseJsonLoose<T>(text);
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (!/429|5\d\d|timeout|fetch|JSON/i.test(lastErr)) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`LLM call failed (${cfg.provider}/${cfg.model}): ${lastErr}`);
}

async function callGemini(
  cfg: LlmConfig,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number },
) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const r = await rawFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.8,
        maxOutputTokens: opts.maxTokens ?? 4096,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`gemini ${r.status}: ${txt.slice(0, 300)}`);
  const json = JSON.parse(txt);
  return (json?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text ?? "")
    .join("");
}

async function callOpenAi(
  cfg: LlmConfig,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number },
) {
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await rawFetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.maxTokens ?? 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`openai ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt)?.choices?.[0]?.message?.content ?? "";
}

export function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`LLM returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
}
