import { createFileRoute } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { PublicBooking } from "@/components/book/PublicBooking";
import { SalonSite } from "@/components/site/SalonSite";
import { BookingSuspended } from "@/components/book/BookingSuspended";

// The canonical home of a salon is its custom domain when configured, otherwise /book/{slug}
// on the platform domain. Used for <link rel=canonical> and og:url so a salon with a custom
// domain doesn't compete with itself for the same content.
function salonCanonical(salon: { slug: string; custom_domain?: string | null }): string {
  return salon.custom_domain
    ? `https://${salon.custom_domain}/`
    : `https://qabyl.com/book/${salon.slug}`;
}

export const Route = createFileRoute("/book/$slug")({
  // Fetch the salon on the server so title / description / canonical / OG are present in the
  // initial HTML for crawlers and link unfurlers — not set after client-side hydration.
  loader: async ({ params }) => {
    const { data: salon } = await supabase
      .from("salons")
      .select("*")
      .eq("slug", params.slug)
      .eq("is_active", true)
      .maybeSingle();

    const [{ data: branches }, { data: blocked }] = salon
      ? await Promise.all([
          supabase
            .from("branches")
            .select("*")
            .eq("salon_id", salon.id)
            .eq("is_active", true)
            .order("sort_order"),
          // Подписка салона не оплачена — запись всё равно не пройдёт (её режет триггер в базе),
          // поэтому честнее сразу сказать об этом, чем дать клиенту заполнить форму впустую.
          // Ошибка проверки — показываем сайт как обычно.
          (supabase as any).rpc("billing_salon_is_blocked", { _salon_id: salon.id }).then(
            (r: any) => r,
            () => ({ data: false }),
          ),
        ])
      : [{ data: [] }, { data: false }];

    return { salon: salon ?? null, branches: branches ?? [], blocked: blocked === true };
  },
  head: ({ loaderData }) => {
    const salon = loaderData?.salon;
    if (!salon) {
      return {
        meta: [{ title: "Салон не найден — Qabyl" }, { name: "robots", content: "noindex" }],
      };
    }
    const desc: string =
      salon.description ||
      `Онлайн-запись в «${salon.name}». Выберите услугу, мастера и удобное время.`;
    const canonical = salonCanonical(salon);
    const image: string =
      salon.hero_image_url || salon.logo_url || "https://qabyl.com/og-image.png";
    const title = `${salon.name} — онлайн-запись`;
    return {
      meta: [
        { title },
        { name: "description", content: desc },
        { property: "og:title", content: title },
        { property: "og:description", content: desc },
        { property: "og:type", content: "website" },
        { property: "og:url", content: canonical },
        { property: "og:image", content: image },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: desc },
        { name: "twitter:image", content: image },
      ],
      links: [{ rel: "canonical", href: canonical }],
    };
  },
  component: BookBySlug,
});

function BookBySlug() {
  const { salon, branches, blocked } = Route.useLoaderData();

  if (!salon) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Салон не найден
      </div>
    );
  }

  if (blocked) return <BookingSuspended salon={salon} />;

  return salon.site_enabled !== false ? (
    <SalonSite salon={salon} />
  ) : (
    <PublicBooking salon={salon} branches={branches} />
  );
}
