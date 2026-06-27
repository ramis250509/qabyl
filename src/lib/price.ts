export type ServicePrice = {
  price: number | null | undefined;
  price_max?: number | null;
  price_type?: string | null;
};

const CURRENCY = "сом";

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU").format(n);
}

export function formatPrice(s: ServicePrice): string {
  const p = Number(s.price ?? 0);
  if (s.price_type === "range") {
    const max = s.price_max != null ? Number(s.price_max) : null;
    if (max && max > p) return `${fmt(p)} – ${fmt(max)} ${CURRENCY}`;
    return `от ${fmt(p)} ${CURRENCY}`;
  }
  return `${fmt(p)} ${CURRENCY}`;
}

export function formatPriceShort(s: ServicePrice): string {
  return formatPrice(s);
}
