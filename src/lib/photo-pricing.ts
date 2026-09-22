// A photograph may classify salon-defined attributes; it must never invent a price.
// Keep this module pure so the same validation/pricing is used by the agent and regression tests.
export type PhotoOption = { id: string; label: string; amount: number };
export type PhotoCriterion = {
  id: string;
  label: string;
  mode: "base" | "surcharge";
  options: PhotoOption[];
};
export type PhotoPricingConfig = { enabled: boolean; criteria: PhotoCriterion[] };
export type PhotoClassification = {
  relevant: boolean;
  values: Record<string, string | null>;
  uncertain?: string[];
};

export const PHOTO_PRESETS: PhotoCriterion[] = [
  {
    id: "length",
    label: "Длина волос",
    mode: "base",
    options: [
      { id: "short", label: "До плеч", amount: 0 },
      { id: "medium", label: "Ниже плеч", amount: 0 },
      { id: "long", label: "До лопаток", amount: 0 },
      { id: "very_long", label: "Ниже лопаток", amount: 0 },
    ],
  },
  {
    id: "density",
    label: "Густота",
    mode: "surcharge",
    options: [
      { id: "normal", label: "Обычная", amount: 0 },
      { id: "thick", label: "Густая", amount: 0 },
      { id: "very_thick", label: "Очень густая", amount: 0 },
    ],
  },
];

export function validatePhotoConfig(raw: unknown): PhotoPricingConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const config = raw as PhotoPricingConfig;
  if (
    config.enabled !== true ||
    !Array.isArray(config.criteria) ||
    !config.criteria.length ||
    config.criteria.length > 8
  )
    return null;
  const ids = new Set<string>();
  let bases = 0;
  for (const criterion of config.criteria) {
    if (
      !criterion ||
      typeof criterion.id !== "string" ||
      !/^[a-z0-9_]{1,40}$/.test(criterion.id) ||
      ids.has(criterion.id) ||
      typeof criterion.label !== "string" ||
      !criterion.label.trim() ||
      criterion.label.length > 80 ||
      !["base", "surcharge"].includes(criterion.mode) ||
      !Array.isArray(criterion.options) ||
      criterion.options.length < 2 ||
      criterion.options.length > 12
    )
      return null;
    ids.add(criterion.id);
    if (criterion.mode === "base") bases++;
    const optionIds = new Set<string>();
    for (const option of criterion.options) {
      if (
        !option ||
        typeof option.id !== "string" ||
        !/^[a-z0-9_]{1,40}$/.test(option.id) ||
        optionIds.has(option.id) ||
        typeof option.label !== "string" ||
        !option.label.trim() ||
        option.label.length > 80 ||
        !Number.isFinite(option.amount) ||
        option.amount < 0 ||
        option.amount > 10_000_000
      )
        return null;
      optionIds.add(option.id);
    }
  }
  return bases <= 1 ? config : null;
}

export function calculatePhotoPrice(
  raw: unknown,
  classification: PhotoClassification,
  service: { price: number; price_max: number },
): { price: number; selected: Record<string, string> } | { needs: string[] } | { error: string } {
  const config = validatePhotoConfig(raw);
  if (!config) return { error: "photo_rules_not_configured" };
  if (!classification.relevant)
    return { needs: ["Фото не относится к выбранной услуге — попросите подходящее фото."] };
  const selected: Record<string, string> = {};
  const needs: string[] = [];
  let price = service.price;
  for (const criterion of config.criteria) {
    const value = classification.values?.[criterion.id];
    const option = criterion.options.find((o) => o.id === value);
    if (!option || classification.uncertain?.includes(criterion.id)) {
      needs.push(criterion.label);
      continue;
    }
    selected[criterion.id] = option.id;
    if (criterion.mode === "base") price = option.amount;
    else price += option.amount;
  }
  if (needs.length) return { needs };
  if (
    !Number.isFinite(service.price) ||
    !Number.isFinite(service.price_max) ||
    !Number.isFinite(price) ||
    price < service.price ||
    price > service.price_max
  )
    return { error: "photo_price_outside_service_range" };
  return { price, selected };
}

export function photoRuleRangeError(
  raw: unknown,
  service: { price: number; price_max: number },
): string | null {
  const config = validatePhotoConfig(raw);
  if (!config) return "Заполните варианты и не используйте два критерия с полной ценой";
  const base = config.criteria.find((c) => c.mode === "base");
  const surcharges = config.criteria.filter((c) => c.mode === "surcharge");
  const min =
    (base ? Math.min(...base.options.map((o) => o.amount)) : service.price) +
    surcharges.reduce((sum, c) => sum + Math.min(...c.options.map((o) => o.amount)), 0);
  const max =
    (base ? Math.max(...base.options.map((o) => o.amount)) : service.price) +
    surcharges.reduce((sum, c) => sum + Math.max(...c.options.map((o) => o.amount)), 0);
  return min < service.price || max > service.price_max
    ? `Возможные цены ${min}–${max} выходят за прайс услуги ${service.price}–${service.price_max}`
    : null;
}

export function photoBookingPrice(
  quote: { serviceId: string; price: number; at: number } | null,
  serviceId: string,
  requested: unknown,
  now = Date.now(),
): { price: number | null } | { error: string } {
  const value = requested == null ? null : Number(requested);
  if (value != null && !Number.isFinite(value)) return { error: "invalid_price_override" };
  if (
    !quote ||
    quote.serviceId !== serviceId ||
    !Number.isFinite(quote.price) ||
    now - quote.at > 3_600_000 ||
    now < quote.at
  )
    return { price: value };
  if (value != null && value !== quote.price) return { error: "photo_quote_price_mismatch" };
  return { price: quote.price };
}
