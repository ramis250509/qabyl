// Серверные функции экрана «Тариф и оплата».
//
// Права: тариф салона видят и меняют те, у кого есть доступ к салону (владелец и владелец
// платформы). Оплату переводом отмечает и освобождает от оплаты только владелец платформы.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertSalonAccess(supabase: any, userId: string, salonId: string, ownerOnly = true) {
  const { data, error } = await supabase.rpc("has_salon_access", {
    _user_id: userId,
    _salon_id: salonId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
  if (!ownerOnly) return;
  const { data: roles, error: roleError } = await supabase
    .from("user_roles")
    .select("role, salon_id")
    .eq("user_id", userId);
  if (
    roleError ||
    !roles?.some(
      (r: { role: string; salon_id: string | null }) =>
        r.role === "super_admin" || (r.role === "salon_admin" && r.salon_id === salonId),
    )
  ) {
    throw new Error("Управление оплатой доступно владельцу салона");
  }
}

async function assertSuperAdmin(supabase: any, userId: string) {
  const { data: role } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (!role) throw new Error("Forbidden: super_admin only");
}

async function whoAmI(context: any): Promise<{ userId: string; email: string | null }> {
  const { data } = await context.supabase.auth.getUser();
  return { userId: context.userId, email: data?.user?.email ?? null };
}

const salonInput = z.object({ salonId: z.string().uuid() });

/** Лёгкое состояние для баннеров и экрана блокировки в кабинете. */
export const getBillingStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => salonInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId, false);
    const { getBillingState } = await import("@/lib/billing.server");
    return { state: await getBillingState(data.salonId) };
  });

/** Всё для экрана тарифа одним запросом. */
export const getBillingOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => salonInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { getBillingState, loadPlans, loadConfig, currentFootprint } =
      await import("@/lib/billing.server");
    const { describePlan } = await import("@/lib/billing-logic");
    const { paymentProvider } = await import("@/lib/payment-provider.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [state, plans, cfg, footprint, { data: invoices }] = await Promise.all([
      getBillingState(data.salonId),
      loadPlans(true),
      loadConfig(),
      currentFootprint(data.salonId),
      (supabaseAdmin as any)
        .from("billing_invoices")
        .select(
          "id, kind, amount_kgs, status, plan_code, period_start, period_end, paid_at, created_at",
        )
        .eq("salon_id", data.salonId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    const { data: preferences, error: preferencesError } = await (supabaseAdmin as any)
      .from("salon_subscriptions")
      .select(
        "auto_topup, auto_topup_threshold, auto_topup_packs, auto_topup_consent_at, renewal_consent_at",
      )
      .eq("salon_id", data.salonId)
      .maybeSingle();
    if (preferencesError) throw new Error("Раздел оплаты обновляется. Попробуйте позже.");
    return {
      preferences: preferences as {
        auto_topup: boolean;
        auto_topup_threshold: number;
        auto_topup_packs: number;
        auto_topup_consent_at: string | null;
        renewal_consent_at: string | null;
      } | null,
      state,
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        tagline: p.tagline ?? null,
        price_kgs: p.price_kgs,
        trial_days: p.trial_days,
        is_featured: p.is_featured,
        pack_messages: p.limits.overage_pack_messages,
        pack_price_kgs: p.limits.overage_pack_price_kgs,
        lines: describePlan(p),
      })),
      footprint: { branches: footprint.branches, channels: footprint.channels },
      invoices: (invoices ?? []) as {
        id: string;
        kind: string;
        amount_kgs: number;
        status: string;
        plan_code: string | null;
        period_start: string | null;
        period_end: string | null;
        paid_at: string | null;
        created_at: string;
      }[],
      paymentsEnabled: Boolean(paymentProvider()),
      paymentCapabilities: paymentProvider()?.capabilities ?? {
        checkout: false,
        recurring: false,
        saveMethod: false,
        refunds: false,
      },
      manualInstructions: cfg.manual_payment_instructions ?? null,
      supportContact: cfg.support_contact ?? "support@qabyl.com",
      // Реквизиты ручной оплаты. Пока шлюза карт нет, это и есть касса Qabyl, и прятать её в
      // серую сноску внизу карточки — значит каждый месяц объяснять каждому салону голосом,
      // куда переводить деньги.
      manualPayment: {
        bank: (cfg.manual_payment_bank as string) ?? "MBANK",
        phone: (cfg.manual_payment_phone as string) ?? null,
        recipient: (cfg.manual_payment_recipient as string) ?? null,
      },
    };
  });

export const changeBillingPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), planCode: z.string().min(1).max(40) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { changePlan } = await import("@/lib/billing.server");
    return await changePlan(data.salonId, data.planCode, await whoAmI(context));
  });

export const payBillingNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => salonInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { payNow } = await import("@/lib/billing.server");
    return await payNow(data.salonId, await whoAmI(context));
  });

export const buyMessagesPack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => salonInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { buyPack } = await import("@/lib/billing.server");
    const res = await buyPack(data.salonId, "manual", await whoAmI(context));
    if (!res.ok) throw new Error(res.error ?? "Не удалось купить пакет");
    return res;
  });

export const setBillingAutoTopup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        enabled: z.boolean(),
        threshold: z.union([z.literal(500), z.literal(1000)]).default(500),
        packs: z.number().int().min(1).max(10).default(1),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { paymentProvider } = await import("@/lib/payment-provider.server");
    if (data.enabled && !paymentProvider()?.capabilities.recurring)
      throw new Error("Автопополнение ещё не подключено");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("salon_subscriptions")
      .update({
        auto_topup: data.enabled,
        auto_topup_threshold: data.threshold,
        auto_topup_packs: data.packs,
        auto_topup_consent_at: data.enabled ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("salon_id", data.salonId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Отказ от подписки — с конца оплаченного периода. Возврат — снятием флага. */
export const setBillingCancel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), cancel: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { logBillingEvent } = await import("@/lib/billing.server");
    const { error } = await (supabaseAdmin as any)
      .from("salon_subscriptions")
      .update({ cancel_at_period_end: data.cancel, updated_at: new Date().toISOString() })
      .eq("salon_id", data.salonId);
    if (error) throw new Error(error.message);
    await logBillingEvent(data.salonId, data.cancel ? "cancel_requested" : "cancel_reverted", {
      by: context.userId,
    });
    return { ok: true };
  });

/** Освобождение от оплаты — только владелец платформы. Для пилотных и служебных салонов. */
export const setBillingExempt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), exempt: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { logBillingEvent } = await import("@/lib/billing.server");
    const { error } = await (supabaseAdmin as any)
      .from("salon_subscriptions")
      .update({ billing_exempt: data.exempt, updated_at: new Date().toISOString() })
      .eq("salon_id", data.salonId);
    if (error) throw new Error(error.message);
    await logBillingEvent(data.salonId, "exempt_changed", {
      exempt: data.exempt,
      by: context.userId,
    });
    return { ok: true };
  });

/** Оплата переводом — отмечает владелец платформы, когда деньги пришли. */
export const recordManualBillingPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        kind: z.enum(["subscription", "overage_pack"]),
        months: z.number().int().min(1).max(12).optional(),
        planCode: z.string().max(40).nullable().optional(),
        amountKgs: z.number().int().min(0).max(1_000_000).nullable().optional(),
        note: z.string().max(300).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.supabase, context.userId);
    const { recordManualPayment } = await import("@/lib/billing.server");
    return await recordManualPayment(data.salonId, {
      kind: data.kind,
      months: data.months,
      planCode: data.planCode,
      amountKgs: data.amountKgs,
      note: data.note,
      by: context.userId,
    });
  });

export type PlatformBillingRow = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  planName: string | null;
  status: string | null;
  exempt: boolean | null;
  until: string | null;
};

/** Биллинг всех салонов — для владельца платформы. */
export const getPlatformBillingOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadConfig, loadPlans } = await import("@/lib/billing.server");
    const sb = supabaseAdmin as any;
    const [cfg, plans, { data: salons }, { data: subs }] = await Promise.all([
      loadConfig(),
      loadPlans(),
      sb.from("salons").select("id, name, slug, is_active").order("name"),
      sb
        .from("salon_subscriptions")
        .select(
          "salon_id, plan_code, status, billing_exempt, trial_ends_at, current_period_end, grace_until",
        ),
    ]);
    const planName = new Map(plans.map((p) => [p.code, p.name]));
    const subBy = new Map<string, any>((subs ?? []).map((x: any) => [x.salon_id, x]));
    const rows: PlatformBillingRow[] = (salons ?? []).map((x: any) => {
      const sub = subBy.get(x.id);
      return {
        id: x.id,
        name: x.name ?? "",
        slug: x.slug ?? "",
        isActive: x.is_active !== false,
        planName: sub ? (planName.get(sub.plan_code) ?? sub.plan_code) : null,
        status: sub?.status ?? null,
        exempt: sub ? Boolean(sub.billing_exempt) : null,
        until: sub
          ? sub.status === "trialing"
            ? sub.trial_ends_at
            : sub.status === "past_due"
              ? sub.grace_until
              : sub.current_period_end
          : null,
      };
    });
    return { enforcementEnabled: cfg.enforcement_enabled !== false, salons: rows };
  });

/** Общий выключатель биллинга: false — никто не ограничен и не блокируется. */
export const setBillingEnforcement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ enabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { logBillingEvent } = await import("@/lib/billing.server");
    const sb = supabaseAdmin as any;
    const { data: row, error: readErr } = await sb
      .from("billing_settings")
      .select("config")
      .eq("id", true)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    const { error } = await sb.from("billing_settings").upsert({
      id: true,
      config: { ...(row?.config ?? {}), enforcement_enabled: data.enabled },
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    await logBillingEvent(null, "enforcement_changed", {
      enabled: data.enabled,
      by: context.userId,
    });
    return { ok: true };
  });

/**
 * Кто из точек сети израсходовал сообщения в этом месяце.
 *
 * ═══ ЗАЧЕМ ═══════════════════════════════════════════════════════════════
 *
 * Лимит один на весь бизнес — общий котёл. Это дешевле для сети, чем лимит на каждую точку, но
 * порождает вопрос, на который до сих пор нечем было ответить: центр съел пять тысяч, ассистент
 * замолчал на всех трёх точках, включая тихие, и владелец звонит спросить, почему на Джале
 * ничего не работает, когда там людей нет. Разбивка отвечает на это одной таблицей.
 *
 * ═══ ПОЧЕМУ СЧИТАЕМ ПО ПЕРЕПИСКАМ, А НЕ ОТДЕЛЬНЫМ СЧЁТЧИКОМ ══════════════
 *
 * Напрашивалось добавить точку в billing_usage и писать её при каждой отправке. Но учёт расхода —
 * это то, что решает, отвечает ли ассистент вообще; лезть туда ради красивой таблицы значит
 * рисковать связью ради статистики.
 *
 * Здесь другой путь: исходящие сообщения и так лежат в wa_messages, а точка — в переписке, к
 * которой они относятся. Считаем по ним. Ничего не пишем, ничего не ломаем, и разбивка работает
 * задним числом — включая месяцы до появления этой функции.
 *
 * Сумма по точкам может немного не сойтись с общим счётчиком: тот считает то, что принял
 * провайдер. Это разбивка «кто сколько потратил», а не второй счёт — так и подписано на экране.
 */
export const getUsageByBranch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const sb = supabaseAdmin as any;

    const { data: periodStart } = await sb.rpc("billing_current_period_start", {
      _salon_id: data.salonId,
    });
    if (!periodStart) return { rows: [], unassigned: 0, total: 0 };

    const [{ data: branches }, { data: convs }] = await Promise.all([
      sb.from("branches").select("id, name").eq("salon_id", data.salonId).order("sort_order"),
      sb.from("wa_conversations").select("id, selected_branch_id").eq("salon_id", data.salonId),
    ]);

    const branchByConv = new Map<string, string | null>(
      (convs ?? []).map((c: any) => [c.id as string, (c.selected_branch_id as string) ?? null]),
    );
    if (branchByConv.size === 0) return { rows: [], unassigned: 0, total: 0 };

    // Только исходящие: входящие клиенту бесплатны и в лимит не входят.
    const { data: msgs } = await sb
      .from("wa_messages")
      .select("conversation_id")
      .eq("salon_id", data.salonId)
      .eq("direction", "out")
      .gte("created_at", periodStart);

    const counts = new Map<string, number>();
    let unassigned = 0;
    let total = 0;
    for (const m of msgs ?? []) {
      total += 1;
      const b = branchByConv.get(m.conversation_id as string) ?? null;
      if (!b) {
        unassigned += 1;
        continue;
      }
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }

    const rows = (branches ?? [])
      .map((b: any) => ({
        id: b.id as string,
        name: b.name as string,
        used: counts.get(b.id) ?? 0,
      }))
      .sort((a: any, b: any) => b.used - a.used);

    return { rows, unassigned, total };
  });
