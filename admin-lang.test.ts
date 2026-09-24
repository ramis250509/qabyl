// Язык кабинета: английский появился ради видео для App Review Meta, а салоны должны продолжать
// видеть русский, ничего не нажимая. Здесь закреплено именно это: без явного выбора — русский.
//
// Run: bun test --isolate admin-lang
import { test, expect, describe } from "bun:test";
import { makeTr, adminLocale } from "@/lib/admin-lang";
import { billingBannerText } from "@/components/admin/BillingBanner";
import type { BillingState } from "@/lib/billing-logic";

describe("makeTr", () => {
  test("русский кабинет берёт первую строку пары, английский — вторую", () => {
    expect(makeTr("ru")("Сохранить", "Save")).toBe("Сохранить");
    expect(makeTr("en")("Сохранить", "Save")).toBe("Save");
  });

  test("даты форматируются по языку кабинета", () => {
    expect(adminLocale("ru")).toBe("ru-RU");
    expect(adminLocale("en")).toBe("en-US");
  });
});

describe("billingBannerText: язык баннера оплаты", () => {
  const trialEndsSoon: BillingState = {
    has_subscription: true,
    blocked: false,
    status: "trialing",
    trial_ends_at: new Date(Date.now() + 2 * 86_400_000 - 60_000).toISOString(),
    trial_warn_days: 3,
  };

  test("без указания языка — по-русски, как было до появления английского", () => {
    const b = billingBannerText(trialEndsSoon, true);
    expect(b?.text).toContain("Бесплатно осталось 2 дня");
  });

  test("английский кабинет получает английский текст", () => {
    const b = billingBannerText(trialEndsSoon, true, "en");
    expect(b?.text).toBe("2 days of free trial left. Pay for a plan to avoid a break.");
  });

  test("дата в английском баннере — по-английски", () => {
    const pastDue: BillingState = {
      has_subscription: true,
      blocked: false,
      status: "past_due",
      grace_until: "2026-10-05T12:00:00Z",
    };
    expect(billingBannerText(pastDue, true, "en")?.text).toContain("October 5");
    expect(billingBannerText(pastDue, true)?.text).toContain("5 октября");
  });
});
