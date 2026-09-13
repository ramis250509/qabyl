// Клиент на странице записи и владелец в календаре не должны видеть английский текст Postgres.
// Строки ниже — дословно то, что поднимают create_appointment / reschedule_appointment_v2 и
// триггеры записи (срез функций в проде на 13.09.2026).
//
// Run: bun test human-error
import { test, expect, describe } from "bun:test";
import { humanError } from "@/lib/human-error";

const hasCyrillic = (s: string) => /[а-яё]/i.test(s);

describe("humanError: ошибки записи переводятся на язык человека", () => {
  const raw = [
    "Time slot is no longer available",
    'conflicting key value violates exclusion constraint "appointments_no_overlap"',
    "Cannot book in the past",
    "Cannot reschedule to the past",
    "Master cannot perform this service",
    "Master does not offer this service",
    "Master does not work at this branch",
    "Service not found",
    "Invalid client phone",
    "Invalid client name",
    "Only confirmed appointments can be rescheduled",
    "Price override out of allowed range",
    "salon_billing_suspended",
  ];
  for (const r of raw) {
    test(r, () => {
      const out = humanError({ message: r });
      expect(out).not.toBe(r);
      expect(hasCyrillic(out)).toBe(true);
    });
  }

  test("занятое время говорит, что делать дальше", () => {
    expect(humanError({ message: "Time slot is no longer available" })).toMatch(/выберите другое/);
  });

  test("русские тексты из базы (перерыв, график) проходят как есть", () => {
    const ru = "У мастера установлен перерыв с 13:00 до 14:00";
    expect(humanError({ message: ru })).toBe(ru);
  });

  test("пустая ошибка → фраза-действие, а не «undefined»", () => {
    expect(humanError(undefined, "Не удалось записаться")).toBe("Не удалось записаться");
    expect(humanError({})).not.toMatch(/undefined|null/);
  });
});
