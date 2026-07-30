import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { PublicBooking } from "@/components/book/PublicBooking";
import { MinimalTemplate } from "./templates/MinimalTemplate";
import { PremiumTemplate } from "./templates/PremiumTemplate";
import { VividTemplate } from "./templates/VividTemplate";
import { CustomTemplate } from "./templates/CustomTemplate";
import { BranchesContactsBlock, type BranchVariant } from "./BranchContacts";
import { I18nProvider } from "@/lib/i18n";

export type SalonSiteData = {
  salon: any;
  services: any[];
  masters: any[];
  reviews: any[];
  branches: any[];
  faqs: any[];
};

export function SalonSite({ salon }: { salon: any }) {
  const [data, setData] = useState<SalonSiteData | null>(null);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [preselectedServiceId, setPreselectedServiceId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [
        { data: services },
        { data: masters },
        { data: reviews },
        { data: branches },
        { data: faqs },
      ] = await Promise.all([
        supabase
          .from("services")
          .select("*")
          .eq("salon_id", salon.id)
          .eq("is_active", true)
          .order("sort_order"),
        supabase
          .from("masters")
          .select("*")
          .eq("salon_id", salon.id)
          .eq("is_active", true)
          .order("sort_order"),
        supabase
          .from("salon_reviews")
          .select("*")
          .eq("salon_id", salon.id)
          .eq("is_published", true)
          .order("created_at", { ascending: false }),
        supabase
          .from("branches")
          .select("*")
          .eq("salon_id", salon.id)
          .eq("is_active", true)
          .order("sort_order"),
        supabase
          .from("salon_faqs")
          .select("id, question, answer, sort_order")
          .eq("salon_id", salon.id)
          .order("sort_order"),
      ]);
      setData({
        salon,
        services: services ?? [],
        masters: masters ?? [],
        reviews: reviews ?? [],
        branches: branches ?? [],
        faqs: faqs ?? [],
      });
    })();
  }, [salon]);

  const jsonLd = useMemo(() => {
    if (!data) return null;
    const avgRating = data.reviews.length
      ? data.reviews.reduce((a, r) => a + r.rating, 0) / data.reviews.length
      : null;
    return {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: salon.name,
      description: salon.about_text || salon.description,
      address: salon.address
        ? { "@type": "PostalAddress", streetAddress: salon.address }
        : undefined,
      telephone: salon.phone,
      image: salon.hero_image_url || salon.logo_url,
      aggregateRating: avgRating
        ? {
            "@type": "AggregateRating",
            ratingValue: avgRating.toFixed(1),
            reviewCount: data.reviews.length,
          }
        : undefined,
    };
  }, [data, salon]);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Загрузка...
      </div>
    );
  }

  const openBooking = (serviceId?: string) => {
    setPreselectedServiceId(serviceId ?? null);
    setBookingOpen(true);
  };

  const tpl = salon.site_template;
  const Template =
    tpl === "custom"
      ? CustomTemplate
      : tpl === "premium"
        ? PremiumTemplate
        : tpl === "vivid"
          ? VividTemplate
          : MinimalTemplate;

  const branchVariant: BranchVariant =
    tpl === "premium" ? "dark" : tpl === "vivid" ? "vivid" : "light";

  const vividBg =
    tpl === "vivid"
      ? {
          background: `linear-gradient(135deg, ${salon.brand_primary || "#e84393"}, ${salon.brand_accent || "#6c5ce7"})`,
        }
      : undefined;

  const bookingTheme: "light" | "dark" | "vivid" =
    tpl === "premium" ? "dark" : tpl === "vivid" ? "vivid" : "light";

  const dialogClass =
    bookingTheme === "dark"
      ? "dark bg-neutral-950 text-neutral-100 border-neutral-800"
      : bookingTheme === "vivid"
        ? "bg-white text-neutral-900"
        : "bg-background text-foreground";

  return (
    <I18nProvider forceLang={salon.multilang_enabled ? undefined : "ru"}>
      {jsonLd && (
        <script
          type="application/ld+json"
          // Escape </ so a salon admin who puts "</script>" into their name/description/review
          // text (all user-editable via the admin panel and interpolated into jsonLd below)
          // cannot break out of the JSON-LD <script> block and execute arbitrary JS on their
          // own site's public page. Same trick used by React's own script serializer.
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/<\/(script)/gi, "<\\/$1"),
          }}
        />
      )}
      <Template data={data} onBook={openBooking} />
      {tpl !== "custom" && (
        <BranchesContactsBlock
          branches={data.branches}
          accent={salon.brand_primary ?? undefined}
          variant={branchVariant}
          bgStyle={vividBg}
        />
      )}
      <Dialog open={bookingOpen} onOpenChange={setBookingOpen}>
        <DialogContent className={`max-w-3xl max-h-[95vh] overflow-y-auto p-0 ${dialogClass}`}>
          <PublicBooking
            salon={salon}
            branches={data.branches}
            preselectedServiceId={preselectedServiceId}
            theme={bookingTheme}
            onClose={() => setBookingOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </I18nProvider>
  );
}
