// Share helpers for the public services catalog. Kept UI-free so the same
// helpers can produce the plain-text WhatsApp/Telegram fallback AND the
// deep-links used by the share buttons.

export type CatalogService = {
  id: string;
  name: string;
  category: string | null;
  duration_min: number;
  price: number | null;
  price_max: number | null;
  price_type: "fixed" | "range";
};

export type CatalogSalon = {
  slug: string;
  name: string;
  custom_domain: string | null;
  address: string | null;
  phone: string | null;
  logo_url: string | null;
  brand_primary: string | null;
  brand_accent: string | null;
};

// Canonical, always-current public URL for the catalog. Prefers the salon's
// custom domain when set (matches the same rule as the booking page).
export function catalogUrl(salon: Pick<CatalogSalon, "slug" | "custom_domain">): string {
  return salon.custom_domain
    ? `https://${salon.custom_domain}/catalog`
    : `https://qabyl.com/catalog/${salon.slug}`;
}

// Format one service's price line. "800 сом", "от 2500 сом", "800–1200 сом".
export function formatPrice(svc: Pick<CatalogService, "price" | "price_max" | "price_type">): string {
  const min = svc.price ?? 0;
  const max = svc.price_max ?? null;
  if (svc.price_type === "range" && max && max > min) return `${nf(min)}–${nf(max)} сом`;
  if (svc.price_type === "range") return `от ${nf(min)} сом`;
  return `${nf(min)} сом`;
}

function nf(n: number): string {
  // Kyrgyz/Russian thousands separator is a narrow no-break space; render "1 500".
  return new Intl.NumberFormat("ru-RU").format(Math.round(n));
}

// Compact human-friendly duration. 90 → "1 ч 30 мин", 60 → "1 ч", 45 → "45 мин".
export function formatDuration(min: number): string {
  if (min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

// Group services by category. Keeps the original service order inside each group;
// categories are emitted in the order they first appear (matches the admin sort).
export function groupByCategory(services: CatalogService[]): { category: string; items: CatalogService[] }[] {
  const groups = new Map<string, CatalogService[]>();
  const order: string[] = [];
  for (const s of services) {
    const cat = (s.category ?? "").trim() || "Услуги";
    if (!groups.has(cat)) {
      groups.set(cat, []);
      order.push(cat);
    }
    groups.get(cat)!.push(s);
  }
  return order.map((cat) => ({ category: cat, items: groups.get(cat)! }));
}

// Plain-text catalog for the "copy to messenger" fallback. Deliberately narrow:
// wraps at ~35 chars per line so a phone-screen WhatsApp bubble doesn't uglify it.
export function catalogAsText(
  salon: Pick<CatalogSalon, "name" | "phone" | "address">,
  services: CatalogService[],
): string {
  const groups = groupByCategory(services);
  const lines: string[] = [];
  lines.push(`📋 ${salon.name} — прайс`);
  if (salon.address) lines.push(`📍 ${salon.address}`);
  if (salon.phone) lines.push(`📞 ${salon.phone}`);
  lines.push("");
  for (const g of groups) {
    lines.push(`— ${g.category.toUpperCase()} —`);
    for (const s of g.items) {
      const price = formatPrice(s);
      const dur = formatDuration(s.duration_min);
      lines.push(`• ${s.name}`);
      lines.push(`  ${price}${dur ? ` · ${dur}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// wa.me / t.me deep-links. Both open the "compose" screen with pre-filled text
// so the owner just picks a recipient. Fallback: if the messenger app isn't
// installed the browser opens the web version — still works.
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function telegramShareUrl(url: string, text: string): string {
  // Telegram's share URL takes a real URL + optional text. Passing url first
  // gives the recipient a clickable preview; the text goes as the description.
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

// The single line owners paste into any chat: catalog URL + short message.
export function shareBlurb(salon: Pick<CatalogSalon, "name">, url: string): string {
  return `Наш прайс — ${salon.name}\n${url}`;
}
