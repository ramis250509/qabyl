// Кому какое состояние канала показывается.
//
// Повод: на первом экране кабинета владелицы салона висела красная плашка «Оплата сообщений ещё
// не подключена» с кнопкой «Написать в поддержку». Оплату за сообщения вносит платформа, чинится
// это только на нашей стороне, и от владелицы плашка требовала ровно ничего — при этом каждый
// день сообщала, что продукт сломан.
import { describe, expect, test } from "bun:test";
import { waChipText, waStatusForViewer } from "./src/lib/wa-status-view";
import { computeWaStatus } from "./src/lib/wa-connection.server";

const healthy = () => ({
  whatsapp_cloud_phone_number_id: "1",
  whatsapp_cloud_token: "t",
  whatsapp_cloud_waba_id: "w",
  wa_last_health_check_at: new Date().toISOString(),
  wa_payment_ready: true,
  whatsapp_cloud_templates: {},
});

describe("платформенная поломка", () => {
  const platformIssue = () =>
    computeWaStatus({ ...healthy(), wa_payment_ready: false }, { platformBilling: true });

  test("состояние помечено как адресованное платформе", () => {
    expect(platformIssue().audience).toBe("platform");
    expect(platformIssue().level).toBe("error");
  });

  test("супер-админ видит её как есть — он единственный, кто может её закрыть", () => {
    const s = waStatusForViewer(platformIssue(), true);
    expect(s.level).toBe("error");
    expect(s.title).toBe(platformIssue().title);
  });

  test("владелице салона она не показывается красной и ничего от неё не требует", () => {
    const s = waStatusForViewer(platformIssue(), false);
    expect(s.level).toBe("idle");
    expect(s.action).toBeUndefined();
  });

  test("но и не выдаётся за работающий канал — факт остаётся сказанным", () => {
    const s = waStatusForViewer(platformIssue(), false);
    expect(s.level).not.toBe("ok");
    expect(`${s.title} ${s.body}`).toMatch(/настройк/i);
    expect(waChipText(s)).not.toBe("работает");
  });

  test("владелице не показывают внутренние термины платформы", () => {
    const s = waStatusForViewer(platformIssue(), false);
    expect(`${s.title} ${s.body}`).not.toMatch(/WABA|YCloud|кредитн/i);
  });
});

describe("обычные поломки принадлежат владельцу и не трогаются", () => {
  for (const [name, row] of [
    ["потерянный доступ", { ...healthy(), wa_token_status: "invalid" }],
    ["ограничение Meta", { ...healthy(), wa_account_review_status: "DISABLED" }],
    ["нет карты в Meta", { ...healthy(), wa_payment_ready: false }],
  ] as const) {
    test(name, () => {
      const raw = computeWaStatus(row);
      expect(raw.audience).toBeUndefined();
      const seen = waStatusForViewer(raw, false);
      expect(seen.level).toBe(raw.level);
      expect(seen.title).toBe(raw.title);
      expect(seen.action).toBe(raw.action as never);
    });
  }

  test("здоровый канал остаётся здоровым для обоих", () => {
    const raw = computeWaStatus(healthy());
    expect(waStatusForViewer(raw, false).level).toBe(raw.level);
    expect(waStatusForViewer(raw, true).level).toBe(raw.level);
  });
});

describe("подпись плашки", () => {
  test("неподключённый канал называется неподключённым", () => {
    expect(waChipText({ connected: false, level: "idle" })).toBe("не подключён");
  });

  test("подключённый и здоровый — работает", () => {
    expect(waChipText({ connected: true, level: "ok" })).toBe("работает");
  });

  test("подключённый с тоном idle — это незаконченная настройка, а не тревога", () => {
    expect(waChipText({ connected: true, level: "idle" })).toBe("заканчиваем настройку");
  });

  test("поломка владельца зовёт его посмотреть", () => {
    expect(waChipText({ connected: true, level: "error" })).toBe("требует внимания");
    expect(waChipText({ connected: true, level: "warn" })).toBe("требует внимания");
  });
});
