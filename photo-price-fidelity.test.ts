// Ответ ассистента обязан совпадать с расчётом по фото — сверка кодом после ответа модели.
//
// Тест Avrora 25.09: инструмент посчитал варианты причёски 1600 / 1800 / 2000 (длина с фото), а
// клиентке ушло «у нас от 1000 до 2000» — вилка прайса; в другом ходе — «длинные и густые
// волосы», хотя густота по фото под вопросом. Цена строго по правилам салона — главное обещание
// функции, поэтому это проверяет код, а не просьба в промпте.
//
// Run: bun test --isolate photo-price-fidelity
import { beforeEach, describe, expect, mock, test } from "bun:test";

const dbProxy = new Proxy({} as any, {
  get(_t, prop) {
    return (globalThis as any).__WA_DB__[prop];
  },
});
mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: dbProxy }));

process.env.GEMINI_API_KEY = "test-key";

const { claimsUnsureDensity, pricesInReply, runWaAgentV4, strayPhotoPrices } =
  await import("@/lib/wa-agent-v4.server");

describe("какие суммы ответ называет ценой", () => {
  test("русские и кыргызские формы", () => {
    expect(pricesInReply("Однотон — 900 сом, сложный дизайн — 1 100 сом.")).toEqual([900, 1100]);
    expect(pricesInReply("Будет 6000–6500 сом. Запись на 15:00?")).toEqual([6000, 6500]);
    expect(pricesInReply("Причёска у нас стоит от 1000 до 2000 сом.")).toEqual([1000, 2000]);
    expect(pricesInReply("кератин 4500 сомдон 7000 сомго чейин болот")).toEqual([4500, 7000]);
    expect(pricesInReply("Кератин 2500дөн 7000 сомго чейин.")).toEqual([2500, 7000]);
  });
});

describe("ответ против расчёта", () => {
  const hairstyle = {
    estimate: "choice",
    price_by_choice: [
      { choice: "hairstyle:simple", label: "Простая укладка или волны", price_label: "1600 сом" },
      { choice: "hairstyle:curls", label: "Локоны, полусобранная", price_label: "1800 сом" },
      { choice: "hairstyle:updo", label: "Собранная, пучок или плетение", price_label: "2000 сом" },
    ],
    catalog_range: "1000–2000 сом",
  };

  test("вилка прайса вместо цен вариантов — расхождение (P1, 25.09)", () => {
    const check = strayPhotoPrices(
      "Праздничная причёска у нас стоит от 1000 до 2000 сом. Можете прислать фото желаемого результата?",
      [hairstyle],
    );
    expect(check.catalogInstead).toBe(true);
    expect(check.stray).toEqual([1000]);
  });

  test("варианты с их ценами — не расхождение", () => {
    const check = strayPhotoPrices(
      "Простая укладка — 1600 сом, локоны — 1800 сом, собранная — 2000 сом. Что выберете?",
      [hairstyle],
    );
    expect(check).toEqual({ stray: [], unnamed: false, catalogInstead: false });
  });

  test("цена другой услуги в том же ответе — не расхождение", () => {
    const keratin = {
      estimate: "range",
      price_label: "6000–6500 сом",
      catalog_range: "2500–7000 сом",
    };
    const reply = "Кератин по фото — 6000–6500 сом, а женская стрижка — 700 сом.";
    expect(strayPhotoPrices(reply, [keratin]).stray).toEqual([700]);
    expect(strayPhotoPrices(reply, [keratin], new Set([500, 700])).stray).toEqual([]);
  });

  test("посчитанная цена не прозвучала — расхождение", () => {
    const exact = { estimate: "exact", price_label: "500 сом", catalog_range: "500–1000 сом" };
    expect(strayPhotoPrices("На какой день вас записать?", [exact]).unnamed).toBe(true);
    expect(strayPhotoPrices("Стрижка будет 500 сом.", [exact]).unnamed).toBe(false);
  });
});

describe("густота, которую фото не показало", () => {
  const unsure = { unsure_options: { Густота: ["Обычная", "Густая", "Очень густая"] } };
  const thickOnly = { unsure_options: { Густота: ["Густая", "Очень густая"] } };

  test("«густые» при возможной обычной — утверждение (H5, 25.09)", () => {
    const reply = "По фото видно, что у вас длинные и густые волосы ниже лопаток.";
    expect(claimsUnsureDensity(reply, unsure)).toBe(true);
    // Густая или очень густая — «густые» верно в любом случае.
    expect(claimsUnsureDensity(reply, thickOnly)).toBe(false);
    expect(claimsUnsureDensity("Чачыңыз узун жана тыгыз экен.", unsure)).toBe(true);
    expect(claimsUnsureDensity("У вас волосы обычной густоты.", thickOnly)).toBe(true);
  });

  test("сказать, что густоту не видно, — можно", () => {
    for (const reply of [
      "Это предварительная оценка, так как по фото сложно определить густоту волос.",
      "Точная цена зависит от густоты.",
      "Чачыңыздын тыгыздыгы жакшыраак көрүнгөн сүрөт жиберсеңиз болот.",
    ])
      expect(claimsUnsureDensity(reply, unsure)).toBe(false);
  });
});

// ---- Целый ход: модель назвала прайс вместо расчёта → второй круг с посчитанной ценой.

const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const keratin = {
  id: SERVICE_ID,
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
      {
        id: "density",
        label: "Густота",
        mode: "surcharge",
        shot: "current",
        options: [
          { id: "normal", label: "Обычная", amount: 0 },
          { id: "thick", label: "Густая", amount: 500 },
        ],
      },
    ],
  },
};

const MANICURE_ID = "22222222-2222-4222-8222-222222222222";
const manicure = {
  id: MANICURE_ID,
  name: "Маникюр с дизайном",
  category: null,
  price: 800,
  price_max: 1200,
  price_type: "range",
  duration_min: 90,
  is_active: true,
  photo_pricing_config: {
    enabled: true,
    subject: "ногтей",
    criteria: [
      {
        id: "nail_state",
        label: "Что сейчас на ногтях",
        mode: "base",
        shot: "current",
        options: [
          { id: "bare", label: "Без покрытия", amount: 800 },
          { id: "gel", label: "Старый гель-лак", amount: 900 },
        ],
      },
      {
        id: "design",
        label: "Сложность дизайна",
        mode: "surcharge",
        shot: "reference",
        options: [
          { id: "plain", label: "Однотон", amount: 0 },
          { id: "complex", label: "Сложный дизайн", amount: 200 },
        ],
      },
    ],
  },
};

// Фильтры .eq() учитываются для полей, которые у строки есть: инструмент читает услугу по id.
function query(rows: any[]): any {
  const filters: [string, unknown][] = [];
  const picked = () => rows.filter((r) => filters.every(([k, v]) => !(k in r) || r[k] === v));
  const q: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then")
          return (resolve: any) => resolve({ data: picked(), error: null, count: picked().length });
        if (prop === "maybeSingle" || prop === "single")
          return async () => ({ data: picked()[0] ?? null, error: null });
        if (prop === "eq")
          return (k: string, v: unknown) => {
            filters.push([k, v]);
            return q;
          };
        return () => q;
      },
    },
  );
  return q;
}

let vision: "hair" | "irrelevant" = "hair";

let modelReplies: any[][] = [];
let modelRequests: any[] = [];
globalThis.fetch = (async (url: any, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith("data:")) {
    return new Response(Buffer.from(u.split(",")[1], "base64"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }
  if (u.includes("/cachedContents")) return new Response('{"error":"skip"}', { status: 400 });
  if (u.includes("generativelanguage.googleapis.com")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    // Распознавание фото: волосы — длина видна, густота обычная или густая; ногти — гель-лак,
    // примера дизайна нет; «лицо» — ничего нужного.
    if (body.generationConfig?.responseSchema?.properties?.relevant) {
      const nails = JSON.stringify(body.systemInstruction).includes("nail_state");
      const text = JSON.stringify(
        vision === "irrelevant"
          ? { relevant: false, values: [], uncertain: [] }
          : nails
            ? {
                relevant: true,
                values: [{ criterion_id: "nail_state", option_id: "gel", possible: ["gel"] }],
                uncertain: ["design"],
              }
            : {
                relevant: true,
                values: [
                  { criterion_id: "length", option_id: "very_long", possible: ["very_long"] },
                  { criterion_id: "density", option_id: "normal", possible: ["normal", "thick"] },
                ],
                uncertain: [],
              },
      );
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
        status: 200,
      });
    }
    modelRequests.push(body);
    const parts = modelReplies.shift() ?? [{ text: "…" }];
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }),
      { status: 200 },
    );
  }
  return new Response("no", { status: 400 });
}) as any;

beforeEach(() => {
  modelReplies = [];
  modelRequests = [];
  vision = "hair";
  (globalThis as any).__WA_DB__ = {
    from: (table: string) => query(table === "services" ? [keratin, manicure] : []),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
  };
});

const photoTurn = (text: string) =>
  ({
    salon: { salonId: "salon1", salonName: "Тест", timezone: "Asia/Bishkek", slug: "test" },
    config: { languages: ["ru"], manage_cutoff_hours: 0 },
    client: { phone: "996700000001", name: "Тест" },
    history: [],
    lastMessages: [
      {
        id: "m1",
        direction: "in" as const,
        kind: "image" as const,
        text_body: text,
        media_signed_url: "data:image/jpeg;base64,AA==",
        media_path: "salon1/a.jpg",
        created_at: new Date().toISOString(),
      },
    ],
    branches: [],
    selectedBranchId: null,
    state: "collecting" as const,
    stateData: {},
    salonInfo: { working_hours: { mon: "10:00–20:00" }, address: "ул. Тестовая 1" },
  }) as any;

const lastUserText = (request: any) =>
  (request.contents ?? [])
    .filter((c: any) => c.role === "user")
    .at(-1)
    ?.parts.map((p: any) => p.text ?? "")
    .join(" ") ?? "";

test("модель назвала прайс вместо расчёта — второй круг, и клиент получает посчитанную цену", async () => {
  modelReplies = [
    [{ functionCall: { name: "estimate_price_from_photo", args: { service_id: SERVICE_ID } } }],
    [{ text: "Кератин у нас от 2500 до 7000 сом. Хотите записаться?" }],
    [{ text: "По фото кератин будет 6000–6500 сом. Хотите записаться?" }],
  ];
  const res = await runWaAgentV4(photoTurn("Сколько будет кератин?"));
  expect(res.debug.errors).toContain("photo_price_mismatch");
  expect(lastUserText(modelRequests[2])).toContain("Цена по фото уже посчитана: 6000–6500 сом");
  expect(res.reply).toContain("6000–6500 сом");
});

test("модель назвала посчитанную вилку — второго круга нет", async () => {
  modelReplies = [
    [{ functionCall: { name: "estimate_price_from_photo", args: { service_id: SERVICE_ID } } }],
    [{ text: "По фото кератин будет 6000–6500 сом. Хотите записаться?" }],
  ];
  const res = await runWaAgentV4(photoTurn("Сколько будет кератин?"));
  expect(res.debug.errors).not.toContain("photo_price_mismatch");
  expect(res.debug.errors).not.toContain("photo_unsure_density_claimed");
  expect(modelRequests).toHaveLength(2);
});

test("густоту по фото не видно, а модель её назвала — второй круг без неё", async () => {
  modelReplies = [
    [{ functionCall: { name: "estimate_price_from_photo", args: { service_id: SERVICE_ID } } }],
    [{ text: "У вас длинные и густые волосы — кератин будет 6000–6500 сом." }],
    [{ text: "У вас длинные волосы ниже лопаток — кератин будет 6000–6500 сом." }],
  ];
  const res = await runWaAgentV4(photoTurn("Сколько будет кератин?"));
  expect(res.debug.errors).toContain("photo_unsure_density_claimed");
  expect(lastUserText(modelRequests[2])).toContain("Густоту волос по этому фото точно не видно");
  expect(res.reply).not.toContain("густые");
});

test("варианты одной услуги — не «выдуманные услуги»: цены вариантов доходят до клиента", async () => {
  // Тест 25.09: guard выдуманных услуг принял «однотонное покрытие, пару акцентных» за услуги, которых
  // нет в прайсе, модель извинилась и назвала вилку прайса «от 800 до 1200».
  const variants =
    "Можем предложить однотонное покрытие или сложный дизайн: однотон — 900 сом, сложный дизайн — 1100 сом. Какой выберете?";
  modelReplies = [
    [{ functionCall: { name: "estimate_price_from_photo", args: { service_id: MANICURE_ID } } }],
    [{ text: variants }],
  ];
  const res = await runWaAgentV4(photoTurn("Сколько будет маникюр с дизайном?"));
  expect(res.debug.errors).not.toContain("invented_services_forcing_retry");
  expect(res.debug.errors).not.toContain("photo_price_mismatch");
  expect(modelRequests).toHaveLength(2);
  expect(res.reply).toContain("1100 сом");
});

test("на фото ничего не видно, а прайс не назван — просим назвать именно прайс", async () => {
  // Тест 25.09 (H9): заметка просила «назови 2500–7000» и тут же «без общей вилки прайса» —
  // модель выкинула цену совсем.
  vision = "irrelevant";
  modelReplies = [
    [{ functionCall: { name: "estimate_price_from_photo", args: { service_id: SERVICE_ID } } }],
    [{ text: "По этому фото не могу оценить. Пришлите, пожалуйста, фото волос." }],
    [{ text: "По этому фото не оценить: кератин у нас по прайсу 2500–7000 сом. Пришлите фото волос." }],
  ];
  const res = await runWaAgentV4(photoTurn("Сколько будет кератин?"));
  expect(res.debug.errors).toContain("photo_price_mismatch");
  const note = lastUserText(modelRequests[2]);
  expect(note).toContain("Назови общий диапазон по прайсу 2500–7000 сом — именно как прайс");
  expect(note).not.toContain("без общей вилки прайса");
  expect(res.reply).toContain("2500–7000 сом");
});

test("цена без расчёта в непривычной форме — всё равно второй круг с расчётом", async () => {
  // Живой прогон 25.09: «по фото будет стоить 800 сомов» — цену придумала модель, а регулярки
  // «вилки из прайса» её не узнали; клиентка получила бы неверную цену.
  modelReplies = [
    [{ text: "Маникюр с дизайном по фото будет стоить 800 сомов." }],
    [{ functionCall: { name: "estimate_price_from_photo", args: { service_id: MANICURE_ID } } }],
    [{ text: "Однотон — 900 сом, сложный дизайн — 1100 сом. Какой выберете?" }],
  ];
  const res = await runWaAgentV4(photoTurn("Хочу маникюр с дизайном, сколько будет?"));
  expect(res.debug.errors).toContain("photo_price_without_estimate");
  expect(res.reply).toContain("1100 сом");
});

test("спросили цену, а в ответе ни цены, ни расчёта — второй круг (K1, 25.09)", async () => {
  modelReplies = [
    [{ text: "Салам! Сүрөтүңүздү карап, болжолдуу баасын айтып бере алам." }],
    [{ functionCall: { name: "estimate_price_from_photo", args: { service_id: SERVICE_ID } } }],
    [{ text: "Кератин болжол менен 6000–6500 сом болот." }],
  ];
  const res = await runWaAgentV4(photoTurn("Кератин канча турат?"));
  expect(res.debug.errors).toContain("photo_price_without_estimate");
  expect(res.reply).toContain("6000–6500 сом");
});

test("фото со «спасибо» — не повод считать цену", async () => {
  modelReplies = [[{ text: "Пожалуйста! Ждём вас в салоне 🙂 Записать вас и на следующий раз?" }]];
  const res = await runWaAgentV4(photoTurn("Спасибо большое!"));
  expect(res.debug.errors).not.toContain("photo_price_without_estimate");
  expect(modelRequests).toHaveLength(1);
});

test("вместо цены по фото — вопрос о желаемом результате: сначала расчёт (P1, 25.09)", async () => {
  // «Какую именно причёску вы бы хотели? Может быть, у вас есть пример?» — ни цены, ни «пришлите»,
  // клиентка цену не спрашивала, и страховка молчала. ТЗ владельца: сначала цена по фото.
  modelReplies = [
    [{ text: "Вижу ваши ноготки. Какой дизайн вы бы хотели? Может быть, у вас есть пример?" }],
    [{ functionCall: { name: "estimate_price_from_photo", args: { service_id: MANICURE_ID } } }],
    [{ text: "Однотон — 900 сом, сложный дизайн — 1100 сом. Какой выберете или пришлёте пример?" }],
  ];
  const res = await runWaAgentV4(photoTurn("Хочу маникюр с дизайном, вот мои ногти"));
  expect(res.debug.errors).toContain("photo_price_without_estimate");
  expect(res.reply).toContain("1100 сом");
});
