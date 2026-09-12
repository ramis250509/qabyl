// Правила биллинга без базы, сети и часов.
//
// ЗАЧЕМ ОТДЕЛЬНО. Всё, что решает судьбу денег салона — сколько доплатить при повышении тарифа,
// когда кончается отсрочка, что делать в конце пробного периода, — должно проверяться тестами на
// любых датах, а не выясняться на живом салоне первого числа. Поэтому здесь только чистые функции:
// время приходит параметром `now`, данные — аргументами. База и Freedom Pay живут в
// billing.server.ts и зовут эти функции.
//
// ЦИФРЫ ЗДЕСЬ НЕ ЖИВУТ. Цены, лимиты, себестоимость, длина отсрочки приходят из таблиц
// billing_plans и billing_settings. Код знает только, как с ними обращаться.

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "suspended" | "canceled";

export type PlanLimits = {
  /** −1 = без лимита. См. миграцию 20260912140000: ноль уже занят под «лимита нет вообще». */
  messages_month: number;
  trial_messages: number;
  branches: number;
  channels: number;
  overage_pack_messages: number;
  overage_pack_price_kgs: number;
};

export type PlanFeatures = {
  booking_page: boolean;
  reminders: boolean;
  basic_stats: boolean;
  analytics_advanced: boolean;
  reactivation: boolean;
  sales_mode: boolean;
  prepayment: boolean;
  export: boolean;
  support: "standard" | "priority" | "dedicated";
};

export type Plan = {
  code: string;
  name: string;
  tagline?: string | null;
  price_kgs: number;
  trial_days: number;
  sort_order: number;
  is_featured: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
};

export type BillingConfig = {
  usd_kgs: number;
  wa_message_usd: number;
  ai_reply_kgs: number;
  infra_per_salon_kgs: number;
  gateway_fee_pct: number;
  grace_days: number;
  dunning_retry_days: number[];
  usage_warn_pct: number;
  notifications_ceiling_pct: number;
  trial_warn_days: number;
  /** Текст для владельца, пока оплата картой не подключена: куда перевести и кому написать. */
  manual_payment_instructions?: string | null;
  support_contact?: string | null;
  /** Реквизиты ручной оплаты, пока нет шлюза карт. */
  manual_payment_bank?: string | null;
  manual_payment_phone?: string | null;
  manual_payment_recipient?: string | null;
  /** false — ограничения выключены для всех салонов разом. Расход продолжает считаться. */
  enforcement_enabled?: boolean;
};

/** Состояние салона, как его отдаёт billing_salon_state. Общее для сервера и кабинета. */
export type BillingState = {
  has_subscription: boolean;
  plan_code?: string;
  plan_name?: string;
  price_kgs?: number;
  status?: SubscriptionStatus;
  /** Ограничения к салону не применяются: освобождён сам или биллинг выключен для всех. */
  exempt?: boolean;
  /** Освобождён именно этот салон. */
  salon_exempt?: boolean;
  /** Биллинг включён на платформе. */
  enforced?: boolean;
  blocked: boolean;
  trial_ends_at?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  grace_until?: string | null;
  pending_plan_code?: string | null;
  cancel_at_period_end?: boolean;
  auto_topup?: boolean;
  card_mask?: string | null;
  period_start?: string | null;
  messages_used?: number;
  messages_allowance?: number;
  messages_credits?: number;
  usage_pct?: number;
  usage_warn_pct?: number;
  trial_warn_days?: number;
  assistant_paused?: boolean;
  notifications_paused?: boolean;
  limits?: PlanLimits;
  features?: PlanFeatures;
};

export type Subscription = {
  salon_id: string;
  plan_code: string;
  status: SubscriptionStatus;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  grace_until: string | null;
  pending_plan_code: string | null;
  cancel_at_period_end: boolean;
  auto_topup: boolean;
  billing_exempt: boolean;
};

const DAY = 24 * 60 * 60 * 1000;

/** Значения по умолчанию на случай пустой строки настроек. Совпадают с миграцией. */
export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  usd_kgs: 87.45,
  wa_message_usd: 0.0077,
  ai_reply_kgs: 0.25,
  infra_per_salon_kgs: 250,
  gateway_fee_pct: 3,
  grace_days: 3,
  dunning_retry_days: [1, 2],
  usage_warn_pct: 80,
  notifications_ceiling_pct: 110,
  trial_warn_days: 3,
};

export function normalizeConfig(raw: unknown): BillingConfig {
  const r = (raw ?? {}) as Partial<BillingConfig>;
  return { ...DEFAULT_BILLING_CONFIG, ...r };
}

/**
 * Плюс N месяцев с сохранением дня оплаты.
 *
 * 31 января + 1 месяц = 28 (29) февраля, а не 3 марта: салон, оплативший 31-го, не должен терять
 * три дня в феврале и дальше навсегда платить третьего числа.
 */
export function addMonths(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * DAY);
}

/**
 * Доплата за повышение тарифа посреди оплаченного месяца.
 *
 * Разница цен умножается на долю ОСТАВШЕГОСЯ периода. Округление вверх до сома: копейки не
 * выставляем, а в меньшую сторону округлять — значит отдавать разницу при каждом повышении.
 */
export function prorationAmount(
  fromPriceKgs: number,
  toPriceKgs: number,
  periodStart: Date,
  periodEnd: Date,
  now: Date,
): number {
  const diff = toPriceKgs - fromPriceKgs;
  if (diff <= 0) return 0;
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0) return diff;
  const left = Math.min(Math.max(periodEnd.getTime() - now.getTime(), 0), total);
  return Math.ceil((diff * left) / total);
}

export type PlanChangeDecision =
  | { kind: "same" }
  | { kind: "blocked"; reason: string }
  | { kind: "trial_switch"; trialEndsAt: Date }
  | { kind: "upgrade_now"; chargeKgs: number }
  | { kind: "downgrade_at_period_end" }
  | { kind: "new_period"; chargeKgs: number };

/**
 * Что происходит, когда салон выбирает другой тариф.
 *
 * ПРАВИЛА:
 *   • Нельзя перейти туда, куда не помещаешься: филиалов или каналов больше лимита. Отказ со
 *     словами, что именно убрать — иначе после понижения салон молча упрётся в лимит.
 *   • В пробном периоде тариф меняется сразу, срок пробного пересчитывается от его начала по
 *     правилам нового тарифа (Start — 30 дней, Business и Pro — 14). Ушедшее время не
 *     возвращается: переход на 14-дневный тариф на 20-й день заканчивает пробный период сразу.
 *   • Повышение оплаченного — сразу, с доплатой за остаток месяца.
 *   • Понижение оплаченного — с начала следующего месяца: оплаченное не отнимаем.
 *   • Заблокированный или отменённый салон, выбирая тариф, покупает новый месяц целиком.
 */
export function decidePlanChange(
  sub: Subscription,
  fromPlan: Plan,
  toPlan: Plan,
  usage: { branches: number; channels: number },
  now: Date,
): PlanChangeDecision {
  if (usage.branches > toPlan.limits.branches) {
    return {
      kind: "blocked",
      reason: `На тарифе ${toPlan.name} до ${toPlan.limits.branches} ${plural(toPlan.limits.branches, "филиала", "филиалов", "филиалов")}, а у вас ${usage.branches}. Сначала отключите лишние.`,
    };
  }
  if (usage.channels > toPlan.limits.channels) {
    return {
      kind: "blocked",
      reason: `На тарифе ${toPlan.name} ${toPlan.limits.channels === 1 ? "один канал связи" : `до ${toPlan.limits.channels} каналов связи`}, а подключено ${usage.channels}. Сначала отключите лишний канал.`,
    };
  }

  if (sub.status === "suspended" || sub.status === "canceled") {
    return { kind: "new_period", chargeKgs: toPlan.price_kgs };
  }

  if (toPlan.code === fromPlan.code) return { kind: "same" };

  if (sub.status === "trialing") {
    const start = new Date(sub.trial_started_at ?? now.toISOString());
    const planned = addDays(start, toPlan.trial_days);
    return { kind: "trial_switch", trialEndsAt: planned.getTime() > now.getTime() ? planned : now };
  }

  if (toPlan.price_kgs > fromPlan.price_kgs) {
    const ps = sub.current_period_start ? new Date(sub.current_period_start) : now;
    const pe = sub.current_period_end ? new Date(sub.current_period_end) : addMonths(now, 1);
    return {
      kind: "upgrade_now",
      chargeKgs: prorationAmount(fromPlan.price_kgs, toPlan.price_kgs, ps, pe, now),
    };
  }

  return { kind: "downgrade_at_period_end" };
}

export type LifecycleAction =
  | { type: "none" }
  | {
      type: "charge_period";
      planCode: string;
      amountKgs: number;
      periodStart: Date;
      periodEnd: Date;
    }
  | { type: "to_past_due"; graceUntil: Date; reason: string }
  | { type: "suspend" }
  | { type: "cancel" };

/**
 * Следующий шаг жизни подписки. Вызывается ежечасно для каждого салона.
 *
 * Возвращает РЕШЕНИЕ, а не делает его: списание, запись в базу и уведомление — забота
 * вызывающего. Благодаря этому одно и то же решение проверяется тестом и исполняется в cron.
 */
export function nextLifecycleAction(
  sub: Subscription,
  plans: Map<string, Plan>,
  cfg: BillingConfig,
  now: Date,
  hasCard: boolean,
): LifecycleAction {
  if (sub.billing_exempt) return { type: "none" };

  if (sub.status === "trialing") {
    const end = sub.trial_ends_at ? new Date(sub.trial_ends_at) : null;
    if (!end || now.getTime() < end.getTime()) return { type: "none" };
    const plan = plans.get(sub.plan_code);
    if (!plan) return { type: "none" };
    if (!hasCard) {
      return {
        type: "to_past_due",
        graceUntil: addDays(now, cfg.grace_days),
        reason: "Пробный период закончился, карта не привязана",
      };
    }
    return {
      type: "charge_period",
      planCode: plan.code,
      amountKgs: plan.price_kgs,
      periodStart: end,
      periodEnd: addMonths(end, 1),
    };
  }

  if (sub.status === "active") {
    const end = sub.current_period_end ? new Date(sub.current_period_end) : null;
    if (!end || now.getTime() < end.getTime()) return { type: "none" };
    if (sub.cancel_at_period_end) return { type: "cancel" };
    const plan = plans.get(sub.pending_plan_code ?? sub.plan_code);
    if (!plan) return { type: "none" };
    if (!hasCard) {
      return {
        type: "to_past_due",
        graceUntil: addDays(now, cfg.grace_days),
        reason: "Нет привязанной карты для продления",
      };
    }
    return {
      type: "charge_period",
      planCode: plan.code,
      amountKgs: plan.price_kgs,
      periodStart: end,
      periodEnd: addMonths(end, 1),
    };
  }

  if (sub.status === "past_due") {
    const grace = sub.grace_until ? new Date(sub.grace_until) : null;
    if (grace && now.getTime() >= grace.getTime()) return { type: "suspend" };
    return { type: "none" };
  }

  return { type: "none" };
}

export type UsageLevel = "ok" | "warn" | "assistant_paused" | "notifications_paused";

/**
 * Насколько салон израсходовал лимит.
 *
 * Два порога вместо одного намеренно. На 100% замолкает ассистент — его ответы и есть основной
 * расход. Подтверждения и напоминания уже записанным клиентам идут дальше, до потолка
 * (по умолчанию 110%): оставить записанного клиента без напоминания из-за того, что ассистент
 * переговорил, — плохой обмен.
 */
export function usageLevel(used: number, allowance: number, cfg: BillingConfig): UsageLevel {
  // Безлимит. Отрицательное значение приходит с сервера и означает «не считать»; ноль по-прежнему
  // значит «нечего тратить» — это разные вещи, и путать их нельзя: на безлимите такая путаница
  // остановила бы ассистента с первого же сообщения.
  if (allowance < 0) return "ok";
  if (allowance === 0) return used > 0 ? "notifications_paused" : "ok";
  const pct = (used * 100) / allowance;
  if (pct >= cfg.notifications_ceiling_pct) return "notifications_paused";
  if (pct >= 100) return "assistant_paused";
  if (pct >= cfg.usage_warn_pct) return "warn";
  return "ok";
}

export type CostEstimate = {
  metaKgs: number;
  aiKgs: number;
  infraKgs: number;
  gatewayKgs: number;
  totalKgs: number;
  revenueKgs: number;
  marginKgs: number;
  marginPct: number;
};

/**
 * Себестоимость салона за месяц и маржа Qabyl.
 *
 * wa_out — сообщения WhatsApp (платит Meta), ig_out — Instagram (Meta не берёт), ai_reply — ходы
 * ассистента (Gemini). Комиссия шлюза считается от выручки, а не от себестоимости.
 */
export function estimateCost(
  usage: { wa_out: number; ig_out: number; ai_reply: number },
  revenueKgs: number,
  cfg: BillingConfig,
): CostEstimate {
  const metaKgs = usage.wa_out * cfg.wa_message_usd * cfg.usd_kgs;
  const aiKgs = usage.ai_reply * cfg.ai_reply_kgs;
  const infraKgs = cfg.infra_per_salon_kgs;
  const gatewayKgs = (revenueKgs * cfg.gateway_fee_pct) / 100;
  const totalKgs = metaKgs + aiKgs + infraKgs + gatewayKgs;
  const marginKgs = revenueKgs - totalKgs;
  return {
    metaKgs: round(metaKgs),
    aiKgs: round(aiKgs),
    infraKgs: round(infraKgs),
    gatewayKgs: round(gatewayKgs),
    totalKgs: round(totalKgs),
    revenueKgs,
    marginKgs: round(marginKgs),
    marginPct: revenueKgs > 0 ? Math.round((marginKgs * 100) / revenueKgs) : 0,
  };
}

/**
 * Что входит в тариф — словами салона.
 *
 * Список собирается из данных тарифа, а не пишется для каждого тарифа руками: иначе после
 * изменения лимита в базе экран цен продолжит обещать старое.
 */
export function describePlan(plan: Plan): string[] {
  const l = plan.limits;
  const f = plan.features;
  const lines = [
    l.messages_month < 0
      ? "Сообщения ассистента без ограничений"
      : `${formatNumber(l.messages_month)} сообщений ассистента в месяц`,
    // Каналы больше не отдельный лимит: правило одно — на каждую точку свой WhatsApp и свой
    // Instagram. Прежние строки («WhatsApp ИЛИ Instagram», «до 2 каналов») сталкивали клиента
    // с числом, которое не совпадало с числом точек, и объяснить это было нечем.
    l.branches === 1
      ? "WhatsApp и Instagram салона"
      : "Свой WhatsApp и Instagram для каждой точки",
    l.branches === 1
      ? "Одна точка"
      : `До ${l.branches} ${plural(l.branches, "точки", "точек", "точек")}`,
    "Онлайн-запись и календарь мастеров",
    "Подтверждения и напоминания клиентам",
  ];
  if (f.analytics_advanced) lines.push("Аналитика: воронка, неявки, загрузка мастеров");
  else lines.push("Базовая статистика записей");
  if (f.reactivation) lines.push("Автоматический возврат молчащих клиентов");
  if (f.sales_mode) lines.push("Режим продаж ассистента");
  if (f.prepayment) lines.push("Предоплата за запись");
  if (f.export) lines.push("Выгрузка данных");
  lines.push(
    f.support === "dedicated"
      ? "Персональный менеджер"
      : f.support === "priority"
        ? "Приоритетная поддержка"
        : "Поддержка в рабочее время",
  );
  return lines;
}

function round(n: number): number {
  return Math.round(n);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("ru-RU").format(n);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
