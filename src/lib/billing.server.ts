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
  decidePlanChange,
  normalizeConfig,
  nextLifecycleAction,
  type BillingConfig,
  type BillingState,
  type Plan,
  type PlanFeatures,
  type Subscription,
} from "@/lib/billing-logic";
import { freedomPayConfig, fpChargeRecurring, fpInitPayment } from "@/lib/freedompay.server";

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
  return (data ?? []) as Plan[];
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
  const { data, error } = await sb
    .from("billing_invoices")
    .insert({
      salon_id: salonId,
      kind: p.kind,
      amount_kgs: p.amountKgs,
      provider: p.provider ?? "freedompay",
      plan_code: p.planCode ?? null,
      period_start: p.periodStart?.toISOString() ?? null,
      period_end: p.periodEnd?.toISOString() ?? null,
      metadata: p.metadata ?? {},
    })
    .select("id")
    .single();
  if (error) throw new Error(`Не удалось создать счёт: ${error.message}`);
  return data as { id: string };
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
  const cfg = freedomPayConfig();
  if (!cfg) {
    throw new Error(
      "Оплата картой ещё не подключена. Чтобы оплатить или сменить тариф, напишите в поддержку — оформим переводом.",
    );
  }
  const invoice = await createInvoice(salonId, {
    ...p,
    metadata: { ...(p.metadata ?? {}), via: "checkout" },
  });
  const base = appBaseUrl();
  const res = await fpInitPayment(cfg, {
    orderId: invoice.id,
    amountKgs: p.amountKgs,
    description: p.description,
    userId: p.userId,
    email: p.email,
    resultUrl: `${base}/api/public/billing/freedompay`,
    successUrl: `${base}/admin/billing?payment=success`,
    failureUrl: `${base}/admin/billing?payment=failed`,
    recurring: true,
  });

  const sb = await db();
  if (!res.ok) {
    await sb
      .from("billing_invoices")
      .update({
        status: "failed",
        last_error: res.error,
        attempts: 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoice.id);
    throw new Error(`Не удалось открыть оплату: ${res.error}`);
  }
  await sb
    .from("billing_invoices")
    .update({
      provider_payment_id: res.paymentId || null,
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
  const cfg = freedomPayConfig();
  if (!cfg) return { ok: false, error: "оплата картой не подключена" };
  const sb = await db();
  const { data: pm } = await sb
    .from("billing_payment_methods")
    .select("recurring_profile_id")
    .eq("salon_id", salonId)
    .maybeSingle();
  if (!pm?.recurring_profile_id) return { ok: false, error: "карта не привязана" };

  const conf = await loadConfig();
  const { data: inv } = await sb
    .from("billing_invoices")
    .select("attempts, metadata")
    .eq("id", invoiceId)
    .single();
  const attempts = (inv?.attempts ?? 0) + 1;
  await sb
    .from("billing_invoices")
    .update({ metadata: { ...(inv?.metadata ?? {}), via: "recurring" } })
    .eq("id", invoiceId);

  const res = await fpChargeRecurring(cfg, {
    recurringProfileId: pm.recurring_profile_id,
    orderId: invoiceId,
    amountKgs,
    description,
    resultUrl: `${appBaseUrl()}/api/public/billing/freedompay`,
  });

  if (!res.ok) {
    await markInvoiceFailed(invoiceId, res.error, attempts, conf);
    return { ok: false, error: res.error };
  }

  const st = res.status.toLowerCase();
  if (st === "success" || st === "ok") {
    await applyPaidInvoice(invoiceId, { paymentId: res.paymentId });
    return { ok: true };
  }
  // Принято, но не подтверждено — ждём уведомления. Следующая попытка не раньше чем через сутки.
  await sb
    .from("billing_invoices")
    .update({
      provider_payment_id: res.paymentId || null,
      attempts,
      next_attempt_at: new Date(Date.now() + DAY).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);
  return { ok: false, error: "ожидает подтверждения банка" };
}

async function markInvoiceFailed(
  invoiceId: string,
  error: string,
  attempts: number,
  cfg: BillingConfig,
): Promise<void> {
  const sb = await db();
  const { data: inv } = await sb.from("billing_invoices").select("*").eq("id", invoiceId).single();
  if (!inv || inv.status === "paid") return;

  const recurring = inv.metadata?.via === "recurring";
  const retryDays = recurring ? cfg.dunning_retry_days[attempts - 1] : undefined;
  const giveUp = retryDays === undefined;
  await sb
    .from("billing_invoices")
    .update({
      status: giveUp ? "failed" : "pending",
      attempts,
      last_error: error,
      next_attempt_at: giveUp ? null : new Date(Date.now() + retryDays * DAY).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  // Отсрочку запускает только просроченное автопродление. Неудача на форме оплаты во время
  // пробного периода не должна отнимать у салона оставшиеся бесплатные дни.
  const due = inv.period_start ? new Date(inv.period_start).getTime() <= Date.now() : true;
  if (!recurring || inv.kind !== "subscription" || !due) return;

  const sub = await loadSubscription(inv.salon_id);
  if (sub && (sub.status === "active" || sub.status === "trialing")) {
    await sb
      .from("salon_subscriptions")
      .update({
        status: "past_due",
        grace_until: new Date(Date.now() + cfg.grace_days * DAY).toISOString(),
        last_payment_error: error,
        updated_at: new Date().toISOString(),
      })
      .eq("salon_id", inv.salon_id);
  }
  await notifyOwnerOnce(
    inv.salon_id,
    `payment_failed:${invoiceId}`,
    "Не удалось списать оплату Qabyl",
    `Банк отклонил списание: ${error}. Оплатите в течение ${cfg.grace_days} дн. — иначе онлайн-запись и ассистент будут приостановлены.`,
  );
  await logBillingEvent(inv.salon_id, "payment_failed", { invoiceId, error, attempts });
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
  const { data: inv } = await sb.from("billing_invoices").select("*").eq("id", invoiceId).single();
  if (!inv || inv.status === "paid") return;
  const now = new Date();

  await sb
    .from("billing_invoices")
    .update({
      status: "paid",
      paid_at: now.toISOString(),
      provider_payment_id: info.paymentId || inv.provider_payment_id,
      last_error: null,
      next_attempt_at: null,
      updated_at: now.toISOString(),
    })
    .eq("id", invoiceId);

  if (info.recurringProfileId || info.cardToken) {
    await sb.from("billing_payment_methods").upsert(
      {
        salon_id: inv.salon_id,
        provider: inv.provider,
        recurring_profile_id: info.recurringProfileId ?? null,
        card_token: info.cardToken ?? null,
        card_mask: info.cardMask ?? null,
        updated_at: now.toISOString(),
      },
      { onConflict: "salon_id" },
    );
  }

  const subPatch: Record<string, unknown> = { updated_at: now.toISOString() };
  if (info.cardMask) subPatch.card_mask = info.cardMask;

  if (inv.kind === "subscription") {
    const start = inv.period_start ? new Date(inv.period_start) : now;
    const end = inv.period_end ? new Date(inv.period_end) : addMonths(start, 1);
    const sub = await loadSubscription(inv.salon_id);
    const ahead =
      start.getTime() > now.getTime() + 60_000 &&
      (sub?.status === "trialing" || sub?.status === "active");
    if (ahead) {
      subPatch.cancel_at_period_end = false;
      subPatch.last_payment_error = null;
    } else {
      Object.assign(subPatch, activationPatch(inv.plan_code, start, end));
    }
  } else if (inv.kind === "proration") {
    subPatch.plan_code = inv.plan_code;
  } else if (inv.kind === "overage_pack") {
    const { data: period } = await sb.rpc("billing_current_period_start", {
      _salon_id: inv.salon_id,
    });
    const messages = Number(inv.metadata?.messages ?? 0);
    if (period && messages > 0) {
      await sb.from("billing_credits").insert({
        salon_id: inv.salon_id,
        period_start: period,
        messages,
        source: "pack",
        invoice_id: inv.id,
      });
    }
  }

  await sb.from("salon_subscriptions").update(subPatch).eq("salon_id", inv.salon_id);
  await logBillingEvent(inv.salon_id, "payment_succeeded", {
    invoiceId,
    kind: inv.kind,
    amount: inv.amount_kgs,
    via: inv.metadata?.via ?? null,
  });
  await sb.from("notifications").insert({
    salon_id: inv.salon_id,
    type: "billing",
    title: "Оплата прошла",
    body:
      inv.kind === "overage_pack"
        ? "Пакет сообщений добавлен — ассистент снова отвечает клиентам."
        : `Спасибо! Оплачено ${inv.amount_kgs} сом.`,
  });
}

/** Уведомление Freedom Pay о результате платежа. Подпись уже проверена маршрутом. */
export async function handleFreedomPayResult(
  params: Record<string, string>,
): Promise<{ status: "ok" | "rejected"; description: string }> {
  const sb = await db();
  const orderId = params.pg_order_id ?? "";
  const { data: inv } = await sb
    .from("billing_invoices")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (!inv) return { status: "rejected", description: "Неизвестный заказ" };

  if (params.pg_result === "1") {
    const paid = Number(params.pg_amount ?? 0);
    if (paid + 0.001 < Number(inv.amount_kgs)) {
      await logBillingEvent(inv.salon_id, "payment_amount_mismatch", {
        invoiceId: inv.id,
        paid,
        expected: inv.amount_kgs,
      });
      return { status: "rejected", description: "Сумма не совпадает со счётом" };
    }
    await applyPaidInvoice(inv.id, {
      paymentId: params.pg_payment_id,
      cardMask: params.pg_card_pan,
      cardToken: params.pg_card_token,
      recurringProfileId: params.pg_recurring_profile_id || params.pg_recurring_profile,
    });
    return { status: "ok", description: "Принято" };
  }

  await markInvoiceFailed(
    inv.id,
    params.pg_failure_description || "платёж не прошёл",
    (inv.attempts ?? 0) + 1,
    await loadConfig(),
  );
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
  const sb = await db();
  const sub = await loadSubscription(salonId);
  if (!sub) return { ok: false, error: "нет подписки" };
  const plan = (await loadPlans()).find((p) => p.code === sub.plan_code);
  if (!plan) return { ok: false, error: "тариф не найден" };
  const messages = plan.limits.overage_pack_messages;
  const price = plan.limits.overage_pack_price_kgs;

  if (source === "auto") {
    // Не больше одной автодокупки за 10 минут: иначе поток сообщений в пиковый час превращается
    // в серию списаний раньше, чем первое подтверждено.
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recent } = await sb
      .from("billing_invoices")
      .select("id")
      .eq("salon_id", salonId)
      .eq("kind", "overage_pack")
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length) return { ok: false, error: "автодокупка уже в процессе" };
  }

  const { data: pm } = await sb
    .from("billing_payment_methods")
    .select("recurring_profile_id")
    .eq("salon_id", salonId)
    .maybeSingle();

  const description = `Qabyl: пакет ${messages} сообщений`;
  if (pm?.recurring_profile_id) {
    const inv = await createInvoice(salonId, {
      kind: "overage_pack",
      amountKgs: price,
      metadata: { messages, source },
    });
    const res = await chargeSavedCard(salonId, inv.id, price, description);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  if (source === "auto" || !who) return { ok: false, error: "карта не привязана" };
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
      const { data: pm } = await sb
        .from("billing_payment_methods")
        .select("recurring_profile_id")
        .eq("salon_id", salonId)
        .maybeSingle();
      if (pm?.recurring_profile_id) {
        const inv = await createInvoice(salonId, {
          kind: "proration",
          amountKgs: decision.chargeKgs,
          planCode: to.code,
        });
        const res = await chargeSavedCard(salonId, inv.id, decision.chargeKgs, description);
        if (res.ok) return { result: "upgraded" };
        throw new Error(`Не удалось списать доплату: ${res.error}`);
      }
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
  const cfg = await loadConfig();
  // Биллинг выключен для всех: никого не переводим в «нужна оплата» и не блокируем.
  if (cfg.enforcement_enabled === false) return report;
  const plans = new Map((await loadPlans()).map((p) => [p.code, p]));
  const { data: subs } = await sb.from("salon_subscriptions").select("*").limit(2000);
  const { data: methods } = await sb
    .from("billing_payment_methods")
    .select("salon_id")
    .not("recurring_profile_id", "is", null);
  const withCard = new Set((methods ?? []).map((m: any) => m.salon_id as string));

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

      if (!sub.billing_exempt && sub.status === "trialing" && sub.trial_ends_at) {
        const left = new Date(sub.trial_ends_at).getTime() - now.getTime();
        if (left > 0 && left <= cfg.trial_warn_days * DAY && !withCard.has(sub.salon_id)) {
          await notifyOwnerOnce(
            sub.salon_id,
            `trial_warn:${sub.trial_ends_at}`,
            "Пробный период скоро закончится",
            `Осталось ${Math.ceil(left / DAY)} дн. Оплатите тариф, чтобы ассистент и онлайн-запись работали без перерыва.`,
          );
          report.warned++;
        }
      }
    } catch (e) {
      console.error(`[billing] cycle ${sub.salon_id}: ${(e as Error).message}`);
    }
  }

  // Повторные попытки автосписаний по расписанию dunning_retry_days.
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

  // Брошенные формы оплаты. Ссылка шлюза живёт час; через сутки счёт точно никто не оплатит.
  await sb
    .from("billing_invoices")
    .update({ status: "canceled", updated_at: now.toISOString() })
    .eq("status", "pending")
    .is("next_attempt_at", null)
    .eq("metadata->>via", "checkout")
    .lt("created_at", new Date(now.getTime() - DAY).toISOString());

  // Расход ≥ порога предупреждения — одно уведомление на период.
  for (const sub of (subs ?? []) as Subscription[]) {
    if (sub.billing_exempt) continue;
    const state = await getBillingState(sub.salon_id);
    if (!state?.has_subscription || !state.messages_allowance) continue;
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
