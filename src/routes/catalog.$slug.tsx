// Public services catalog — a shareable, printable prices page. Owners paste
// the link into WhatsApp/Telegram; clients open it on their phone; anyone can
// hit Print → Save-as-PDF for a clean single-file version. SSR-loaded so
// link-unfurlers (WA/TG/Slack) see real og:title / og:description immediately.
//
// Design intent:
//   * Mobile-first — narrow single column, generous type, tap-friendly.
//   * Uses the salon's brand_primary as the accent (headings, category rules).
//   * Print-CSS collapses interactive chrome and forces A4 margins.
//   * NO booking widget here — that lives at /book/$slug. A single CTA button
//     links to it at the bottom.

import { createFileRoute } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useMemo } from "react";
import {
  catalogUrl,
  formatDuration,
  formatPrice,
  groupByCategory,
  type CatalogService,
} from "@/lib/catalog-share";
import { useAutoPrintFromQuery } from "@/components/admin/ServiceExportDialog";

export const Route = createFileRoute("/catalog/$slug")({
  loader: async ({ params }) => {
    // Two-step is necessary: services must be scoped to salon.id, which we only learn from the
    // salon lookup. Keeps the query narrow — no accidental cross-salon leakage.
    const { data: salon } = await supabase
      .from("salons")
      .select(
        "id, slug, name, custom_domain, address, phone, logo_url, brand_primary, brand_accent, description",
      )
      .eq("slug", params.slug)
      .eq("is_active", true)
      .maybeSingle();

    const { data: services } = salon
      ? await supabase
          .from("services")
          .select("id, name, category, duration_min, price, price_max, price_type, sort_order")
          .eq("salon_id", salon.id)
          .eq("is_active", true)
          .order("sort_order", { ascending: true })
      : { data: [] };

    return { salon: salon ?? null, services: (services ?? []) as any[] };
  },
  head: ({ loaderData }) => {
    const salon = loaderData?.salon;
    const services = loaderData?.services ?? [];
    if (!salon) {
      return {
        meta: [{ title: "Прайс не найден — Qabyl" }, { name: "robots", content: "noindex" }],
      };
    }
    const url = catalogUrl(salon);
    const count = services.length;
    const prices = services.map((s: any) => s.price ?? 0).filter((n: number) => n > 0);
    const minP = prices.length ? Math.min(...prices) : 0;
    const maxP = Math.max(...prices, ...services.map((s: any) => s.price_max ?? 0));
    const desc = count
      ? `Услуги и цены: ${count} позиций${prices.length ? `, от ${minP} до ${maxP} сом` : ""}. Смотрите на телефоне или сохраните PDF.`
      : `Услуги «${salon.name}».`;
    const title = `${salon.name} — прайс`;
    const image = salon.logo_url || "https://qabyl.com/og-image.png";
    return {
      meta: [
        { title },
        { name: "description", content: desc },
        { property: "og:title", content: title },
        { property: "og:description", content: desc },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { property: "og:image", content: image },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: desc },
        { name: "twitter:image", content: image },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: CatalogPage,
});

function CatalogPage() {
  const { salon, services } = Route.useLoaderData() as {
    salon: any | null;
    services: CatalogService[];
  };
  const groups = useMemo(() => groupByCategory(services), [services]);
  const primary = salon?.brand_primary || "#0ea5e9";
  const accent = salon?.brand_accent || "#f59e0b";
  // Opens the print dialog automatically when the page is opened with ?print=1
  // (that's how the admin's "Скачать PDF" button reaches this route).
  useAutoPrintFromQuery();

  if (!salon) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <p className="text-neutral-600">Салон не найден.</p>
      </div>
    );
  }

  const bookHref = salon.custom_domain ? `https://${salon.custom_domain}/` : `/book/${salon.slug}`;

  return (
    <div
      className="min-h-screen bg-neutral-50 text-neutral-900 catalog-root"
      style={{
        // Brand tokens exposed to CSS so print + interactive share one source of truth.
        // Not using Tailwind arbitrary values so we can override in print media query below.
        ["--brand" as any]: primary,
        ["--accent" as any]: accent,
      }}
    >
      <style>{catalogCSS}</style>

      <main className="mx-auto max-w-2xl px-5 pt-8 pb-12 print:pt-0 print:pb-0">
        {/* Header */}
        <header className="text-center space-y-3 mb-8 print:mb-6">
          {salon.logo_url ? (
            <img
              src={salon.logo_url}
              alt={salon.name}
              className="mx-auto h-16 w-16 rounded-full object-cover ring-1 ring-black/5"
            />
          ) : null}
          <h1 className="text-3xl font-semibold tracking-tight print:text-2xl">{salon.name}</h1>
          <p className="text-sm uppercase tracking-[0.2em] text-neutral-500 print:text-neutral-600">
            Прайс на услуги
          </p>
          {(salon.address || salon.phone) && (
            <div className="text-sm text-neutral-600 space-y-0.5">
              {salon.address ? <p>{salon.address}</p> : null}
              {salon.phone ? (
                <p>
                  <a href={`tel:${salon.phone.replace(/\s/g, "")}`} className="hover:underline">
                    {salon.phone}
                  </a>
                </p>
              ) : null}
            </div>
          )}
        </header>

        {/* Groups */}
        {groups.length === 0 ? (
          <p className="text-center text-neutral-500 py-16">Пока нет услуг в прайсе.</p>
        ) : (
          <div className="space-y-8 print:space-y-6">
            {groups.map((g) => (
              <section key={g.category} className="print:break-inside-avoid">
                <h2
                  className="text-xs font-semibold tracking-[0.18em] uppercase mb-3 pb-2 border-b"
                  style={{ color: "var(--brand)", borderColor: "var(--brand)" }}
                >
                  {g.category}
                </h2>
                <ul className="space-y-3">
                  {g.items.map((s) => {
                    const price = formatPrice(s);
                    const dur = formatDuration(s.duration_min);
                    return (
                      <li
                        key={s.id}
                        className="flex items-baseline justify-between gap-3 print:break-inside-avoid"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] leading-snug break-words">{s.name}</p>
                          {dur ? (
                            <p className="text-xs text-neutral-500 mt-0.5">{dur}</p>
                          ) : null}
                        </div>
                        <div className="shrink-0 tabular-nums text-[15px] font-medium whitespace-nowrap">
                          {price}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {/* CTA — hidden on print */}
        <div className="mt-10 pt-6 border-t text-center space-y-3 print:hidden">
          <a
            href={bookHref}
            className="inline-flex items-center justify-center rounded-full px-6 py-3 text-white text-sm font-medium shadow-sm hover:opacity-90 transition"
            style={{ background: "var(--brand)" }}
          >
            Записаться онлайн
          </a>
          <p className="text-xs text-neutral-500">
            Прайс актуален на {new Date().toLocaleDateString("ru-RU")}. Точную стоимость с учётом
            ваших пожеланий уточнит мастер.
          </p>
        </div>

        {/* Powered-by — subtle, print-only */}
        <footer className="hidden print:block mt-8 pt-4 border-t text-center text-[10px] text-neutral-500 tracking-wide">
          {salon.name} · {new Date().toLocaleDateString("ru-RU")} · qabyl.com
        </footer>
      </main>
    </div>
  );
}

// Inline stylesheet: print CSS + tiny touch-ups that Tailwind's print: modifier can't cleanly
// express (font-size in mm, page margins). Kept small; the interactive design comes from
// utility classes above.
const catalogCSS = `
  .catalog-root { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
  @media print {
    @page { size: A4; margin: 14mm 16mm; }
    html, body { background: white !important; }
    .catalog-root { background: white !important; }
    a { color: inherit !important; text-decoration: none !important; }
    /* Muted borders survive black-and-white printers */
    section h2 { border-bottom-color: #999 !important; color: #111 !important; }
  }
`;
