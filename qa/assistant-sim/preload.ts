// Loaded with `bun --preload` before the runner. Replaces the service-role Supabase client with the
// in-memory FakeSupabase BY RESOLVED FILE PATH, so every import spelling (`@/integrations/...`,
// relative) gets the fake — and nothing in src/ has to know a simulator exists.
import { plugin } from "bun";

// Billing metering switches itself off without a service-role key; a real key in the shell must
// never make the simulator bill a real salon.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.PUBLIC_APP_URL = process.env.PUBLIC_APP_URL ?? "https://qabyl.com";

// ─── ограничитель запросов к Gemini ───────────────────────────────────────────────────────────
//
// ЗАЧЕМ. Чтобы прогон не долбил API очередью параллельных запросов и не ловил 429 на ровном месте.
//
// ЧЕГО ЭТО НЕ РЕШАЕТ. Бесплатный тир ограничен не скоростью, а СУТОЧНЫМ лимитом (около 20
// запросов на модель в день, quotaId GenerateRequestsPerDayPerProjectPerModel). Никакое
// замедление этого не обходит — на бесплатном ключе полный прогон невозможен, о чём предупреждает
// проверка квоты в run.ts. Ограничитель полезен на платном ключе: там лимит именно минутный.
//
// ПОЧЕМУ ЗДЕСЬ, А НЕ В llm.ts. Больше половины вызовов делает САМ АССИСТЕНТ через продакшн-код
// (callGeminiTools), а не симулятор. Ограничивать надо оба потока сразу, и единственная общая
// точка — fetch. Обёртка живёт только в preload симулятора, продакшна не касается.
//
// ПОЧЕМУ ОЧЕРЕДЬ, А НЕ ОТКАЗ. Упереться в потолок и подождать — это медленный прогон. Упереться и
// получить 429 — это сорванный прогон и сожжённые впустую минуты ожидания.
const SIM_RPM = Number(process.env.SIM_RPM ?? "15");
if (SIM_RPM > 0) {
  const GEMINI = "generativelanguage.googleapis.com";
  const minGapMs = 60_000 / SIM_RPM;
  let nextFreeAt = 0;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (!String(url).includes(GEMINI)) return realFetch(input, init);
    // Сериализуем: каждый следующий вызов занимает свой слот во времени, поэтому параллельные
    // сценарии выстраиваются в очередь, а не стартуют разом.
    const slot = Math.max(Date.now(), nextFreeAt);
    nextFreeAt = slot + minGapMs;
    const waitMs = slot - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    return realFetch(input, init);
  }) as typeof fetch;
}

plugin({
  name: "qabyl-sim-supabase",
  setup(build) {
    build.onLoad({ filter: /integrations[\\/]supabase[\\/]client\.server\.ts$/ }, () => ({
      loader: "ts",
      contents: `
        export const supabaseAdmin = new Proxy({}, {
          get(_t, prop) {
            const db = (globalThis as any).__QABYL_SIM_DB__;
            if (!db) throw new Error("assistant-sim: fake database is not installed");
            const v = db[prop];
            return typeof v === "function" ? v.bind(db) : v;
          },
        });
      `,
    }));
  },
});
