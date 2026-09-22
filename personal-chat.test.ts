// Личные чаты: тег «#личный» с телефона и молчание до признаков клиента.
//
// Запуск: bun test personal-chat

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  hasPersonalTag,
  isEngagedChat,
  looksLikeClientMessage,
  looksLikeSpam,
  shouldHoldForOwner,
} from "./src/lib/personal-chat";
import { addExcludedContact } from "./src/lib/excluded-contacts.server";

describe("тег #личный", () => {
  test.each(["#личный", "  #Личный ", "это #личное", "#лично", "#жеке", "#ЛИЧНАЯ переписка"])(
    "%p — тег",
    (text) => expect(hasPersonalTag(text)).toBe(true),
  );

  test.each(["личный", "мой личный номер", "", null, "a#личный", "#личинка"])(
    "%p — не тег",
    (text) => expect(hasPersonalTag(text as any)).toBe(false),
  );
});

describe("похоже на клиента — ассистент отвечает", () => {
  test.each([
    "Здравствуйте",
    "Добрый день! Можно на завтра?",
    "Салам",
    "Сколько стоит наращивание?",
    "Сиздерде бош убакыт барбы",
    "Эртең жазылсам болобу",
    "Извините, опоздаю на 10 минут",
    "А у вас есть окошко в субботу",
    "хочу сделать ногти",
    "Алина, завтра 18:00, да",
  ])("%p", (text) => {
    expect(looksLikeClientMessage({ text, hasImage: false })).toBe(true);
  });

  test("фото без текста — клиент", () => {
    expect(looksLikeClientMessage({ text: null, hasImage: true })).toBe(true);
  });
});

describe("похоже на личное — ассистент молчит", () => {
  test.each([
    "Апа, кечинде келесиңби?",
    "Мама, ты где?",
    "Балам, тамак жедиңби",
    "скинь фотку со вчера",
    "купи 2 хлеба",
  ])("%p", (text) => {
    expect(looksLikeClientMessage({ text, hasImage: false })).toBe(false);
    expect(shouldHoldForOwner({ chatAlreadyEngaged: false, text, hasImage: false })).toBe(true);
  });

  test("пустое сообщение не решает за клиента", () => {
    expect(looksLikeClientMessage({ text: "   ", hasImage: false })).toBe(false);
  });

  test("посреди клиентского разговора не молчим", () => {
    expect(
      shouldHoldForOwner({ chatAlreadyEngaged: true, text: "Мама, ты где?", hasImage: false }),
    ).toBe(false);
  });
});

describe("клиентский ли чат", () => {
  test("новый чат — нет", () => expect(isEngagedChat([])).toBe(false));

  test("ассистент уже отвечал — да", () => {
    expect(isEngagedChat([{ direction: "out", kind: "text" }])).toBe(true);
  });

  test("клиент пишет пачкой: первое сообщение не отложено — чат клиентский", () => {
    expect(isEngagedChat([{ direction: "in", kind: "text", meta: null }])).toBe(true);
  });

  test("только отложенные сообщения и эхо владелицы — нет", () => {
    expect(
      isEngagedChat([
        { direction: "in", kind: "text", meta: { personal_hold: true } },
        { direction: "out", kind: "system", meta: { echo: true } },
      ]),
    ).toBe(false);
  });
});

describe("addExcludedContact", () => {
  function recordingDb(error: unknown = null) {
    const calls: any[] = [];
    return {
      calls,
      from(table: string) {
        return {
          upsert(row: unknown, opts: unknown) {
            calls.push({ table, row, opts });
            return Promise.resolve({ error });
          },
        };
      },
    };
  }

  test("пишет номер цифрами и не затирает существующую подпись", async () => {
    const db = recordingDb();
    const res = await addExcludedContact(db, "salon-1", "+996 700 11-22-33", "#личный");
    expect(res).toEqual({ ok: true });
    expect(db.calls).toEqual([
      {
        table: "excluded_contacts",
        row: { salon_id: "salon-1", phone: "996700112233", label: "#личный" },
        opts: { onConflict: "salon_id,phone", ignoreDuplicates: true },
      },
    ]);
  });

  test("Instagram-идентификатор и пустой номер не пишутся", async () => {
    const db = recordingDb();
    expect((await addExcludedContact(db, "s", "ig:123", "x")).ok).toBe(false);
    expect((await addExcludedContact(db, "s", "", "x")).ok).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  test("ошибка базы возвращается, а не глотается", async () => {
    const res = await addExcludedContact(recordingDb({ message: "boom" }), "s", "996700", "x");
    expect(res).toEqual({ ok: false, error: "boom" });
  });
});

describe("WhatsApp подключает оба механизма", () => {
  const route = readFileSync("src/routes/api/public/wacloud.$salonId.ts", "utf8");
  const reconcile = readFileSync("src/lib/wa-reconcile.server.ts", "utf8");

  test("тег из эха владелицы ведёт в исключения", () => {
    expect(route).toContain("hasPersonalTag(");
    expect(route).toContain("addExcludedContact(");
  });

  test("входящее проходит проверку на личный чат", () => {
    expect(route).toContain("shouldHoldForOwner(");
    expect(route).toContain("isEngagedChat(");
  });

  test("перезапуск потерянных сообщений не отвечает на отложенные", () => {
    expect(reconcile).toContain("personal_hold");
  });
});

describe("рассылки и развод — молчим даже в клиентском чате", () => {
  // Клиентка записалась полгода назад, а потом её номер продали рассыльщикам. Чат давно
  // клиентский, поэтому обычное правило «молчим до признаков клиента» уже не работает — а каждый
  // ответ платный и выглядит глупо.
  test.each([
    "Одобрен кредит до 500 000 сом, переходите по ссылке",
    "Инвестиции в криптовалюту от 100$, пассивный доход",
    "Поздравляем, вы выиграли приз! Заберите подарок",
    "Ставки на спорт, первый депозит удваиваем",
    "Накрутка подписчиков и продвижение вашего бизнеса недорого",
  ])("%p", (text) => {
    expect(looksLikeSpam(text)).toBe(true);
    expect(shouldHoldForOwner({ chatAlreadyEngaged: true, text, hasImage: false })).toBe(true);
  });

  // Цена ошибки несимметрична: промолчать клиенту дороже, чем один раз ответить рекламе.
  // Поэтому слова, которыми интересуются ЖИВЫЕ клиенты, спамом не считаются.
  test.each([
    "А скидка на окрашивание есть?",
    "У вас акция какая-нибудь действует?",
    "Есть промокод на первое посещение?",
    "Можно в рассрочку оплатить?",
    "Здравствуйте, хочу записаться",
  ])("не спам: %p", (text) => {
    expect(looksLikeSpam(text)).toBe(false);
  });
});

describe("родня, школа, поставщики — ассистент молчит, даже если вежливо", () => {
  // Приветствие и «вы» — слабые признаки: так пишет и поставщик, и учительница. Раньше любое
  // «здравствуйте» делало чат клиентским навсегда.
  test.each([
    "Здравствуйте, по поводу поставки оборудования",
    "Добрый день! Отправляю накладную и реквизиты",
    "Здравствуйте, вы придёте на родительское собрание?",
    "Салам, апам чалды, үйгө келесиңби?",
    "Привет, как дела? Скучаю",
    "Мама просила позвонить",
    "Заберёшь балам из школы?",
    "Здравствуйте, коммерческое предложение во вложении",
  ])("%p", (text) => {
    expect(looksLikeClientMessage({ text, hasImage: false })).toBe(false);
    expect(shouldHoldForOwner({ chatAlreadyEngaged: false, text, hasImage: false })).toBe(true);
  });

  // Сильный признак клиента бьёт всё: спросил про услугу — значит клиент, чем бы ни пахло рядом.
  test.each([
    "Каким оборудованием делаете маникюр?",
    "Здравствуйте, мама просила записать её на стрижку",
    "Добрый день, сколько стоит окрашивание?",
  ])("клиент, несмотря на соседние слова: %p", (text) => {
    expect(looksLikeClientMessage({ text, hasImage: false })).toBe(true);
  });

  // МИНЫ. Короткие корни на кириллице живут внутри обычных слов: «муж» в «МУЖская», «брат» в
  // «оБРАТитесь», «ата» в «оплАТА», «класс» в «КЛАССно». Любая такая мина в списке личного молча
  // съела бы настоящего клиента, поэтому в каждой строке есть явный признак клиента — и проверка
  // в том, что мина его НЕ перебила.
  test.each([
    "Мужская стрижка сколько стоит?",
    "Обратитесь ко мне, когда будет свободное окошко",
    "Когда оплата за стрижку, до или после?",
    "Классно, записывайте",
  ])("не считается личным: %p", (text) => {
    expect(looksLikeClientMessage({ text, hasImage: false })).toBe(true);
  });
});
