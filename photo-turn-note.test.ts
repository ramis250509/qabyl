// Напоминание «сначала посчитай цену по фото» рядом со снимком клиента — целым ходом runWaAgentV4.
//
// Тест 24.09 (Avrora): фото + «сколько кератин?» — модель в 15 ходах с фото из 23 отвечала без
// расчёта, а на кыргызском назвала выдуманную вилку «4500–7000». Правило в системном промпте было;
// не хватало напоминания в самом ходе. Клиент его не писал — значит, в сохранённой истории его
// быть не должно, иначе через ход модель прочитает его как слова клиента.
//
// Run: bun test --isolate photo-turn-note
import { beforeEach, expect, mock, test } from "bun:test";

const dbProxy = new Proxy({} as any, {
  get(_t, prop) {
    return (globalThis as any).__WA_DB__[prop];
  },
});
mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: dbProxy }));

process.env.GEMINI_API_KEY = "test-key";

const { runWaAgentV4, PHOTO_TURN_NOTE } = await import("@/lib/wa-agent-v4.server");

const SALON_ID = "salon1";
const keratin = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Кератиновое выпрямление",
  category: null,
  price: 2500,
  price_max: 7000,
  price_type: "range",
  duration_min: 120,
  is_active: true,
  photo_pricing_config: {
    enabled: true,
    subject: "волос",
    criteria: [
      {
        id: "length",
        label: "Длина волос",
        mode: "base",
        shot: "current",
        options: [
          { id: "short", label: "До плеч", amount: 2500 },
          { id: "very_long", label: "Ниже лопаток", amount: 6000 },
        ],
      },
    ],
  },
};

// Любая цепочка запроса отдаёт одни и те же строки: ход не должен зависеть от того, какими
// фильтрами агент читает прайс.
function query(rows: any[]): any {
  const q: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then")
          return (resolve: any) => resolve({ data: rows, error: null, count: rows.length });
        if (prop === "maybeSingle" || prop === "single")
          return async () => ({ data: rows[0] ?? null, error: null });
        return () => q;
      },
    },
  );
  return q;
}

function useDb() {
  (globalThis as any).__WA_DB__ = {
    from: (table: string) => query(table === "services" ? [keratin] : []),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
  };
}

let requests: any[] = [];
globalThis.fetch = (async (url: any, init?: RequestInit) => {
  const u = String(url);
  // Как в Workers: fetch не обязан открывать data:-ссылки из симулятора.
  if (u.startsWith("data:")) throw new TypeError("Fetch API cannot load: data:");
  if (u.includes("/cachedContents")) return new Response('{"error":"skip"}', { status: 400 });
  if (u.includes("generativelanguage.googleapis.com")) {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    const parts = [{ text: "Кератин 6500 сом болот. Кайсы күнгө жазылгыңыз келет?" }];
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }),
      { status: 200 },
    );
  }
  return new Response("no", { status: 400 });
}) as any;

beforeEach(() => {
  requests = [];
  useDb();
});

function turn(message: { kind: "image" | "text"; text: string }) {
  return {
    salon: { salonId: SALON_ID, salonName: "Тест", timezone: "Asia/Bishkek", slug: "test" },
    config: { languages: ["ru", "ky"], manage_cutoff_hours: 0 },
    client: { phone: "996700000001", name: "Тест" },
    history: [],
    lastMessages: [
      {
        id: "m1",
        direction: "in" as const,
        kind: message.kind,
        text_body: message.text,
        ...(message.kind === "image"
          ? { media_signed_url: "data:image/jpeg;base64,AA==", media_path: `${SALON_ID}/a.jpg` }
          : {}),
        created_at: new Date().toISOString(),
      },
    ],
    branches: [],
    selectedBranchId: null,
    state: "collecting" as const,
    stateData: {},
    salonInfo: { working_hours: { mon: "10:00–20:00" }, address: "ул. Тестовая 1" },
  } as any;
}

const lastUserTexts = (request: any): string[] =>
  (request.contents ?? [])
    .filter((c: any) => c.role === "user")
    .at(-1)
    ?.parts.map((p: any) => p.text)
    .filter(Boolean) ?? [];

test("фото к услуге с ценой по фото — напоминание рядом со снимком, но не в истории", async () => {
  const res = await runWaAgentV4(turn({ kind: "image", text: "Кератин канча?" }));
  expect(lastUserTexts(requests[0])).toContain(PHOTO_TURN_NOTE);
  const history = JSON.stringify((res.nextStateData as any).v4_history);
  expect(history).toContain("Кератин канча?");
  expect(history).not.toContain(PHOTO_TURN_NOTE);
});

test("без фото напоминания нет", async () => {
  await runWaAgentV4(turn({ kind: "text", text: "Кератин канча?" }));
  expect(lastUserTexts(requests[0])).not.toContain(PHOTO_TURN_NOTE);
});

test("фото про другую зону — напоминания нет: по фото у салона считаются только волосы", async () => {
  await runWaAgentV4(turn({ kind: "image", text: "Сколько стоит маникюр вот такой?" }));
  expect(lastUserTexts(requests[0])).not.toContain(PHOTO_TURN_NOTE);
});

test("снимок из симулятора (data-ссылка) доходит до модели, даже если fetch её не открывает", async () => {
  const res = await runWaAgentV4(turn({ kind: "image", text: "Кератин канча?" }));
  const lastUser = (requests[0].contents ?? []).filter((c: any) => c.role === "user").at(-1);
  expect(lastUser.parts.some((p: any) => p.inlineData?.data === "AA==")).toBe(true);
  expect(res.debug.errors.join(" ")).not.toContain("image_fetch");
});
