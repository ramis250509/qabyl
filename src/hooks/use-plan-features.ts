// Что входит в тариф салона — для экранов, которые показывают или прячут платные функции.
//
// Пока состояние не пришло или не читается, всё считается доступным (fail-open): ошибка нашего
// учёта не должна прятать от салона его же данные. Настоящая граница — на сервере.
import { useEffect, useState } from "react";
import { getBillingStatus } from "@/lib/billing.functions";
import type { BillingState, PlanFeatures } from "@/lib/billing-logic";

export function usePlanFeatures(salonId: string | null | undefined) {
  const [state, setState] = useState<BillingState | null>(null);
  const [loaded, setLoaded] = useState(!salonId);

  useEffect(() => {
    if (!salonId) {
      setState(null);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    getBillingStatus({ data: { salonId } })
      .then((r) => {
        if (!cancelled) setState(r.state);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [salonId]);

  const has = (feature: keyof PlanFeatures): boolean => {
    if (!state?.has_subscription || state.exempt || !state.features) return true;
    return Boolean(state.features[feature]);
  };

  return { state, loaded, has };
}
