import { describe, expect, test } from "bun:test";
import {
  asksVisibleAttribute,
  dodgesPhotoPrice,
  photoAskFallback,
  photoServicesInTopic,
  stripRetryAck,
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

describe("guard: фото есть, а цену по нему не посчитали", () => {
  // Дословно ответы из теста Avrora 23.09: фото уже пришло, инструмент оценки не вызывался.
  test("ловит вилку из прайса, «на месте» и просьбу ещё одного снимка", () => {
    for (const reply of [
      "Женская стрижка стоит от 500 до 1000 сом, длительность 40 минут. Точную стоимость мастер сможет назвать на месте.",
      "Такой вечерний макияж будет стоить от 1500 до 2500 сом.",
      "Маникюр с дизайном стоит 800–1200 сом.",
      "Спасибо за фото! Теперь пришлите, пожалуйста, фото желаемого дизайна.",
      "Фото жиберип коёсузбу? Баасын так айтып берем 🙂",
    ])
      expect(dodgesPhotoPrice(reply)).toBe(true);
  });

  test("не трогает посчитанную цену, варианты и обычную запись", () => {
    for (const reply of [
      "Стоимость женской стрижки в вашем случае составит 500 сом.",
      "Однотон — 900 сом, пара акцентных — 1000 сом, сложный дизайн — 1100 сом.",
      "Записала вас на завтра в 15:00. Всё верно?",
      "Я вижу, что на фото лицо, а не волосы.",
    ])
      expect(dodgesPhotoPrice(reply)).toBe(false);
  });
});

describe("переписанный по guard'у ответ без отписок", () => {
  // Дословно из теста 24.09: служебную заметку клиентка не видит, а извинение получала.
  test("убирает «Хорошо, поняла!» и «Приношу извинения за неточность»", () => {
    expect(stripRetryAck("Хорошо, поняла!\n\nПо фото видно, что у Вас сейчас гель-лак.")).toBe(
      "По фото видно, что у Вас сейчас гель-лак.",
    );
    expect(
      stripRetryAck("Приношу извинения за неточность.\n\nМаникюр с дизайном стоит от 800 до 1200 сом."),
    ).toBe("Маникюр с дизайном стоит от 800 до 1200 сом.");
    expect(stripRetryAck("Поняла! Однотон — 900 сом.")).toBe("Однотон — 900 сом.");
  });

  test("не трогает фразы, где «хорошо» и «извините» — часть смысла", () => {
    for (const reply of [
      "Хорошо, записала вас на завтра в 15:00.",
      "Понятно, тогда подберу время.",
      "Извините, на это время уже занято.",
    ])
      expect(stripRetryAck(reply)).toBe(reply);
  });
});

describe("кыргызский: guard'ы понимают язык клиентки", () => {
  // Тест 24.09, сценарий K3: фото + «Кератин канча?» — модель не вызвала расчёт и дважды назвала
  // выдуманную вилку «4500–7000» (у салона такой нет). Русский guard её не узнал.
  test("ловит вилку без расчёта и «мастер жеринде»", () => {
    for (const reply of [
      "Ошондуктан, кератин 4500 сомдон 7000 сомго чейин болот. Так баасын мастер жеринде карап айтып берет.",
      "Кератин 2500дөн 7000 сомго чейин болот.",
      "Так баасын мастер жеринде айтат.",
    ])
      expect(dodgesPhotoPrice(reply)).toBe(true);
  });

  test("не трогает точную цену и рабочие часы", () => {
    for (const reply of [
      "Кератин 6500 сом болот. Кайсы күнгө жазылгыңыз келет?",
      "Биз 10дон 18ге чейин иштейбиз.",
    ])
      expect(dodgesPhotoPrice(reply)).toBe(false);
  });

  test("ловит анкету на кыргызском", () => {
    for (const reply of [
      "Чачыңыздын узундугу кандай?",
      "Мурун чачыңызды агарткансызбы?",
      "Тырмагыңызда азыр эмне бар?",
    ])
      expect(asksVisibleAttribute(reply)).toBe(true);
    // Объяснить, от чего зависит цена, — можно.
    expect(asksVisibleAttribute("Баасы чачтын узундугуна жараша болот.")).toBe(false);
  });

  test("зону узнаёт по кыргызским словам", () => {
    const hairAndNails = [
      { subject: "hair", line: photoRequestLine(hair) },
      { subject: "nails", line: photoRequestLine(nails) },
    ];
    expect(photoServicesInTopic(hairAndNails, "тырмагыма дизайн канча турат?")).toEqual([
      hairAndNails[1],
    ]);
    expect(photoServicesInTopic(hairAndNails, "чачыма кератин канча?")).toEqual([hairAndNails[0]]);
  });
});
