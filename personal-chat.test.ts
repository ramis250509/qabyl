// Личные чаты: тег «#личный» с телефона и молчание до признаков клиента.
//
// Запуск: bun test personal-chat

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  hasPersonalTag,
  isEngagedChat,
  looksLikeClientMessage,
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
