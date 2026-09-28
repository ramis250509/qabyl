import { describe, expect, test } from "bun:test";
import {
  applyClientChoice,
  calculatePhotoPrice,
  guessPhotoSubject,
  photoBookingPrice,
  photoPresetsFor,
  photoEstimate,
  forgetShot,
  seenLabels,
  photoPriceTable,
  photoRequestLine,
  photoRuleRangeError,
  photoShotsNeeded,
  photoSubjectOf,
  photoSubjectsMentioned,
  photoZoneOf,
  validatePhotoConfig,
  type PhotoPricingConfig,
} from "./src/lib/photo-pricing";

const config: PhotoPricingConfig = {
  enabled: true,
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
    {
      id: "density",
      label: "Густота",
      mode: "surcharge",
      options: [
        { id: "normal", label: "Обычная", amount: 0 },
        { id: "thick", label: "Густая", amount: 1000 },
      ],
    },
  ],
};
const service = { price: 3000, price_max: 6000 };

describe("photo pricing: vision never authors the price", () => {
  test("base + surcharge are computed from salon rules", () => {
    expect(
      calculatePhotoPrice(
        config,
        { relevant: true, values: { length: "long", density: "thick" } },
        service,
      ),
    ).toEqual({ price: 6000, selected: { length: "long", density: "thick" } });
  });
  test("missing, uncertain and hallucinated option IDs never yield a quote", () => {
    for (const values of [{ length: "long" }, { length: "long", density: "invented" }]) {
      expect(calculatePhotoPrice(config, { relevant: true, values }, service)).toHaveProperty(
        "needs",
        ["Густота"],
      );
    }
    expect(
      calculatePhotoPrice(
        config,
        { relevant: true, values: { length: "long", density: "thick" }, uncertain: ["length"] },
        service,
      ),
    ).toHaveProperty("needs", ["Длина"]);
  });
  test("unrelated photo requests a replacement", () => {
    expect(calculatePhotoPrice(config, { relevant: false, values: {} }, service)).toHaveProperty(
      "needs",
    );
  });
  test("no config, disabled config and malformed config cannot price", () => {
    const image = { relevant: true, values: { length: "short", density: "normal" } };
    expect(calculatePhotoPrice(null, image, service)).toEqual({
      error: "photo_rules_not_configured",
    });
    expect(calculatePhotoPrice({ ...config, enabled: false }, image, service)).toHaveProperty(
      "error",
    );
    expect(
      validatePhotoConfig({ ...config, criteria: [config.criteria[0], config.criteria[0]] }),
    ).toBeNull();
  });
  test("a rule outside the catalog range is rejected rather than silently clamped", () => {
    expect(
      calculatePhotoPrice(
        config,
        { relevant: true, values: { length: "long", density: "thick" } },
        { price: 3000, price_max: 5500 },
      ),
    ).toEqual({ error: "photo_price_outside_service_range" });
  });
  test("a single surcharge criterion uses catalog minimum", () => {
    expect(
      calculatePhotoPrice(
        { enabled: true, criteria: [config.criteria[1]] },
        { relevant: true, values: { density: "thick" } },
        { price: 3000, price_max: 5000 },
      ),
    ).toHaveProperty("price", 4000);
  });
  test("editor rejects any combination outside the catalog before saving/copying", () => {
    expect(photoRuleRangeError(config, service)).toBeNull();
    expect(photoRuleRangeError(config, { price: 3000, price_max: 5500 })).toContain(
      "выходят за прайс",
    );
  });
  test("booking reuses a recent quoted price, rejects mismatches, ignores other/expired services", () => {
    const quote = { serviceId: "keratin", price: 5500, at: 1000 };
    expect(photoBookingPrice(quote, "keratin", null, 2000)).toEqual({ price: 5500 });
    expect(photoBookingPrice(quote, "keratin", 4000, 2000)).toEqual({
      error: "photo_quote_price_mismatch",
    });
    expect(photoBookingPrice(quote, "manicure", null, 2000)).toEqual({ price: null });
    expect(photoBookingPrice(quote, "keratin", null, 3_602_000)).toEqual({ price: null });
  });
});

describe("порядок критериев не меняет цену", () => {
  // Владелец добавил в кабинете «Густоту» раньше «Длины». Раньше «Длина» затирала уже прибавленную
  // доплату, и густые длинные волосы стоили как обычные — 5000 вместо 6000.
  test("доплата сохраняется, даже если стоит раньше «Цены»", () => {
    const reversed = { ...config, criteria: [config.criteria[1], config.criteria[0]] };
    expect(
      calculatePhotoPrice(
        reversed,
        { relevant: true, values: { length: "long", density: "thick" } },
        service,
      ),
    ).toHaveProperty("price", 6000);
  });
});

// Маникюр: покрытие видно на фото «сейчас», дизайн — только на примере желаемого результата.
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
        { id: "accent", label: "Пара акцентных", amount: 100 },
        { id: "complex", label: "Сложный дизайн", amount: 300 },
      ],
    },
  ],
};
const manicure = { price: 800, price_max: 1200 };

describe("любое фото оценивается: точная цена или честная вилка", () => {
  test("всё видно — точная цена", () => {
    expect(
      photoEstimate(
        config,
        { relevant: true, values: { length: "long", density: "thick" } },
        service,
      ),
    ).toEqual({ kind: "exact", price: 6000, selected: { length: "long", density: "thick" } });
  });

  test("кадр обрезан — вилка по вариантам, которые фото не исключает", () => {
    expect(
      photoEstimate(
        config,
        {
          relevant: true,
          values: { length: "short", density: "normal" },
          possible: { length: ["short", "long"], density: ["normal"] },
        },
        service,
      ),
    ).toEqual({
      kind: "range",
      min: 3000,
      max: 5000,
      likely: 3000,
      selected: { length: "short", density: "normal" },
      unsure: ["Длина"],
    });
  });

  test("густоту не разобрать совсем — вилка по всем её вариантам, длина как видна", () => {
    expect(
      photoEstimate(
        config,
        { relevant: true, values: { length: "long" }, uncertain: ["density"] },
        service,
      ),
    ).toMatchObject({ kind: "range", min: 5000, max: 6000, unsure: ["Густота"] });
  });

  test("не видно ничего, но фото про услугу — вилка по правилам салона, без выдумок", () => {
    expect(photoEstimate(config, { relevant: true, values: {} }, service)).toMatchObject({
      kind: "range",
      min: 3000,
      max: 6000,
      unsure: ["Длина", "Густота"],
    });
  });

  test("выдуманный вариант в possible вилку не расширяет", () => {
    expect(
      photoEstimate(
        config,
        {
          relevant: true,
          values: { length: "long", density: "normal" },
          possible: { length: ["long", "waist"] },
        },
        service,
      ),
    ).toMatchObject({ kind: "exact", price: 5000 });
  });

  test("фото не про услугу — единственный случай, когда цены нет", () => {
    expect(photoEstimate(config, { relevant: false, values: {} }, service)).toMatchObject({
      kind: "needs",
      reason: "irrelevant",
    });
  });
});

describe("желаемый результат можно назвать словами", () => {
  test("слова клиента закрывают только критерий с референса", () => {
    const seen = { relevant: true, values: { nail_state: "gel" }, uncertain: ["design"] };
    const withChoice = applyClientChoice(nails, seen, ["design:plain"]);
    expect(calculatePhotoPrice(nails, withChoice, manicure)).toEqual({
      price: 900,
      selected: { nail_state: "gel", design: "plain" },
    });
  });

  test("то, что видно сейчас, словами не подменить", () => {
    const seen = { relevant: true, values: { nail_state: "gel", design: "plain" } };
    // «У меня без покрытия» — попытка сбить цену; фото сказало «гель-лак».
    expect(applyClientChoice(nails, seen, ["nail_state:bare"])).toBe(seen);
    // Выдуманный вариант и мусор отбрасываются молча.
    expect(applyClientChoice(nails, seen, ["design:neon", 42, "nope"])).toBe(seen);
  });

  test("нет примера — цена каждого варианта дизайна", () => {
    const seen = { relevant: true, values: { nail_state: "gel" }, uncertain: ["design"] };
    expect(photoEstimate(nails, seen, manicure)).toEqual({
      kind: "choice",
      criterion: "Сложность дизайна",
      options: [
        { choice: "design:plain", label: "Однотон", min: 900, max: 900 },
        { choice: "design:accent", label: "Пара акцентных", min: 1000, max: 1000 },
        { choice: "design:complex", label: "Сложный дизайн", min: 1200, max: 1200 },
      ],
      unsure: [],
    });
  });

  test("нет примера и покрытие видно не до конца — варианты вилками", () => {
    const seen = {
      relevant: true,
      values: { nail_state: "gel" },
      possible: { nail_state: ["bare", "gel"] },
      uncertain: ["design"],
    };
    expect(photoEstimate(nails, seen, manicure)).toMatchObject({
      kind: "choice",
      options: [
        { label: "Однотон", min: 800, max: 900 },
        { label: "Пара акцентных", min: 900, max: 1000 },
        { label: "Сложный дизайн", min: 1100, max: 1200 },
      ],
      unsure: ["Что сейчас на ногтях"],
    });
  });

  test("одно фото на два снимка: признаки второго снимка забываются", () => {
    const seen = { relevant: true, values: { nail_state: "gel", design: "plain" } };
    expect(forgetShot(nails, seen, "reference")).toEqual({
      relevant: true,
      values: { nail_state: "gel" },
      possible: {},
      uncertain: ["design"],
    });
    expect(photoEstimate(nails, forgetShot(nails, seen, "reference"), manicure)).toMatchObject({
      kind: "choice",
    });
  });

  test("распознанное называется словами владельца", () => {
    expect(seenLabels(nails, { nail_state: "gel", design: "invented" })).toEqual({
      "Что сейчас на ногтях": "Старый гель-лак",
    });
  });

  test("выбрала словами после вариантов — точная цена", () => {
    const seen = { relevant: true, values: { nail_state: "gel" }, uncertain: ["design"] };
    expect(
      photoEstimate(nails, applyClientChoice(nails, seen, ["design:plain"]), manicure),
    ).toMatchObject({ kind: "exact", price: 900 });
  });
});

describe("какие цены видит владелец в кабинете", () => {
  test("«Цена» по строкам, доплата по столбцам", () => {
    expect(photoPriceTable(config, service)).toEqual({
      rowTitle: "Длина",
      rows: ["До плеч", "Ниже лопаток"],
      colTitle: "Густота",
      cols: ["Обычная", "Густая"],
      prices: [
        [3000, 4000],
        [5000, 6000],
      ],
      extras: [],
    });
  });

  test("без «Цены» доплаты считаются от нижней цены прайса", () => {
    const onlySurcharges = {
      enabled: true,
      criteria: [nails.criteria[1], config.criteria[1]],
    };
    const table = photoPriceTable(onlySurcharges, manicure);
    expect(table?.prices[0]).toEqual([800, 1800]);
    expect(table?.prices[2]).toEqual([1100, 2100]);
  });

  test("третий критерий — строкой «плюс доплата», а не третьим измерением", () => {
    const three = {
      ...config,
      criteria: [...config.criteria, { ...nails.criteria[1], id: "extra" }],
    };
    expect(photoPriceTable(three, service)?.extras).toEqual([
      { label: "Сложность дизайна", min: 0, max: 300 },
    ]);
  });
});

describe("критерии по зонам", () => {
  test("у ресниц и ногтей нет длины и густоты волос", () => {
    const lashes = photoPresetsFor("lashes").map((p) => p.id);
    const nailPresets = photoPresetsFor("nails").map((p) => p.id);
    expect(lashes).toEqual(["lash_effect", "lash_state"]);
    expect(nailPresets).toEqual(["nail_state", "nail_length", "design"]);
    for (const hair of ["length", "density", "bleached"]) {
      expect(lashes).not.toContain(hair);
      expect(nailPresets).not.toContain(hair);
    }
    expect(photoPresetsFor(null).length).toBeGreaterThan(lashes.length);
    expect(photoPresetsFor("brows")).toEqual([]);
  });

  test("зона черновика в кабинете: выбранная, по критериям, по названию услуги", () => {
    // Выбрали «Ресницы», критериев ещё нет — уже предлагаем ресничные.
    expect(photoZoneOf({ subject: "ресниц", criteria: [] })).toBe("lashes");
    // Правила, сохранённые до выбора зоны: по «Длине волос» ясно, что это волосы, — критерии
    // ногтей и ресниц кератину не предлагаем.
    expect(photoZoneOf({ criteria: config.criteria })).toBe("hair");
    expect(photoZoneOf({ criteria: [] }, { name: "Наращивание ногтей (гель)" })).toBe("nails");
    expect(photoZoneOf({ criteria: [] }, { name: "Вечерний макияж" })).toBeNull();
  });

  test("зона угадывается по названию услуги, как в реальных прайсах", () => {
    expect(guessPhotoSubject({ name: "Маникюр с дизайном", category: "Ногти" })).toBe("ногтей");
    expect(guessPhotoSubject({ name: "Наращивание ресниц к топ-мастерам", category: null })).toBe(
      "ресниц",
    );
    expect(guessPhotoSubject({ name: "Кератиновое выпрямление", category: "Волосы" })).toBe(
      "волос",
    );
    expect(guessPhotoSubject({ name: "Окрашивание бровей" })).toBe("бровей");
    expect(guessPhotoSubject({ name: "Кератиновое ламинирование ресниц" })).toBe("ресниц");
    // Категория «Макияж и причёски» не делает макияж «волосами».
    expect(
      guessPhotoSubject({ name: "Вечерний / свадебный макияж", category: "Макияж и причёски" }),
    ).toBeUndefined();
    expect(guessPhotoSubject({ name: "Шугаринг", category: "Эпиляция" })).toBeUndefined();
  });

  test("зона настроенной услуги: своя, по критериям, по названию", () => {
    // Так выглядят правила, сохранённые до появления выбора зоны.
    expect(photoSubjectOf(config)).toBe("hair");
    expect(photoSubjectOf(nails)).toBe("nails");
    const custom = { enabled: true, criteria: [{ ...config.criteria[1], id: "custom_1" }] };
    expect(photoSubjectOf(custom, { name: "Наращивание ресниц" })).toBe("lashes");
    expect(photoSubjectOf(custom, { name: "Массаж спины" })).toBeNull();
  });

  test("о какой зоне вопрос", () => {
    expect(photoSubjectsMentioned("Что сейчас на ногтях?")).toEqual(["nails"]);
    expect(photoSubjectsMentioned("Какая у вас длина волос?")).toEqual(["hair"]);
    expect(photoSubjectsMentioned("Какой объём ресниц хотите?")).toEqual(["lashes"]);
    expect(photoSubjectsMentioned("Подскажите, какая длина?")).toEqual([]);
  });
});

describe("фото «как сейчас» не просим, если цена от него не зависит", () => {
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
  test("для объёма ресниц нужен только пример", () => {
    expect(photoShotsNeeded(lashes)).toEqual(["reference"]);
    expect(photoRequestLine(lashes)).toContain("пример того, что хотите сделать");
    expect(photoRequestLine(lashes)).not.toContain("сейчас");
    // Добавили «Что сейчас на ресницах» — теперь нужны оба снимка.
    const withState: PhotoPricingConfig = {
      ...lashes,
      criteria: [
        ...lashes.criteria,
        {
          id: "lash_state",
          label: "Что сейчас на ресницах",
          mode: "surcharge",
          shot: "current",
          options: [
            { id: "natural", label: "Свои ресницы", amount: 0 },
            { id: "extended", label: "Старое наращивание (снятие)", amount: 300 },
          ],
        },
      ],
    };
    expect(photoShotsNeeded(withState)).toEqual(["current", "reference"]);
  });
});
