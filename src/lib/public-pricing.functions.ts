import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

export const getPublicPricing = createServerFn({ method: "GET" }).handler(async () => {
  const { supabase } = await import("@/integrations/supabase/client");
  const { describePlan, planDisplayName } = await import("@/lib/billing-logic");
  const { data, error } = await (supabase as unknown as SupabaseClient)
    .from("billing_plans")
    .select("*")
    .eq("is_active", true)
    .eq("is_public", true)
    .order("sort_order");
  if (error) throw new Error("Каталог тарифов временно недоступен");
  const plans = (data ?? []) as import("@/lib/billing-logic").Plan[];
  return plans.map((p) => ({
    code: p.code,
    name: planDisplayName(p),
    price: p.price_kgs,
    trialDays: p.trial_days,
    trialMessages: p.limits.trial_messages,
    lines: describePlan(p),
    packMessages: p.limits.overage_pack_messages,
    packPrice: p.limits.overage_pack_price_kgs,
  }));
});
