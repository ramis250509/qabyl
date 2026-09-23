import { describe, expect, test } from "bun:test";
import {
  asksVisibleAttribute,
  photoAskFallback,
  photoServicesInTopic,
} from "./src/lib/wa-agent-v4.server";
import { loadServicesForSalon } from "./src/lib/wa-agent.server";
import {
  calculatePhotoPrice,
  photoRequestLine,
  photoShotsNeeded,
  type PhotoPricingConfig,
} from "./src/lib/photo-pricing";

// Цена зависит от того, что на клиенте видно. Значит спрашивать это словами нельзя — ни разу,
// ни «одним компактным сообщением». Эти тесты держат границу между «объяснил, от чего зависит
// цена» (можно) и «устроил анкету» (нельзя).

const hair: PhotoPricingConfig = {
  enabled: true,
  subject: "волос",
  criteria: [
    {
      id: "length",
      label: "Длина",
      mode: "base",
      options: [
        { id: "short", label: "До плеч", amount: 3000 },
        { id: "long", label: "Ниже лопаток", amount: 5000 },
      ],
    },
  ],
};
const nails: PhotoPricingConfig = {
  enabled: true,
  subject: "ногтей",
  criteria: [
    ...hair.criteria.map((c) => ({ ...c, id: "state", label: "Покрытие" })),
    {
      id: "design",
      label: "Дизайн",
      mode: "surcharge" as const,
      shot: "reference" as const,
      options: [
        { id: "plain", label: "Однотон", amount: 0 },
        { id: "complex", label: "Сложный", amount: 1000 },
      ],
    },
  ],
};

describe("какие фото просить", () => {
  test("одно фото по умолчанию, референс — когда с него читается цена", () => {
    expect(photoShotsNeeded(hair)).toEqual(["current"]);
    expect(photoShotsNeeded(nails)).toEqual(["current", "reference"]);
    // Владелец может попросить референс и без критерия, который с него читается.
    expect(photoShotsNeeded({ ...hair, needs_reference: true })).toEqual(["current", "reference"]);
    expect(photoShotsNeeded(null)).toEqual([]);
  });

  test("просьба — одна короткая фраза, без списка требований к съёмке", () => {
    const one = photoRequestLine(hair);
    expect(one).toContain("фото волос");
    expect(one.length).toBeLessThan(120);
    expect(one).not.toContain("\n");
    expect(photoRequestLine(nails)).toContain("что хотите сделать");
    // Своя формулировка владельца перебивает собранную.
    expect(photoRequestLine({ ...hair, ask: "Скиньте фото 🙂" })).toBe("Скиньте фото 🙂");
  });

  test("не хватило референса — это не «переснимите фото волос»", () => {
    const priced = calculatePhotoPrice(
      nails,
      { relevant: true, values: { state: "short" } },
      { price: 3000, price_max: 6000 },
    );
    expect(priced).toHaveProperty("needShots", ["reference"]);
  });
});

describe("каталог услуг переживает неприменённую миграцию", () => {
  // Воркер уезжает на Cloudflare сам, миграции применяются руками. В окне между ними запрос с
  // photo_pricing_config отвечает 42703 — и если не подстраховаться, ассистент теряет НЕ оценку
  // по фото, а весь прайс: «не вижу услуг» на каждое сообщение.
  const fakeDb = (missingColumn: boolean) => {
    const rows = [{ id: "s1", name: "Кератин", price: 3000, price_max: 6000 }];
    return {
      from: () => ({
        select: (columns: string) => {
          const fails = missingColumn && columns.includes("photo_pricing_config");
          const result = fails
            ? { data: null, error: { code: "42703", message: "column does not exist" } }
            : { data: rows, error: null };
          const chain = {
            eq: () => chain,
            order: () => Promise.resolve(result),
          } as any;
          return chain;
        },
      }),
    } as any;
  };

  test("колонки нет — услуги всё равно загружаются", async () => {
    expect(await loadServicesForSalon(fakeDb(true), "salon")).toHaveLength(1);
    expect(await loadServicesForSalon(fakeDb(false), "salon")).toHaveLength(1);
  });
});

describe("guard: анкета вместо фото", () => {
  test("ловит вопросы о том, что видно на снимке", () => {
    for (const reply of [
      "Какая у вас длина волос?",
      "Подскажите, какой длины ваши волосы",
      "Вы раньше осветляли волосы?",
      "Осветляли ли вы волосы ранее?",
      "Напишите примерную длину и густоту",
      "Что сейчас на ногтях?",
      "Ногти свои или наращённые?",
      "Сложный ли дизайн вы хотите?",
      "Какой объём ресниц вам нужен?",
    ])
      expect(asksVisibleAttribute(reply)).toBe(true);
  });

  test("не трогает объяснение цены, просьбу о фото и обычную запись", () => {
    for (const reply of [
      "Стоимость зависит от длины и густоты волос — пришлите, пожалуйста, фото.",
      "Да, конечно :)\n\nПришлите фото волос, я сразу сориентирую по цене.",
      "Кератин у нас от 3000 до 6000 сом.",
      "На какой день вам удобно записаться?",
      "Записываю вас на завтра в 15:00. Всё верно?",
      "Дизайн делаем любой сложности, покажите пример — подберём.",
    ])
      expect(asksVisibleAttribute(reply)).toBe(false);
  });
});

describe("guard не путает зоны", () => {
  const hairOnly = [{ subject: "hair", line: photoRequestLine(hair) }];
  const hairAndNails = [...hairOnly, { subject: "nails", line: photoRequestLine(nails) }];

  test("по фото настроены только волосы — вопрос про ногти законен", () => {
    expect(photoServicesInTopic(hairOnly, "Что сейчас на ногтях? сколько стоит маникюр")).toEqual(
      [],
    );
    expect(photoServicesInTopic(hairOnly, "Какая у вас длина волос?")).toEqual(hairOnly);
    // Зону не понять — страхуемся, как раньше.
    expect(photoServicesInTopic(hairOnly, "Подскажите, какая длина?")).toEqual(hairOnly);
  });

  test("запасная просьба — про ту зону, о которой речь", () => {
    const nailsTopic = photoServicesInTopic(hairAndNails, "Что сейчас на ногтях?");
    expect(photoAskFallback(nailsTopic, "ru")).toContain("фото ногтей");
    // Зона неясна, а фразы у услуг разные — «фото волос» для маникюра хуже общей просьбы.
    const fallback = photoAskFallback(hairAndNails, "ru");
    expect(fallback).not.toContain("волос");
    expect(fallback).not.toContain("ногтей");
    expect(fallback).toContain("Пришлите, пожалуйста, фото");
  });
});
