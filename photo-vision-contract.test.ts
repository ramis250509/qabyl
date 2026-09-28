import { expect, test } from "bun:test";
import { classifyPhotoForPrice } from "./src/lib/wa-agent.server";
import { calculatePhotoPrice, type PhotoPricingConfig } from "./src/lib/photo-pricing";

const config: PhotoPricingConfig = {
  enabled: true,
  criteria: [
    {
      id: "length",
      label: "Длина",
      mode: "base",
      options: [
        { id: "short", label: "Короткие", amount: 3000 },
        { id: "long", label: "Длинные", amount: 5000 },
      ],
    },
  ],
};

test("vision contract: model returns attributes, not a price", async () => {
  const original = globalThis.fetch;
  let request: {
    generationConfig: { responseSchema: { properties: { values: { type: string } } } };
    systemInstruction: unknown;
  } | null = null;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    relevant: true,
                    values: [{ criterion_id: "length", option_id: "long" }],
                    uncertain: [],
                    invented_price: 999,
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const result = await classifyPhotoForPrice({
      apiKey: "mock-only",
      imageBase64: "AA==",
      mime: "image/jpeg",
      serviceName: "Кератин",
      config,
    });
    expect(request?.generationConfig.responseSchema.properties.values.type).toBe("array");
    expect(JSON.stringify(request?.systemInstruction)).toContain("Не определяй и не называй цену");
    // Плохое фото — не повод отказываться: модель обязана дать лучший вариант и всё, что фото не
    // исключает. Старое «не угадывай» отправляло каждый такой признак в uncertain.
    expect(JSON.stringify(request?.systemInstruction)).toContain(
      "Всё равно оцени по тому, что видно",
    );
    expect(JSON.stringify(request?.systemInstruction)).not.toContain("Не угадывай");
    expect(result).toEqual({
      relevant: true,
      values: { length: "long" },
      possible: {},
      uncertain: [],
    });
    if ("error" in result) throw new Error(result.error);
    expect(calculatePhotoPrice(config, result, { price: 3000, price_max: 6000 })).toHaveProperty(
      "price",
      5000,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("два снимка: признак примера нельзя молча выбросить, роль одного фото не спрашиваем", async () => {
  // Тест 24.09: «вот мои ногти» → «хочу такой дизайн» с новым фото. Модель заполняла photo_role
  // «current» и возвращала только покрытие — сложность дизайна пропадала целиком, и на втором
  // ходе клиентка снова получала варианты вместо цены. Та же беда с причёской.
  const both: PhotoPricingConfig = {
    enabled: true,
    criteria: [
      { ...config.criteria[0], id: "nail_state", shot: "current" },
      { ...config.criteria[0], id: "design", mode: "surcharge", shot: "reference" },
    ],
  };
  const original = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const text = JSON.stringify({ relevant: true, values: [], uncertain: [] });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const image = { base64: "AA==", mime: "image/jpeg" };
    await classifyPhotoForPrice({
      apiKey: "mock-only",
      images: [image, { ...image, fresh: true }],
      serviceName: "Маникюр с дизайном",
      config: both,
      clientText: "хочу такой дизайн",
    });
    await classifyPhotoForPrice({
      apiKey: "mock-only",
      images: [{ ...image, fresh: true }],
      serviceName: "Маникюр с дизайном",
      config: both,
      clientText: "вот мои ногти",
    });
    const [pair, single] = requests;
    expect(JSON.stringify(pair.systemInstruction)).toContain("молча пропускать признак нельзя");
    expect(pair.generationConfig.responseSchema.properties).not.toHaveProperty("photo_role");
    expect(JSON.stringify(pair.contents)).toContain("Фото 1 — прислано раньше");
    expect(JSON.stringify(pair.contents)).toContain("Снимков: 2");
    // Для одного снимка инструкция прежняя: общая фраза сужала possible у густоты (H1 24.09).
    expect(JSON.stringify(single.systemInstruction)).not.toContain("молча пропускать");
    expect(single.generationConfig.responseSchema.properties).toHaveProperty("photo_role");
  } finally {
    globalThis.fetch = original;
  }
});
