import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { SalonSite } from "@/components/site/SalonSite";

export const Route = createFileRoute("/preview/salon/$salonId")({
  ssr: false,
  // Internal owner preview — duplicates the live salon site, so keep it out of the index.
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  component: PreviewSalonSite,
});

function PreviewSalonSite() {
  const { salonId } = Route.useParams();
  const [salon, setSalon] = useState<any>(null);
  const [status, setStatus] = useState<"loading" | "denied" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session) {
        setStatus("denied");
        return;
      }
      const { data, error } = await supabase
        .from("salons")
        .select("*")
        .eq("id", salonId)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setStatus("denied");
        return;
      }
      setSalon(data);
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [salonId]);

  if (status === "denied") {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Нет доступа к этому салону</div>;
  }
  if (status === "loading" || !salon) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Загрузка превью...</div>;
  }

  return (
    <>
      <div className="sticky top-0 z-50 bg-yellow-400 text-black text-sm py-2 px-4 text-center font-medium">
        Превью сайта салона — так его увидят клиенты на вашем домене
      </div>
      <SalonSite salon={salon} />
    </>
  );
}
