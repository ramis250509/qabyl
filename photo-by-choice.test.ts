import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { executeV4Tool, photoTrace } from "./src/lib/wa-agent-v4.server";
import type { PhotoPricingConfig } from "./src/lib/photo-pricing";

// Инструмент оценки по фото целиком: база и распознавание подменены, цену считает настоящий код.
// Главный сценарий — у клиентки нет примера дизайна («просто однотон»). Раньше ассистент по кругу
// просил референс, а спросить словами ему запрещено, и цена так и не называлась.

const SERVICE_ID = "11111111-1111-4111-8111-111111111111";

const nails: PhotoPricingConfig = {
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
        { id: "complex", label: "Сложный дизайн", amount: 300 },
      ],
    },
  ],
};

const lashes: PhotoPricingConfig = {
  enabled: true,
  subject: "ресниц",
  criteria: [
    {
      id: "lash_effect",
      label: "Желаемый объём ресниц",
      mode: "base",
      shot: "reference",
      options: [
        { id: "classic", label: "Классика (1D)", amount: 1500 },
        { id: "2d", label: "2D", amount: 1800 },
      ],
    },
  ],
};

function makeDb(config: PhotoPricingConfig, range: { price: number; price_max: number }) {
  const row = {
    id: SERVICE_ID,
    name: "Услуга",
    price: range.price,
    price_max: range.price_max,
    price_type: "range",
    photo_pricing_config: config,
  };
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return {
    from: () => chain,
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
  } as any;
}

/**
 * Распознавание фото отвечает заданными признаками; возвращает счётчик вызовов. possible — какие
 * варианты фото не исключает; нет записи — признак определён уверенно.
 */
function visionSees(
  values: Record<string, string>,
  uncertain: string[] = [],
  possible: Record<string, string[]> = {},
) {
  const calls = { count: 0 };
  globalThis.fetch = (async () => {
    calls.count++;
    const text = JSON.stringify({
      relevant: true,
      values: Object.entries(values).map(([criterion_id, option_id]) => ({
        criterion_id,
        option_id,
        possible: possible[criterion_id] ?? [option_id],
      })),
      uncertain,
    });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
    });
  }) as typeof fetch;
  return calls;
}

const photo = {
  kind: "image",
  direction: "in",
  media_path: "salon/nails-now.jpg",
  media_signed_url: "data:image/jpeg;base64,AA==",
};
const inputWith = (lastMessages: unknown[]) =>
  ({
    salon: { salonId: "s1", salonName: "Тест", timezone: "Asia/Bishkek" },
    config: { manage_cutoff_hours: 0 },
    lastMessages,
  }) as any;
const newFlags = () => ({ photoShots: [], photoQuote: null }) as any;

const originalFetch = globalThis.fetch;
const originalKey = process.env.GEMINI_API_KEY;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "mock-only";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalKey;
});

describe("оценка по фото: пример желаемого результата можно заменить словами", () => {
  const db = makeDb(nails, { price: 800, price_max: 1200 });

  test("примера нет — ассистент получает цены вариантов, а не очередную просьбу о фото", async () => {
    visionSees({ nail_state: "gel" }, ["design"]);
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID },
      inputWith([photo]),
      db,
      newFlags(),
    );
    expect(result.success).toBe(false);
    expect(result.price_by_choice).toEqual([
      { choice: "design:plain", label: "Однотон", price_label: "900 сом" },
      { choice: "design:complex", label: "Сложный дизайн", price_label: "1200 сом" },
    ]);
    expect(result.ask).toContain("chosen");
  });

  test("клиентка выбрала словами — точная цена, и она же уйдёт в запись", async () => {
    visionSees({ nail_state: "gel" }, ["design"]);
    const flags = newFlags();
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID, chosen: ["design:plain"] },
      inputWith([photo]),
      db,
      flags,
    );
    expect(result).toMatchObject({ success: true, price_label: "900 сом" });
    expect(flags.photoQuote).toMatchObject({ serviceId: SERVICE_ID, price: 900 });
  });

  test("то, что у клиентки сейчас, словами не заменить: без фото цены нет", async () => {
    const calls = visionSees({});
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID, chosen: ["design:plain"] },
      inputWith([]),
      db,
      newFlags(),
    );
    expect(result.error).toContain("Фото от клиента пока нет");
    expect(calls.count).toBe(0);
  });
});

describe("ресницы по желаемому объёму", () => {
  test("фото нет, клиентка сказала «2D» — цена без распознавания", async () => {
    const calls = visionSees({});
    const flags = newFlags();
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID, chosen: ["lash_effect:2d"] },
      inputWith([]),
      makeDb(lashes, { price: 1500, price_max: 2500 }),
      flags,
    );
    expect(result).toMatchObject({ success: true, price_label: "1800 сом" });
    expect(flags.photoQuote).toMatchObject({ price: 1800 });
    expect(calls.count).toBe(0);
  });

  test("прислала пример, объём не разобрать — варианты с ценами, а не «переснимите»", async () => {
    visionSees({}, ["lash_effect"]);
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID },
      inputWith([{ ...photo, media_path: "salon/lashes-wish.jpg" }]),
      makeDb(lashes, { price: 1500, price_max: 2500 }),
      newFlags(),
    );
    expect(result.price_by_choice).toEqual([
      { choice: "lash_effect:classic", label: "Классика (1D)", price_label: "1500 сом" },
      { choice: "lash_effect:2d", label: "2D", price_label: "1800 сом" },
    ]);
  });
});

describe("густоту не разобрать — вилка, а не голое «переснимите»", () => {
  // Настройки кератина Avrora на 23.09.2026: длина — цена, густота — доплата.
  const keratin: PhotoPricingConfig = {
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
          { id: "very_thick", label: "Очень густая", amount: 1000 },
        ],
      },
    ],
  };

  test("длина видна, густота нет — ориентировочно «6000–7000» и фото по желанию", async () => {
    visionSees({ length: "very_long" }, ["density"]);
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID },
      inputWith([{ ...photo, media_path: "salon/hair-back.jpg" }]),
      makeDb(keratin, { price: 2500, price_max: 7000 }),
      newFlags(),
    );
    expect(result).toMatchObject({
      success: true,
      estimate: "range",
      price_label: "6000–7000 сом",
      not_sure: ["Густота"],
    });
    expect(result.ask).toContain("предварительная оценка");
    expect(result.ask).toContain("по желанию");
    expect(photoTrace(result)).toBe("photo:range:6000–7000сом:length=very_long");
  });

  test("кадр обрезан — вилка по длинам, которые фото не исключает", async () => {
    visionSees({ length: "short", density: "normal" }, [], { length: ["short", "very_long"] });
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID },
      inputWith([{ ...photo, media_path: "salon/cropped.jpg" }]),
      makeDb(keratin, { price: 2500, price_max: 7000 }),
      newFlags(),
    );
    expect(result).toMatchObject({ estimate: "range", price_label: "2500–6000 сом" });
    expect(photoTrace(result)).toBe(
      "photo:range:2500–6000сом:length=short,density=normal:may=length=short/very_long",
    );
  });

  test("не видно ничего, но фото про волосы — всё равно вилка, не отказ", async () => {
    visionSees({}, ["length", "density"]);
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID },
      inputWith([{ ...photo, media_path: "salon/dark.jpg" }]),
      makeDb(keratin, { price: 2500, price_max: 7000 }),
      newFlags(),
    );
    expect(result).toMatchObject({ success: true, price_label: "2500–7000 сом" });
  });

  test("клиентка уже переснимала — третий раз фото не просим", async () => {
    visionSees({ length: "very_long" }, ["density"]);
    const result = await executeV4Tool(
      "estimate_price_from_photo",
      { service_id: SERVICE_ID },
      inputWith([{ ...photo, media_path: "salon/second.jpg" }]),
      makeDb(keratin, { price: 2500, price_max: 7000 }),
      {
        ...newFlags(),
        photoShots: [
          { path: "salon/first.jpg", at: Date.now() },
          { path: "salon/second.jpg", at: Date.now() },
        ],
      },
    );
    expect(result.ask).toContain("Переснять больше не предлагай");
  });
});
