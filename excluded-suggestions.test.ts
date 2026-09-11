// Поиск контактов, которым ассистент отвечает зря. Главное свойство — не предлагать клиентов.
//
// Запуск: bun test excluded-suggestions.test.ts

import { describe, expect, test } from "bun:test";
import {
  assessContact,
  stemsFromServiceNames,
  type ContactSignals,
} from "./src/lib/excluded-suggestions";

function contact(over: Partial<ContactSignals> = {}): ContactSignals {
  return {
    phone: "996700000001",
    name: null,
    inboundTexts: [],
    inboundCount: 0,
    aiReplies: 0,
    ownerReplies: 0,
    everBooked: false,
    isSalonNumber: false,
    ...over,
  };
}

describe("не предлагать клиентов", () => {
  test("записывался — никогда", () => {
    const c = contact({
      everBooked: true,
      ownerReplies: 20,
      inboundCount: 30,
      inboundTexts: ["как дела"],
    });
    expect(assessContact(c)).toBeNull();
  });

  test("спрашивал о цене — это лид", () => {
    const c = contact({
      inboundCount: 10,
      ownerReplies: 5,
      inboundTexts: ["Здравствуйте", "Сколько стоит?"],
    });
    expect(assessContact(c)).toBeNull();
  });

  test("по-кыргызски про запись — тоже лид", () => {
    const c = contact({
      inboundCount: 6,
      ownerReplies: 3,
      inboundTexts: ["Саламатсызбы", "канча турат"],
    });
    expect(assessContact(c)).toBeNull();
  });

  test("назвал услугу салона — лид, даже без общих слов", () => {
    const stems = stemsFromServiceNames(["Ламинирование волос", "Шугаринг"]);
    const c = contact({ inboundCount: 5, ownerReplies: 2, inboundTexts: ["а шугаринг есть?"] });
    expect(assessContact(c, stems)).toBeNull();
  });

  test("один «здравствуйте» без ответа владельца — не повод", () => {
    expect(assessContact(contact({ inboundCount: 1, inboundTexts: ["Здравствуйте"] }))).toBeNull();
  });

  test("просто много сообщений без других признаков — не повод", () => {
    expect(
      assessContact(contact({ inboundCount: 4, inboundTexts: ["ок", "да", "❤️", "👍"] })),
    ).toBeNull();
  });
});

describe("предлагать", () => {
  test("номер салона — почти точно", () => {
    const v = assessContact(contact({ isSalonNumber: true }));
    expect(v?.confidence).toBe("high");
  });

  test("владелица сама переписывается, о записи ни слова — почти точно", () => {
    const v = assessContact(
      contact({
        inboundCount: 12,
        ownerReplies: 7,
        inboundTexts: ["ты где", "Ок", "❤️", "домой приедешь?"],
      }),
    );
    expect(v?.confidence).toBe("high");
    expect(v?.reasons.join(" ")).toContain("сами");
  });

  test("личная переписка без ответов владелицы — возможно", () => {
    const v = assessContact(
      contact({ inboundCount: 9, inboundTexts: ["как дела", "скучаю", "позвони"] }),
    );
    expect(v).not.toBeNull();
    expect(v?.confidence).toBe("medium");
  });

  test("причины без технических слов", () => {
    const v = assessContact(
      contact({ inboundCount: 9, ownerReplies: 2, inboundTexts: ["как дела"] }),
    );
    expect(v?.reasons.join(" ")).not.toMatch(/intent|score|webhook|Gemini|ИИ-модел/i);
  });
});

describe("основы слов из услуг", () => {
  test("короткие слова не превращаются в основы", () => {
    expect(stemsFromServiceNames(["Лак 2D", "Наращивание ресниц"])).toEqual(["наращ", "ресни"]);
  });
});
