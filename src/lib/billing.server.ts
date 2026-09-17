// Биллинг на сервере: состояние салона, учёт расхода, оплата, жизненный цикл подписки.
//
// РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ:
//   billing-logic.ts      — решения (что делать), чистые функции, покрыты тестами;
//   freedompay.server.ts  — разговор со шлюзом;
//   этот файл             — исполнение решений: база, списания, уведомления владельцу.
//
// ТРИ СПОСОБА ОПЛАТЫ СЧЁТА (metadata.via):
//   checkout  — владелец платит на форме шлюза, карта запоминается;
//   recurring — списание с сохранённой карты без владельца (продление, пакеты, доплаты);
//   manual    — перевод на счёт, владелец платформы отмечает оплату в админке. Работает без шлюза.
// Повторные попытки и отсрочку запускает только recurring: неудача на форме — это владелец,
// который сидит перед экраном и может попробовать другую карту, а не просроченный платёж.
//
// ПРАВИЛО ОТКАЗА. Любая ошибка биллинга при обслуживании клиента салона — fail-open: ассистент
// отвечает, запись создаётся, ошибка пишется в журнал. Ошибка в нашем учёте не должна оставлять
// клиента салона без ответа. Строго закрыто только одно — салон, который мы САМИ пометили
// заблокированным за неоплату.
import {
  addMonths,
  daysWord,
  planDisplayName,
  decidePlanChange,
  normalizeConfig,
  nextLifecycleAction,
  type BillingConfig,
  type BillingState,
  type Plan,
  type PlanFeatures,
  type Subscription,
} from "@/lib/billing-logic";
import { paymentProvider } from "@/lib/payment-provider.server";

export type { BillingState };

const DAY = 24 * 3600 * 1000;
const iso = (v: string | Date) => new Date(v).toISOString();

async function db(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

export function appBaseUrl(): string {
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || "https://qabyl.com";
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

export async function loadPlans(onlyPublic = false): Promise<Plan[]> {
  const sb = await db();
  let q = sb.from("billing_plans").select("*").eq("is_active", true).order("sort_order");
  if (onlyPublic) q = q.eq("is_public", true);
  const { data } = await q;
  return ((data ?? []) as Plan[]).map((plan) => ({ ...plan, name: planDisplayName(plan) }));
}

export async function loadConfig(): Promise<BillingConfig> {
  const sb = await db();
  const { data } = await sb.from("billing_settings").select("config").eq("id", true).maybeSingle();
  return normalizeConfig(data?.config);
}

export async function loadSubscription(salonId: string): Promise<Subscription | null> {
  const sb = await db();
  const { data } = await sb
    .from("salon_subscriptions")
    .select("*")
    .eq("salon_id", salonId)
    .maybeSingle();
  return (data ?? null) as Subscription | null;
}

export async function getBillingState(salonId: string): Promise<BillingState | null> {
  const sb = await db();
  const { data, error } = await sb.rpc("billing_salon_state", { _salon_id: salonId });
  if (error) {
    console.error(`[billing] state ${salonId}: ${error.message}`);
    return null;
  }
  return (data ?? null) as BillingState | null;
}

/** Сколько филиалов и каналов связи у салона сейчас. */
export async function currentFootprint(
  salonId: string,
): Promise<{ branches: number; channels: number; wa: boolean; ig: boolean }> {
  const sb = await db();
  const [{ count: branches }, { data: secrets }, { data: salon }] = await Promise.all([
    sb.from("branches").select("id", { count: "exact", head: true }).eq("salon_id", salonId),
    sb
      .from("salon_secrets")
      .select("whatsapp_cloud_phone_number_id, whatsapp_cloud_token, instagram_token")
      .eq("salon_id", salonId)
      .maybeSingle(),
    sb.from("salons").select("instagram_enabled").eq("id", salonId).maybeSingle(),
  ]);
  const wa = Boolean(secrets?.whatsapp_cloud_phone_number_id && secrets?.whatsapp_cloud_token);
  const ig = Boolean(salon?.instagram_enabled && secrets?.instagram_token);
  return { branches: branches ?? 0, channels: (wa ? 1 : 0) + (ig ? 1 : 0), wa, ig };
}

function meteringAvailable(): boolean {
  // В тестах и в локальной разработке ключа service-role нет: биллинг молча выключен, а не падает
  // вместе с отправкой сообщения.
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Входит ли функция в тариф салона. Ошибка чтения — да (fail-open). */
export async function salonHasFeature(
  salonId: string,
  feature: keyof PlanFeatures,
): Promise<boolean> {
  if (!meteringAvailable()) return true;
  try {
    const state = await getBillingState(salonId);
    if (!state?.has_subscription || state.exempt || !state.features) return true;
    if (state.blocked) return false;
    return Boolean(state.features[feature]);
  } catch {
    return true;
  }
}

/**
 * Проверка перед подключением канала связи. Бросает ошибку словами владельца.
 * Переподключение уже подключённого канала лимит не расходует.
 */
export async function assertCanAddChannel(salonId: string, channel: "wa" | "ig"): Promise<void> {
  if (!meteringAvailable()) return;
  const state = await getBillingState(salonId);
  if (!state?.has_subscription || state.exempt) return;
  if (state.blocked) {
    throw new Error(
      "Кабинет приостановлен: подписка Qabyl не оплачена. Оплатите тариф в разделе «Тариф и оплата».",
    );
  }
  const limit = state.limits?.channels;
  if (!limit) return;
  const fp = await currentFootprint(salonId);
  const already = channel === "wa" ? fp.wa : fp.ig;
  if (!already && fp.channels >= limit) {
    throw new Error(
      `На тарифе ${state.plan_name} ${limit === 1 ? "один канал связи" : `до ${limit} каналов связи`}. Чтобы подключить ещё один, перейдите на тариф выше в разделе «Тариф и оплата».`,
    );
  }
}

// ---------------------------------------------------------------------------
// Учёт расхода
// ---------------------------------------------------------------------------

export async function recordUsage(salonId: string, metric: string, qty = 1): Promise<void> {
  if (!meteringAvailable() || !salonId || qty <= 0) return;
  try {
    const sb = await db();
    await sb.rpc("billing_record_usage", { _salon_id: salonId, _metric: metric, _qty: qty });
  } catch (e) {
    console.error(`[billing] usage ${metric} ${salonId}: ${(e as Error).message}`);
  }
}

export async function recordWaUsageByPhone(phoneNumberId: string, qty = 1): Promise<void> {
  if (!meteringAvailable() || !phoneNumberId) return;
  try {
    const sb = await db();
    await sb.rpc("billing_record_wa_usage", { _phone_number_id: phoneNumberId, _qty: qty });
  } catch (e) {
    console.error(`[billing] wa usage ${phoneNumberId}: ${(e as Error).message}`);
  }
}

export async function recordIgUsageByAccount(igUserId: string, qty = 1): Promise<void> {
  if (!meteringAvailable() || !igUserId) return;
  try {
    const sb = await db();
    await sb.rpc("billing_record_ig_usage", { _instagram_user_id: igUserId, _qty: qty });
  } catch (e) {
    console.error(`[billing] ig usage ${igUserId}: ${(e as Error).message}`);
  }
}

export async function logBillingEvent(
  salonId: string | null,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    const sb = await db();
    await sb.from("billing_events").insert({ salon_id: salonId, type, payload });
  } catch {
    /* журнал не обязан работать, чтобы работала оплата */
  }
}

/** Уведомление владельцу в колокольчик. Дедуп — по событию в журнале. */
async function notifyOwnerOnce(
  salonId: string,
  dedupKey: string,
  title: string,
  body: string,
): Promise<void> {
  const sb = await db();
  const { data: seen } = await sb
    .from("billing_events")
    .select("id")
    .eq("salon_id", salonId)
    .eq("type", "notify")
    .eq("payload->>key", dedupKey)
    .limit(1);
  if (seen && seen.length) return;
  await sb.from("notifications").insert({ salon_id: salonId, type: "billing", title, body });
  await logBillingEvent(salonId, "notify", { key: dedupKey, title });
}

// ---------------------------------------------------------------------------
// Ворота ассистента
// ---------------------------------------------------------------------------

/**
 * Можно ли ассистенту отвечать клиентам этого салона.
 *
 * Порядок: освобождённый — всегда да; заблокированный за неоплату — нет; лимит исчерпан — пробуем
 * автодокупку и пускаем, если она прошла. Любая ошибка учёта — да (см. шапку файла).
 */
export async function assistantGate(
  salonId: string,
): Promise<{ allowed: boolean; reason?: string; features?: PlanFeatures }> {
  if (!meteringAvailable()) return { allowed: true };
  try {
    const state = await getBillingState(salonId);
    if (!state || !state.has_subscription || state.exempt) return { allowed: true };
    if (state.blocked) return { allowed: false, reason: "подписка Qabyl не оплачена" };
    if (state.auto_topup && paymentProvider()?.capabilities.recurring) {
      await buyPack(salonId, "auto");
    }
    if (!state.assistant_paused) return { allowed: true, features: state.features };

    if (state.auto_topup) {
      const res = await buyPack(salonId, "auto");
      if (res.ok && !res.redirectUrl) return { allowed: true, features: state.features };
    }
    await notifyOwnerOnce(
      salonId,
      `limit:${state.period_start}`,
      "Сообщения ассистента закончились",
      "Ассистент перестал отвечать клиентам до конца месяца. Докупите пакет сообщений или перейдите на тариф выше — ответы возобновятся сразу.",
    );
    return { allowed: false, reason: "лимит сообщений тарифа исчерпан" };
  } catch (e) {
    console.error(`[billing] gate ${salonId}: ${(e as Error).message}`);
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Счета
// ---------------------------------------------------------------------------

type InvoiceKind = "subscription" | "overage_pack" | "proration" | "card_check";

async function createInvoice(
  salonId: string,
  p: {
    kind: InvoiceKind;
    amountKgs: number;
    provider?: string;
    planCode?: string | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const sb = await db();
  const { data, error } = await sb.rpc("billing_reserve_invoice", {
    _salon_id: salonId,
    _invoice: {
      kind: p.kind,
      amount_kgs: p.amountKgs,
      provider: p.provider ?? "freedompay",
      plan_code: p.planCode ?? null,
      period_start: p.periodStart?.toISOString() ?? null,
      period_end: p.periodEnd?.toISOString() ?? null,
      metadata: p.metadata ?? {},
    },
  });
  if (error) throw new Error(error.message);
  return { id: data as string };
}

/**
 * С какой даты начнётся следующий оплаченный месяц.
 *
 * В пробном периоде — с его конца: оплата заранее не съедает бесплатные дни. У активного — с конца
 * текущего месяца. Уже оплаченные вперёд месяцы пропускаются, поэтому две оплаты подряд дают два
 * месяца подряд, а не два счёта за один и тот же месяц.
 */
async function nextUnpaidPeriodStart(salonId: string, sub: Subscription, now: Date): Promise<Date> {
  let start = now;
  if (sub.status === "trialing" && sub.trial_ends_at && new Date(sub.trial_ends_at) > now) {
    start = new Date(sub.trial_ends_at);
  } else if (
    sub.status === "active" &&
    sub.current_period_end &&
    new Date(sub.current_period_end) > now
  ) {
    start = new Date(sub.current_period_end);
  }
  const sb = await db();
  for (let i = 0; i < 24; i++) {
    const { data } = await sb
      .from("billing_invoices")
      .select("period_end")
      .eq("salon_id", salonId)
      .eq("kind", "subscription")
      .eq("status", "paid")
      .eq("period_start", start.toISOString())
      .limit(1);
    if (!data?.length || !data[0].period_end) break;
    start = new Date(data[0].period_end);
  }
  return start;
}

function activationPatch(planCode: string, start: Date, end: Date) {
  return {
    plan_code: planCode,
    status: "active",
    current_period_start: start.toISOString(),
    current_period_end: end.toISOString(),
    pending_plan_code: null,
    grace_until: null,
    last_payment_error: null,
    cancel_at_period_end: false,
  };
}

/**
 * Оплата через форму Freedom Pay. Возвращает ссылку, на которую отправить владельца.
 * Карта при этом запоминается для автопродления.
 */
export async function startCheckout(
  salonId: string,
  p: {
    kind: InvoiceKind;
    amountKgs: number;
    description: string;
    planCode?: string | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    metadata?: Record<string, unknown>;
    userId: string;
    email?: string | null;
  },
): Promise<{ redirectUrl: string; invoiceId: string }> {
  const cfg = paymentProvider();
  if (!cfg) {
    throw new Error(
      "Оплата картой ещё не подключена. Чтобы оплатить или сменить тариф, напишите в поддержку — оформим переводом.",
    );
  }
  const base = appBaseUrl();
  if (new URL(base).protocol !== "https:")
    throw new Error("Оплата требует защищённого адреса сайта");
  const invoice = await createInvoice(salonId, {
    ...p,
    metadata: { ...(p.metadata ?? {}), via: "checkout" },
  });
  const res = await cfg.createPayment({
    orderId: invoice.id,
    amountKgs: p.amountKgs,
    description: p.description,
    userId: salonId,
    email: p.email,
    resultUrl: `${base}/api/public/billing/freedompay`,
    successUrl: `${base}/admin/billing?payment=success`,
    failureUrl: `${base}/admin/billing?payment=failed`,
    recurring: false,
  });

  const sb = await db();
  if (!res.ok) {
    await sb
      .from("billing_invoices")
      .update({
        last_error: "Ожидаем подтверждение банка. Не повторяйте оплату.",
        attempts: 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoice.id)
      .eq("status", "pending");
    throw new Error(
      "Не удалось получить ответ банка. Проверьте историю оплаты перед повторной попыткой.",
    );
  }
  await sb
    .from("billing_invoices")
    .update({
      provider_payment_id: res.paymentId || null,
      checkout_url: res.redirectUrl,
      attempts: 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoice.id);
  await logBillingEvent(salonId, "checkout_started", {
    invoiceId: invoice.id,
    kind: p.kind,
    amount: p.amountKgs,
  });
  return { redirectUrl: res.redirectUrl, invoiceId: invoice.id };
}

/**
 * Списание с сохранённой карты без участия владельца.
 *
 * ok: true означает, что шлюз ПРИНЯЛ списание синхронно. Если подтверждение придёт только
 * уведомлением, счёт остаётся pending, а повтор не делается до next_attempt_at — двойного
 * списания за один период не будет.
 */
export async function chargeSavedCard(
  salonId: string,
  invoiceId: string,
  amountKgs: number,
  description: string,
): Promise<{ ok: boolean; error?: string }> {
  const provider = paymentProvider();
  if (!provider?.capabilities.recurring)
    return { ok: false, error: "Автоматические списания пока недоступны" };
  const sb = await db();
  const { data: claimed, error } = await sb.rpc("billing_claim_dispatch", {
    _salon_id: salonId,
    _id: invoiceId,
  });
  if (error) throw new Error("Не удалось проверить состояние оплаты");
  if (!claimed) return { ok: false, error: "Операция уже отправлена или отменена" };
  const { data: invoice, error: invoiceError } = await sb
    .from("billing_invoices")
    .select("amount_kgs")
    .eq("id", invoiceId)
    .eq("salon_id", salonId)
    .single();
  const { data: method, error: methodError } = await sb
    .from("billing_payment_methods")
    .select("card_token, recurring_profile_id")
    .eq("salon_id", salonId)
    .single();
  if (invoiceError || methodError) throw new Error("Не удалось подготовить оплату");
  // No network retries after dispatch. A timeout requires status reconciliation.
  await provider.chargeSavedMethod({
    invoiceId,
    salonId,
    amountKgs: invoice.amount_kgs,
    description,
    method,
  });
  return { ok: false, error: "Ожидаем подтверждение банка" };
}

/**
 * Проводит оплаченный счёт. Идемпотентно: повторное уведомление ничего не меняет.
 *
 * Месяц, оплаченный вперёд (в пробном периоде или до конца текущего), не включается сразу —
 * его включит ежечасный цикл в день начала. Иначе оплата заранее обнулила бы счётчик сообщений
 * посреди текущего месяца и съела бы бесплатные дни.
 */
export async function applyPaidInvoice(
  invoiceId: string,
  info: {
    paymentId?: string | null;
    cardMask?: string | null;
    cardToken?: string | null;
    recurringProfileId?: string | null;
  },
): Promise<void> {
  const sb = await db();
  const { error } = await sb.rpc("billing_settle_invoice", { _id: invoiceId, _info: info });
  if (error) throw new Error("Не удалось подтвердить оплату в базе");
}

/** Уведомление Freedom Pay о результате платежа. Подпись уже проверена маршрутом. */
export async function handleFreedomPayResult(
  params: Record<string, string>,
): Promise<{ status: "ok" | "rejected"; description: string }> {
  const sb = await db();
  const orderId = params.pg_order_id ?? "";
  const { data: inv, error: invoiceError } = await sb
    .from("billing_invoices")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (invoiceError) throw new Error("Payment invoice read failed");
  if (!inv) return { status: "rejected", description: "Неизвестный заказ" };

  const provider = paymentProvider(true);
  if (!provider) throw new Error("Payments unavailable");
  const event = provider.normalizeEvent(params, inv);
  if (!event) return { status: "rejected", description: "Payment details mismatch" };
  const { error } = await sb.rpc("billing_receive_event", {
    _id: inv.id,
    _key: event.key,
    _outcome: event.outcome,
    _info: event.info,
  });
  if (error) throw new Error("Payment event transaction failed");
  return { status: "ok", description: "Принято" };
}

// ---------------------------------------------------------------------------
// Действия владельца
// ---------------------------------------------------------------------------

/**
 * Пакет сообщений. auto — из ворот ассистента, без владельца, только с сохранённой карты.
 * manual — из кабинета: с картой списываем сразу, без карты отправляем на форму оплаты.
 */
export async function buyPack(
  salonId: string,
  source: "auto" | "manual",
  who?: { userId: string; email?: string | null },
): Promise<{ ok: boolean; redirectUrl?: string; error?: string }> {
  if (source === "auto") {
    if (!paymentProvider()?.capabilities.recurring)
      return { ok: false, error: "Автопополнение пока недоступно" };
    const sb = await db();
    const { data: id, error } = await sb.rpc("billing_reserve_topup", { _salon_id: salonId });
    if (error) throw new Error("Не удалось подготовить пополнение");
    if (!id) return { ok: false, error: "Покупка не требуется или уже обрабатывается" };
    return chargeSavedCard(salonId, id, 0, "Qabyl: автопополнение сообщений");
  }
  const sb = await db();
  const sub = await loadSubscription(salonId);
  if (!sub) return { ok: false, error: "нет подписки" };
  const plan = (await loadPlans()).find((p) => p.code === sub.plan_code);
  if (!plan) return { ok: false, error: "тариф не найден" };
  const messages = plan.limits.overage_pack_messages;
  const price = plan.limits.overage_pack_price_kgs;

  const description = `Qabyl: пакет ${messages} сообщений`;
  if (!who) return { ok: false, error: "Войдите в кабинет для оплаты" };
  const { redirectUrl } = await startCheckout(salonId, {
    kind: "overage_pack",
    amountKgs: price,
    description,
    metadata: { messages, source },
    userId: who.userId,
    email: who.email,
  });
  return { ok: true, redirectUrl };
}

/** Смена тарифа из кабинета. Возвращает ссылку на оплату, если нужна доплата без сохранённой карты. */
export async function changePlan(
  salonId: string,
  planCode: string,
  who: { userId: string; email?: string | null },
): Promise<{ result: string; redirectUrl?: string }> {
  const sb = await db();
  const sub = await loadSubscription(salonId);
  if (!sub) throw new Error("У салона нет подписки");
  const plans = await loadPlans();
  const from = plans.find((p) => p.code === sub.plan_code);
  const to = plans.find((p) => p.code === planCode);
  if (!from || !to) throw new Error("Тариф не найден");

  const decision = decidePlanChange(sub, from, to, await currentFootprint(salonId), new Date());
  const now = new Date();

  switch (decision.kind) {
    case "same":
      return { result: "same" };
    case "blocked":
      throw new Error(decision.reason);
    case "trial_switch":
      await sb
        .from("salon_subscriptions")
        .update({
          plan_code: to.code,
          trial_ends_at: decision.trialEndsAt.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq("salon_id", salonId);
      await logBillingEvent(salonId, "plan_changed", {
        from: from.code,
        to: to.code,
        during: "trial",
      });
      return { result: "trial_switch" };
    case "downgrade_at_period_end":
      await sb
        .from("salon_subscriptions")
        .update({ pending_plan_code: to.code, updated_at: now.toISOString() })
        .eq("salon_id", salonId);
      await logBillingEvent(salonId, "downgrade_scheduled", { from: from.code, to: to.code });
      return { result: "downgrade_scheduled" };
    case "upgrade_now": {
      if (decision.chargeKgs === 0) {
        await sb
          .from("salon_subscriptions")
          .update({ plan_code: to.code, pending_plan_code: null })
          .eq("salon_id", salonId);
        return { result: "upgraded" };
      }
      const description = `Qabyl: переход на ${to.name}`;
      const { redirectUrl } = await startCheckout(salonId, {
        kind: "proration",
        amountKgs: decision.chargeKgs,
        description,
        planCode: to.code,
        ...who,
      });
      return { result: "checkout", redirectUrl };
    }
    case "new_period": {
      const { redirectUrl } = await startCheckout(salonId, {
        kind: "subscription",
        amountKgs: decision.chargeKgs,
        description: `Qabyl ${to.name}: 1 месяц`,
        planCode: to.code,
        periodStart: now,
        periodEnd: addMonths(now, 1),
        ...who,
      });
      return { result: "checkout", redirectUrl };
    }
  }
}

/** «Оплатить» из кабинета: следующий неоплаченный месяц, погашение долга, привязка карты. */
export async function payNow(
  salonId: string,
  who: { userId: string; email?: string | null },
): Promise<{ redirectUrl: string }> {
  const sub = await loadSubscription(salonId);
  if (!sub) throw new Error("У салона нет подписки");
  const plans = await loadPlans();
  const plan = plans.find((p) => p.code === (sub.pending_plan_code ?? sub.plan_code));
  if (!plan) throw new Error("Тариф не найден");

  const start = await nextUnpaidPeriodStart(salonId, sub, new Date());
  return startCheckout(salonId, {
    kind: "subscription",
    amountKgs: plan.price_kgs,
    description: `Qabyl ${plan.name}: 1 месяц`,
    planCode: plan.code,
    periodStart: start,
    periodEnd: addMonths(start, 1),
    ...who,
  });
}

/**
 * Оплата переводом, отмеченная владельцем платформы. Работает без платёжного шлюза.
 *
 * Счёт создаётся уже оплаченным и проводится тем же путём, что оплата картой: подписка, отсрочка
 * и блокировка ведут себя одинаково, откуда бы ни пришли деньги.
 */
export async function recordManualPayment(
  salonId: string,
  p: {
    kind: "subscription" | "overage_pack";
    months?: number;
    planCode?: string | null;
    amountKgs?: number | null;
    note?: string | null;
    by: string;
  },
): Promise<{ invoiceId: string; periodStart?: string; periodEnd?: string }> {
  const sub = await loadSubscription(salonId);
  if (!sub) throw new Error("У салона нет подписки");
  const plans = await loadPlans();

  if (p.kind === "overage_pack") {
    const plan = plans.find((x) => x.code === sub.plan_code);
    if (!plan) throw new Error("Тариф не найден");
    const inv = await createInvoice(salonId, {
      kind: "overage_pack",
      provider: "manual",
      amountKgs: p.amountKgs ?? plan.limits.overage_pack_price_kgs,
      metadata: {
        messages: plan.limits.overage_pack_messages,
        via: "manual",
        note: p.note ?? null,
        by: p.by,
      },
    });
    await applyPaidInvoice(inv.id, {});
    return { invoiceId: inv.id };
  }

  const plan = plans.find((x) => x.code === (p.planCode || sub.pending_plan_code || sub.plan_code));
  if (!plan) throw new Error("Тариф не найден");
  const months = Math.min(Math.max(Math.round(p.months ?? 1), 1), 12);
  const start = await nextUnpaidPeriodStart(salonId, sub, new Date());
  const end = addMonths(start, months);
  const inv = await createInvoice(salonId, {
    kind: "subscription",
    provider: "manual",
    amountKgs: p.amountKgs ?? plan.price_kgs * months,
    planCode: plan.code,
    periodStart: start,
    periodEnd: end,
    metadata: { via: "manual", months, note: p.note ?? null, by: p.by },
  });
  await applyPaidInvoice(inv.id, {});
  await logBillingEvent(salonId, "manual_payment", {
    invoiceId: inv.id,
    plan: plan.code,
    months,
    by: p.by,
  });
  return { invoiceId: inv.id, periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

// ---------------------------------------------------------------------------
// Ежечасный цикл
// ---------------------------------------------------------------------------

export async function runBillingCycle(now = new Date()): Promise<{
  checked: number;
  charged: number;
  renewedPrepaid: number;
  pastDue: number;
  suspended: number;
  canceled: number;
  retried: number;
  warned: number;
}> {
  const report = {
    checked: 0,
    charged: 0,
    renewedPrepaid: 0,
    pastDue: 0,
    suspended: 0,
    canceled: 0,
    retried: 0,
    warned: 0,
  };
  if (!meteringAvailable()) return report;

  const sb = await db();
  await reconcilePendingPayments();
  const cfg = await loadConfig();
  // Биллинг выключен для всех: никого не переводим в «нужна оплата» и не блокируем.
  if (cfg.enforcement_enabled === false) return report;
  const plans = new Map((await loadPlans()).map((p) => [p.code, p]));
  const { data: subs } = await sb.from("salon_subscriptions").select("*").limit(2000);
  const { data: methods } = await sb
    .from("billing_payment_methods")
    .select("salon_id")
    .not("recurring_profile_id", "is", null);
  const withCard = new Set<string>(); // Recurring capability is unavailable until bank certification.

  // Месяцы, оплаченные вперёд (переводом или картой заранее): включаются в день начала.
  const { data: prepaidRows } = await sb
    .from("billing_invoices")
    .select("id, salon_id, plan_code, period_start, period_end")
    .eq("kind", "subscription")
    .eq("status", "paid")
    .gt("period_end", now.toISOString())
    .not("period_start", "is", null);
  const prepaid = new Map<string, any>();
  for (const r of prepaidRows ?? []) prepaid.set(`${r.salon_id}|${iso(r.period_start)}`, r);

  for (const sub of (subs ?? []) as Subscription[]) {
    report.checked++;
    try {
      const action = nextLifecycleAction(sub, plans, cfg, now, withCard.has(sub.salon_id));

      const dueAt =
        sub.status === "trialing"
          ? sub.trial_ends_at
          : sub.status === "active"
            ? sub.current_period_end
            : null;
      const paidInv = dueAt ? prepaid.get(`${sub.salon_id}|${iso(dueAt)}`) : undefined;
      if (paidInv && (action.type === "charge_period" || action.type === "to_past_due")) {
        await sb
          .from("salon_subscriptions")
          .update({
            ...activationPatch(
              paidInv.plan_code,
              new Date(paidInv.period_start),
              new Date(paidInv.period_end),
            ),
            updated_at: now.toISOString(),
          })
          .eq("salon_id", sub.salon_id);
        await logBillingEvent(sub.salon_id, "prepaid_period_started", { invoiceId: paidInv.id });
        report.renewedPrepaid++;
        continue;
      }

      switch (action.type) {
        case "charge_period": {
          // Один счёт автопродления на период. Брошенная форма оплаты за тот же месяц списанию
          // не мешает — её счёт не recurring.
          const { data: existing } = await sb
            .from("billing_invoices")
            .select("id")
            .eq("salon_id", sub.salon_id)
            .eq("kind", "subscription")
            .eq("period_start", action.periodStart.toISOString())
            .or("status.eq.paid,and(status.eq.pending,metadata->>via.eq.recurring)")
            .limit(1);
          if (existing && existing.length) break;
          const plan = plans.get(action.planCode)!;
          const inv = await createInvoice(sub.salon_id, {
            kind: "subscription",
            amountKgs: action.amountKgs,
            planCode: action.planCode,
            periodStart: action.periodStart,
            periodEnd: action.periodEnd,
          });
          const res = await chargeSavedCard(
            sub.salon_id,
            inv.id,
            action.amountKgs,
            `Qabyl ${plan.name}: 1 месяц`,
          );
          if (res.ok) report.charged++;
          break;
        }
        case "to_past_due":
          await sb
            .from("salon_subscriptions")
            .update({
              status: "past_due",
              grace_until: action.graceUntil.toISOString(),
              last_payment_error: action.reason,
              updated_at: now.toISOString(),
            })
            .eq("salon_id", sub.salon_id);
          await notifyOwnerOnce(
            sub.salon_id,
            `past_due:${sub.trial_ends_at ?? sub.current_period_end}`,
            "Нужна оплата Qabyl",
            `${action.reason}. Оплатите до ${action.graceUntil.toLocaleDateString("ru-RU")} — иначе онлайн-запись и ассистент будут приостановлены.`,
          );
          report.pastDue++;
          break;
        case "suspend":
          await sb
            .from("salon_subscriptions")
            .update({ status: "suspended", updated_at: now.toISOString() })
            .eq("salon_id", sub.salon_id);
          await notifyOwnerOnce(
            sub.salon_id,
            `suspended:${sub.grace_until}`,
            "Кабинет приостановлен",
            "Оплата не поступила. Онлайн-запись и ассистент остановлены. Оплатите тариф — всё заработает сразу, данные сохранены.",
          );
          await logBillingEvent(sub.salon_id, "suspended", {});
          report.suspended++;
          break;
        case "cancel":
          await sb
            .from("salon_subscriptions")
            .update({ status: "canceled", updated_at: now.toISOString() })
            .eq("salon_id", sub.salon_id);
          await logBillingEvent(sub.salon_id, "canceled", {});
          report.canceled++;
          break;
        default:
          break;
      }

      // Напоминания об оплате. Пока нет автосписания, это единственное, что стоит между салоном
      // и «внезапно всё отключилось»: заплатить он может только руками и только если помнит.
      // Уведомление само уходит в push — на notifications висит триггер notifications_dispatch_push.
      if (!sub.billing_exempt && !sub.cancel_at_period_end && !withCard.has(sub.salon_id)) {
        const price = plans.get(sub.plan_code)?.price_kgs ?? null;
        const priceHint = price ? ` Сумма — ${price.toLocaleString("ru-RU")} сом.` : "";

        if (sub.status === "trialing" && sub.trial_ends_at) {
          const left = new Date(sub.trial_ends_at).getTime() - now.getTime();
          if (left > 0 && left <= cfg.trial_warn_days * DAY) {
            await notifyOwnerOnce(
              sub.salon_id,
              `trial_warn:${sub.trial_ends_at}`,
              "Пробный период скоро закончится",
              `Осталось ${daysWord(left)}.${priceHint} Откройте «Подписка и оплата» и оплатите тариф, чтобы ассистент и онлайн-запись работали без перерыва.`,
            );
            report.warned++;
          }
        }

        if (sub.status === "active" && sub.current_period_end) {
          const left = new Date(sub.current_period_end).getTime() - now.getTime();
          if (left > 0 && left <= cfg.renewal_warn_days * DAY) {
            await notifyOwnerOnce(
              sub.salon_id,
              `renewal_warn:${sub.current_period_end}`,
              "Пора продлить подписку",
              `Оплаченный месяц заканчивается через ${daysWord(left)}.${priceHint} Автосписания нет — откройте «Подписка и оплата» и оплатите, иначе ассистент перестанет отвечать клиентам.`,
            );
            report.warned++;
          }
        }
      }
    } catch (e) {
      console.error(`[billing] cycle ${sub.salon_id}: ${(e as Error).message}`);
    }
  }

  // Dispatch is single-use. Uncertain outcomes require bank reconciliation, never another debit.
  const { data: retries } = await sb
    .from("billing_invoices")
    .select("*")
    .eq("status", "pending")
    .not("next_attempt_at", "is", null)
    .lte("next_attempt_at", now.toISOString())
    .limit(200);
  for (const inv of retries ?? []) {
    const res = await chargeSavedCard(
      inv.salon_id,
      inv.id,
      inv.amount_kgs,
      `Qabyl: повтор списания`,
    );
    report.retried++;
    if (res.ok) report.charged++;
  }

  // Pending payments are reconciled with the bank; never expire a dispatched charge by age.
  // Расход ≥ порога предупреждения — одно уведомление на период.
  for (const sub of (subs ?? []) as Subscription[]) {
    if (sub.billing_exempt) continue;
    const state = await getBillingState(sub.salon_id);
    // На безлимите (allowance = −1) предупреждать не о чем.
    if (!state?.has_subscription || !state.messages_allowance) continue;
    if (state.messages_allowance < 0) continue;
    if ((state.usage_pct ?? 0) >= cfg.usage_warn_pct && !state.assistant_paused) {
      await notifyOwnerOnce(
        sub.salon_id,
        `usage_warn:${state.period_start}`,
        `Израсходовано ${state.usage_pct}% сообщений`,
        `Использовано ${state.messages_used} из ${state.messages_allowance}. Когда сообщения закончатся, ассистент перестанет отвечать до конца месяца${state.auto_topup ? ", если не пройдёт автодокупка" : ""}.`,
      );
      report.warned++;
    }
  }

  return report;
}

/** Read-only bank reconciliation; a delayed notification must never cause a second charge. */
export async function reconcilePendingPayments(): Promise<void> {
  const provider = paymentProvider(true);
  if (!provider) return;
  const sb = await db();
  const { data: invoices, error } = await sb
    .from("billing_invoices")
    .select("id, provider_payment_id, salon_id")
    .eq("provider", "freedompay")
    .eq("status", "pending")
    .lt("created_at", new Date(Date.now() - 60_000).toISOString())
    .order("created_at")
    .limit(20);
  if (error) throw new Error("Payment reconciliation read failed");
  for (const invoice of invoices ?? []) {
    const result = await provider.getPaymentStatus({
      paymentId: invoice.provider_payment_id ?? undefined,
      orderId: invoice.id,
    });
    if (!result.ok || !result.paid) continue;
    // The signed status response must identify this payment and its currency explicitly.
    if (!result.raw.pg_currency || result.raw.pg_captured === "0") continue;
    await handleFreedomPayResult({
      ...result.raw,
      pg_order_id: result.raw.pg_order_id || invoice.id,
      pg_result: "1",
    });
  }
}
