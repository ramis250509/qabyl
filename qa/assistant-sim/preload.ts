// Loaded with `bun --preload` before the runner. Replaces the service-role Supabase client with the
// in-memory FakeSupabase BY RESOLVED FILE PATH, so every import spelling (`@/integrations/...`,
// relative) gets the fake — and nothing in src/ has to know a simulator exists.
import { plugin } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { canStartRequest, measuredCostUsd, pendingUpperBoundUsd } from "./budget";

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
const budgetPath = fileURLToPath(new URL("../api-budget-local.json", import.meta.url));
const MAX_TEST_BUDGET_USD = 2.99;
const meteredBudgetPath = fileURLToPath(new URL("../api-budget-metered.local", import.meta.url));
const newSpendCapUsd = Number(process.env.SIM_NEW_SPEND_CAP_USD ?? 0);
type MeteredEntry = {
  id: string;
  model: string;
  reserveUsd: number;
  settledUsd?: number;
  status?: number;
};
type MeteredLedger = { capUsd: number; baselineCreditUsd?: number; entries: MeteredEntry[] };
const readMeteredLedger = (): MeteredLedger =>
  existsSync(meteredBudgetPath)
    ? (JSON.parse(readFileSync(meteredBudgetPath, "utf8")) as MeteredLedger)
    : {
        capUsd: newSpendCapUsd,
        baselineCreditUsd: Number(process.env.SIM_BASELINE_CREDIT_USD ?? 0) || undefined,
        entries: [],
      };
const meterTotal = (ledger: MeteredLedger) =>
  ledger.entries.reduce((sum, entry) => sum + (entry.settledUsd ?? entry.reserveUsd), 0);
{
  const GEMINI = "generativelanguage.googleapis.com";
  const minGapMs = SIM_RPM > 0 ? 60_000 / SIM_RPM : 0;
  let nextFreeAt = 0;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (!String(url).includes(GEMINI)) return realFetch(input, init);
    if (newSpendCapUsd > 0) {
      // The model-list and token-count APIs are free; cache creation is conservatively
      // counted as $0.02 to cover short-lived storage even though it has no usageMetadata.
      const generating = String(url).includes(":generateContent");
      const cacheCreation =
        String(url).includes("/cachedContents") &&
        String(init?.method ?? "GET").toUpperCase() === "POST";
      if (!generating && !cacheCreation) return realFetch(input, init);
      const model =
        String(url).match(/\/models\/([^/:?]+):generateContent/)?.[1] ?? "gemini-2.5-flash";
      const reserveUsd = cacheCreation
        ? 0.02
        : pendingUpperBoundUsd(model, typeof init?.body === "string" ? init.body : "");
      const ledger = readMeteredLedger();
      const capUsd = Math.min(ledger.capUsd, newSpendCapUsd);
      if (!canStartRequest(meterTotal(ledger), reserveUsd, capUsd)) {
        throw new Error(
          `QA spend cap reached: $${meterTotal(ledger).toFixed(4)} estimated / $${capUsd.toFixed(2)} limit`,
        );
      }
      const id = randomUUID();
      ledger.capUsd = capUsd;
      ledger.entries.push({ id, model, reserveUsd });
      writeFileSync(meteredBudgetPath, JSON.stringify(ledger));
      const slot = Math.max(Date.now(), nextFreeAt);
      nextFreeAt = slot + minGapMs;
      const waitMs = slot - Date.now();
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      const response = await realFetch(input, init);
      let settledUsd: number | null = cacheCreation ? reserveUsd : null;
      if (generating && response.ok) {
        const payload = (await response
          .clone()
          .json()
          .catch(() => null)) as any;
        // Use the response's actual model version if present, never trust a cheaper alias.
        settledUsd = measuredCostUsd(payload?.modelVersion ?? model, payload?.usageMetadata);
      }
      const updated = readMeteredLedger();
      const entry = updated.entries.find((item) => item.id === id);
      if (entry) {
        entry.status = response.status;
        if (settledUsd !== null) entry.settledUsd = settledUsd;
        writeFileSync(meteredBudgetPath, JSON.stringify(updated));
      }
      return response;
    }
    // The independent judge defaults to a Pro alias, with a much higher output rate than Flash.
    // Reserve generously per attempted call; do not refund ambiguous network failures.
    const reservation = /\/models\/[^/:]*pro/i.test(String(url)) ? 0.25 : 0.1;
    const reserved = existsSync(budgetPath)
      ? Number(JSON.parse(readFileSync(budgetPath, "utf8")).reservedUsd)
      : 0;
    if (!Number.isFinite(reserved) || reserved + reservation > MAX_TEST_BUDGET_USD) {
      throw new Error(
        `QA Gemini budget exhausted: $${reserved.toFixed(2)} reserved / $${MAX_TEST_BUDGET_USD}`,
      );
    }
    // Persist before sending. Every assistant/customer/judge request shares this ledger with
    // photo regression; repeated runs cannot silently reset the budget. This does not account
    // for production traffic on the same Google project.
    writeFileSync(
      budgetPath,
      JSON.stringify({ reservedUsd: Number((reserved + reservation).toFixed(2)) }),
    );
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
