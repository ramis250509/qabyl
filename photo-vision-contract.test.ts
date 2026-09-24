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
