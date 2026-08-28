// Выбор транспорта для business-initiated сообщений WhatsApp.
// Запуск: bun test wa-transport-choice.test.ts
//
// Это решение определяет, уйдёт ли вообще подтверждение записи, напоминание за два часа или
// уведомление об отмене. Ошибка здесь тиха в самую неприятную сторону: у салона перестают
// уходить напоминания, и узнают об этом, когда клиенты начинают не приходить.
//
// РАНЬШЕ главным свойством была «страховка»: салон с подключённым Green-API никогда не оставался
// без транспорта. Green-API удалён — он работает поверх обычного аккаунта WhatsApp и нарушает его
// условия, за что Meta банит номера. Поэтому «нечем отправить» стало настоящим исходом, и
// защищать теперь надо другое: **каждый тупик обязан быть назван словами**, а не молчать.
import { test, expect, describe } from "bun:test";
import {
  chooseTransport,
  explainNoTransport,
  type WaTransportInputs,
} from "./supabase/functions/_shared/wa-transport";

/** Полностью настроенный подключённый салон. Тесты переопределяют по одному полю. */
function inputs(over: Partial<WaTransportInputs> = {}): WaTransportInputs {
  return {
    hasCloud: true,
    templatesReady: true,
    hasTemplateForKind: true,
    inWindow: true,
    ...over,
  };
}

describe("внутри 24-часового окна", () => {
  test("свободный текст, а не шаблон", () => {
    // Шаблон — жёсткий каркас на пять плейсхолдеров. Свободное сообщение подробнее и содержит
    // ссылку на самоуправление, поэтому внутри окна оно предпочтительнее даже при готовых шаблонах.
    expect(chooseTransport(inputs())).toBe("cloud_text");
  });

  test("свободный текст, даже когда шаблонов нет вовсе", () => {
    expect(chooseTransport(inputs({ templatesReady: false, hasTemplateForKind: false }))).toBe(
      "cloud_text",
    );
  });
});

describe("вне окна", () => {
  test("одобренный шаблон, если он есть для этого вида", () => {
    expect(chooseTransport(inputs({ inWindow: false }))).toBe("cloud_template");
  });

  test("шаблоны ещё не одобрены — отправить нечем, и это названо", () => {
    const i = inputs({ inWindow: false, templatesReady: false });
    expect(chooseTransport(i)).toBe("none");
    expect(explainNoTransport(i, "reminder")).toContain("шаблоны");
  });

  test("шаблоны одобрены, но для этого вида имя не задано", () => {
    const i = inputs({ inWindow: false, hasTemplateForKind: false });
    expect(chooseTransport(i)).toBe("none");
    // Причина должна отличаться от предыдущей: чинится она по-другому — вписать имя, а не ждать
    // модерацию.
    expect(explainNoTransport(i, "reminder")).toContain("reminder");
  });
});

describe("салон без подключённого WhatsApp", () => {
  test("отправить нечем в любом случае", () => {
    expect(chooseTransport(inputs({ hasCloud: false }))).toBe("none");
    expect(chooseTransport(inputs({ hasCloud: false, inWindow: false }))).toBe("none");
  });

  test("причина — именно отсутствие подключения, а не окно", () => {
    // Владельцу бесполезно читать про 24 часа, когда чинить надо совсем другое.
    const msg = explainNoTransport(inputs({ hasCloud: false, inWindow: false }), "reminder");
    expect(msg).toContain("не подключён");
    expect(msg).not.toContain("24 часа");
  });
});

describe("свойство безопасности: молчаливых тупиков нет", () => {
  test("каждый тупик объясняется словами", () => {
    // Исчерпывающе по всем комбинациям: если какая-то из них вернёт "none" без внятного
    // объяснения, владелец увидит «не доставлено» и пойдёт в поддержку вместо того, чтобы
    // починить самому.
    for (const hasCloud of [true, false]) {
      for (const templatesReady of [true, false]) {
        for (const hasTemplateForKind of [true, false]) {
          for (const inWindow of [true, false]) {
            const i: WaTransportInputs = {
              hasCloud,
              templatesReady,
              hasTemplateForKind,
              inWindow,
            };
            if (chooseTransport(i) === "none") {
              expect(explainNoTransport(i, "reminder").length).toBeGreaterThan(10);
            }
          }
        }
      }
    }
  });

  test("подключённый салон внутри окна всегда может отправить", () => {
    // Единственная гарантия, которая осталась после удаления Green-API, и она важна: пока клиент
    // писал недавно, ответить можно всегда, независимо от состояния шаблонов.
    for (const templatesReady of [true, false]) {
      for (const hasTemplateForKind of [true, false]) {
        expect(
          chooseTransport({ hasCloud: true, templatesReady, hasTemplateForKind, inWindow: true }),
        ).toBe("cloud_text");
      }
    }
  });
});
