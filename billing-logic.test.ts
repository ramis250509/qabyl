// Правила биллинга: деньги салона не должны зависеть от того, какое сегодня число.
//
// Запуск: bun test billing-logic.test.ts

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BILLING_CONFIG as cfg,
  addMonths,
  decidePlanChange,
  describePlan,
  estimateCost,
  nextLifecycleAction,
  prorationAmount,
  usageLevel,
  type Plan,
  type Subscription,
} from "./src/lib/billing-logic";

const features = {
  booking_page: true,
  reminders: true,
  basic_stats: true,
  analytics_advanced: false,
  reactivation: false,
  sales_mode: false,
  prepayment: false,
  export: false,
  support: "standard" as const,
};

const start: Plan = {
  code: "start",
  name: "Start",
  price_kgs: 4499,
  trial_days: 30,
  sort_order: 1,
  is_featured: false,
  limits: {
    messages_month: 1500,
    trial_messages: 500,
    branches: 1,
    channels: 1,
    overage_pack_messages: 500,
    overage_pack_price_kgs: 1490,
  },
  features,
};
const business: Plan = {
  ...start,
  code: "business",
  name: "Business",
  price_kgs: 6499,
  trial_days: 14,
  is_featured: true,
  limits: {
    messages_month: 3000,
    trial_messages: 700,
    branches: 3,
    channels: 2,
    overage_pack_messages: 500,
    overage_pack_price_kgs: 1190,
  },
  features: {
    ...features,
    analytics_advanced: true,
    reactivation: true,
    sales_mode: true,
    prepayment: true,
    support: "priority",
  },
};
const pro: Plan = {
  ...business,
  code: "pro",
  name: "Pro",
  price_kgs: 10499,
  is_featured: false,
  limits: {
    messages_month: 6000,
    trial_messages: 700,
    branches: 10,
    channels: 3,
    overage_pack_messages: 500,
    overage_pack_price_kgs: 990,
  },
};
const plans = new Map([start, business, pro].map((p) => [p.code, p]));

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    salon_id: "s1",
    plan_code: "start",
    status: "trialing",
    trial_started_at: "2026-09-01T00:00:00Z",
    trial_ends_at: "2026-10-01T00:00:00Z",
    current_period_start: null,
    current_period_end: null,
    grace_until: null,
    pending_plan_code: null,
    cancel_at_period_end: false,
    auto_topup: true,
    billing_exempt: false,
    ...over,
  };
}

const d = (s: string) => new Date(s);

describe("даты", () => {
  test("месяц от 31 января — конец февраля, а не март", () => {
    expect(addMonths(d("2026-01-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
  });
  test("високосный февраль", () => {
    expect(addMonths(d("2028-01-31T00:00:00Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
  test("обычный месяц", () => {
    expect(addMonths(d("2026-09-15T00:00:00Z"), 1).toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });
});

describe("доплата за повышение", () => {
  test("середина месяца — половина разницы, округление вверх", () => {
    const amount = prorationAmount(
      4499,
      6499,
      d("2026-09-01Z"),
      d("2026-10-01Z"),
      d("2026-09-16Z"),
    );
    expect(amount).toBe(1000);
  });
  test("понижение не даёт отрицательную доплату", () => {
    expect(prorationAmount(6499, 4499, d("2026-09-01Z"), d("2026-10-01Z"), d("2026-09-16Z"))).toBe(
      0,
    );
  });
  test("после конца периода доплата нулевая", () => {
    expect(prorationAmount(4499, 6499, d("2026-09-01Z"), d("2026-10-01Z"), d("2026-10-05Z"))).toBe(
      0,
    );
  });
});

describe("смена тарифа", () => {
  const footprint = { branches: 1, channels: 1 };

  test("не помещается по филиалам — отказ с объяснением", () => {
    const r = decidePlanChange(
      sub({ plan_code: "business", status: "active" }),
      business,
      start,
      { branches: 2, channels: 1 },
      d("2026-09-10Z"),
    );
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toContain("филиал");
  });

  test("не помещается по каналам — отказ", () => {
    const r = decidePlanChange(
      sub({ plan_code: "business", status: "active" }),
      business,
      start,
      { branches: 1, channels: 2 },
      d("2026-09-10Z"),
    );
    expect(r.kind).toBe("blocked");
  });

  test("в пробном периоде срок пересчитывается по новому тарифу", () => {
    const r = decidePlanChange(sub(), start, business, footprint, d("2026-09-05Z"));
    expect(r.kind).toBe("trial_switch");
    if (r.kind === "trial_switch")
      expect(r.trialEndsAt.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  test("переход на 14-дневный тариф на 20-й день заканчивает пробный сразу", () => {
    const now = d("2026-09-21Z");
    const r = decidePlanChange(sub(), start, business, footprint, now);
    expect(r.kind).toBe("trial_switch");
    if (r.kind === "trial_switch") expect(r.trialEndsAt.getTime()).toBe(now.getTime());
  });

  test("повышение оплаченного — сразу с доплатой", () => {
    const s = sub({
      status: "active",
      current_period_start: "2026-09-01T00:00:00Z",
      current_period_end: "2026-10-01T00:00:00Z",
    });
    const r = decidePlanChange(s, start, business, footprint, d("2026-09-16Z"));
    expect(r).toEqual({ kind: "upgrade_now", chargeKgs: 1000 });
  });

  test("понижение оплаченного — со следующего месяца", () => {
    const s = sub({
      plan_code: "pro",
      status: "active",
      current_period_start: "2026-09-01T00:00:00Z",
      current_period_end: "2026-10-01T00:00:00Z",
    });
    expect(decidePlanChange(s, pro, business, footprint, d("2026-09-16Z")).kind).toBe(
      "downgrade_at_period_end",
    );
  });

  test("заблокированный салон покупает новый месяц целиком", () => {
    const r = decidePlanChange(
      sub({ status: "suspended" }),
      start,
      business,
      footprint,
      d("2026-09-16Z"),
    );
    expect(r).toEqual({ kind: "new_period", chargeKgs: 6499 });
  });

  test("тот же тариф — ничего", () => {
    expect(
      decidePlanChange(sub({ status: "active" }), start, start, footprint, d("2026-09-16Z")).kind,
    ).toBe("same");
  });
});

describe("жизненный цикл", () => {
  test("освобождённый салон не трогаем", () => {
    const s = sub({ billing_exempt: true, trial_ends_at: "2026-09-02T00:00:00Z" });
    expect(nextLifecycleAction(s, plans, cfg, d("2026-09-10Z"), false).type).toBe("none");
  });

  test("пробный идёт — ничего", () => {
    expect(nextLifecycleAction(sub(), plans, cfg, d("2026-09-10Z"), false).type).toBe("none");
  });

  test("пробный кончился без карты — отсрочка", () => {
    const now = d("2026-10-01T05:00:00Z");
    const a = nextLifecycleAction(sub(), plans, cfg, now, false);
    expect(a.type).toBe("to_past_due");
    if (a.type === "to_past_due")
      expect(a.graceUntil.toISOString()).toBe("2026-10-04T05:00:00.000Z");
  });

  test("пробный кончился с картой — списание за месяц с конца пробного", () => {
    const a = nextLifecycleAction(sub(), plans, cfg, d("2026-10-01T05:00:00Z"), true);
    expect(a.type).toBe("charge_period");
    if (a.type === "charge_period") {
      expect(a.amountKgs).toBe(4499);
      expect(a.periodStart.toISOString()).toBe("2026-10-01T00:00:00.000Z");
      expect(a.periodEnd.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    }
  });

  test("продление списывает по отложенному (пониженному) тарифу", () => {
    const s = sub({
      plan_code: "pro",
      status: "active",
      pending_plan_code: "business",
      current_period_end: "2026-10-01T00:00:00Z",
    });
    const a = nextLifecycleAction(s, plans, cfg, d("2026-10-01T01:00:00Z"), true);
    expect(a.type === "charge_period" && a.planCode).toBe("business");
    expect(a.type === "charge_period" && a.amountKgs).toBe(6499);
  });

  test("отказ с конца периода — отмена, без списания", () => {
    const s = sub({
      status: "active",
      cancel_at_period_end: true,
      current_period_end: "2026-10-01T00:00:00Z",
    });
    expect(nextLifecycleAction(s, plans, cfg, d("2026-10-01T01:00:00Z"), true).type).toBe("cancel");
  });

  test("отсрочка кончилась — блокировка", () => {
    const s = sub({ status: "past_due", grace_until: "2026-10-04T00:00:00Z" });
    expect(nextLifecycleAction(s, plans, cfg, d("2026-10-04T00:00:01Z"), false).type).toBe(
      "suspend",
    );
  });

  test("отсрочка идёт — ничего", () => {
    const s = sub({ status: "past_due", grace_until: "2026-10-04T00:00:00Z" });
    expect(nextLifecycleAction(s, plans, cfg, d("2026-10-03T00:00:00Z"), false).type).toBe("none");
  });
});

describe("расход", () => {
  test("пороги", () => {
    expect(usageLevel(700, 1000, cfg)).toBe("ok");
    expect(usageLevel(800, 1000, cfg)).toBe("warn");
    expect(usageLevel(1000, 1000, cfg)).toBe("assistant_paused");
    expect(usageLevel(1100, 1000, cfg)).toBe("notifications_paused");
  });
});

describe("юнит-экономика", () => {
  test("Start на полном лимите WhatsApp остаётся в плюсе больше чем на 50%", () => {
    const c = estimateCost({ wa_out: 1500, ig_out: 0, ai_reply: 1500 }, start.price_kgs, cfg);
    expect(c.marginPct).toBeGreaterThan(50);
  });
  test("Business на полном лимите — в плюсе", () => {
    const c = estimateCost({ wa_out: 3000, ig_out: 0, ai_reply: 3000 }, business.price_kgs, cfg);
    expect(c.marginKgs).toBeGreaterThan(0);
    expect(c.marginPct).toBeGreaterThan(40);
  });
  test("Pro на полном лимите — в плюсе", () => {
    const c = estimateCost({ wa_out: 6000, ig_out: 0, ai_reply: 6000 }, pro.price_kgs, cfg);
    expect(c.marginPct).toBeGreaterThan(35);
  });
  test("пакет сообщений прибыльнее собственной себестоимости на всех тарифах", () => {
    for (const p of [start, business, pro]) {
      const packCost =
        p.limits.overage_pack_messages * (cfg.wa_message_usd * cfg.usd_kgs + cfg.ai_reply_kgs);
      expect(p.limits.overage_pack_price_kgs).toBeGreaterThan(packCost * 2);
    }
  });
});

describe("описание тарифа", () => {
  test("берётся из лимитов, а не из текста", () => {
    const lines = describePlan({ ...start, limits: { ...start.limits, messages_month: 1234 } });
    expect(lines[0]).toContain("1");
    expect(lines[0]).toContain("234");
  });
  test("без технических слов", () => {
    for (const p of [start, business, pro]) {
      expect(describePlan(p).join(" ")).not.toMatch(/WABA|API|токен|вебхук|Meta|YCloud/i);
    }
  });
});
