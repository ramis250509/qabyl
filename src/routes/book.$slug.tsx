import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PublicBooking } from "@/components/book/PublicBooking";
import { SalonSite } from "@/components/site/SalonSite";

export const Route = createFileRoute("/book/$slug")({
  head: () => ({ meta: [{ title: "Онлайн-запись" }] }),
  component: BookBySlug,
});

function BookBySlug() {
  const { slug } = Route.useParams();
  const [salon, setSalon] = useState<any | null>(null);
  const [branches, setBranches] = useState<any[]>([]);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    supabase.from("salons").select("*").eq("slug", slug).eq("is_active", true).maybeSingle()
      .then(({ data }) => {
        if (!data) { setNotFound(true); return; }
        setSalon(data);
        document.title = `${data.name} — онлайн-запись`;
        const desc = data.description || `Онлайн-запись в ${data.name}. Выберите услугу, мастера и удобное время.`;
        let meta = document.querySelector('meta[name="description"]');
        if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "description"); document.head.appendChild(meta); }
        meta.setAttribute("content", desc);
        supabase.from("branches").select("*").eq("salon_id", data.id).eq("is_active", true).order("sort_order")
          .then(({ data: br }) => setBranches(br ?? []));
      });
  }, [slug]);

  if (notFound) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Салон не найден</div>;
  }
  if (!salon) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Загрузка...</div>;

  return salon.site_enabled !== false
    ? <SalonSite salon={salon} />
    : <PublicBooking salon={salon} branches={branches} />;
}
