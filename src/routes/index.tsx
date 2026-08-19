import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar, Users, MessageCircle, BarChart3 } from "lucide-react";
import { PublicBooking } from "@/components/book/PublicBooking";
import { SalonSite } from "@/components/site/SalonSite";
import { FullScreenLoader } from "@/components/ui/loading-state";
import { getSsrLanding } from "@/lib/ssr-landing";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Qabyl — онлайн-запись для сферы услуг" },
      {
        name: "description",
        content:
          "Qabyl — платформа онлайн-записи для салонов, барбершопов, клиник и частных мастеров: календарь специалистов, WhatsApp-уведомления и собственный сайт салона.",
      },
    ],
  }),
  loader: async () => {
    // On the platform's marketing host, render the landing during SSR (better for JS-light
    // crawlers). Any error → false → existing client-side resolution, so this is fail-safe.
    try {
      return { ssrLanding: await getSsrLanding() };
    } catch {
      return { ssrLanding: false };
    }
  },
  component: Index,
});

// Structured data for the marketing landing only. Rendered inside <Landing/> so it never
// appears when index.tsx serves a salon site on a custom domain.
const LANDING_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://qabyl.com/#organization",
      name: "Qabyl",
      url: "https://qabyl.com/",
      logo: "https://qabyl.com/icon-512.png",
      description: "Платформа онлайн-записи для сферы услуг.",
    },
    {
      "@type": "WebSite",
      "@id": "https://qabyl.com/#website",
      url: "https://qabyl.com/",
      name: "Qabyl",
      inLanguage: "ru-RU",
      publisher: { "@id": "https://qabyl.com/#organization" },
    },
    {
      "@type": "SoftwareApplication",
      name: "Qabyl",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: "https://qabyl.com/",
      description:
        "Онлайн-запись для салонов красоты, барбершопов, клиник и частных мастеров: календарь специалистов, WhatsApp-уведомления и сайт салона.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "KGS" },
    },
  ],
};

function Index() {
  const { ssrLanding } = Route.useLoaderData();
  const navigate = useNavigate();
  const [hostSalon, setHostSalon] = useState<any | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const host = window.location.hostname;
    if (host.includes("lovable.app") || host === "localhost" || host.startsWith("127.")) {
      import("@/integrations/supabase/client").then(({ supabase }) =>
        supabase.auth.getSession().then(({ data: { session } }) => {
          if (cancelled) return;
          if (session) navigate({ to: "/admin", replace: true });
          else setResolved(true);
        }),
      );
      return () => {
        cancelled = true;
      };
    }
    import("@/integrations/supabase/client").then(({ supabase }) =>
      supabase.rpc("get_salon_by_host", { _host: host }).then(({ data }) => {
        if (cancelled) return;
        if (data && data.length > 0) setHostSalon(data[0]);
        setResolved(true);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  useEffect(() => {
    if (hostSalon) {
      document.title = `${hostSalon.name} — онлайн-запись`;
    }
  }, [hostSalon]);

  if (hostSalon) {
    return hostSalon.site_enabled !== false ? (
      <SalonSite salon={hostSalon} />
    ) : (
      <PublicBooking salon={hostSalon} />
    );
  }

  // On a known marketing host the server already committed to the landing, so render it
  // immediately (SSR + hydration) instead of flashing a loader. Everywhere else, wait for the
  // client-side host resolution exactly as before.
  if (!resolved && !ssrLanding) {
    return <FullScreenLoader />;
  }

  return <Landing />;
}

function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(LANDING_JSON_LD) }}
      />
      <header className="border-b">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="font-semibold text-lg">Qabyl</div>
          <div className="flex gap-2">
            <Link to="/auth">
              <Button variant="ghost">Войти</Button>
            </Link>
            <Link to="/admin">
              <Button>Админ-панель</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-20">
        <div className="text-center max-w-3xl mx-auto">
          <h1 className="text-5xl font-bold tracking-tight">Онлайн-запись для вашего бизнеса</h1>
          <p className="mt-6 text-xl text-muted-foreground">
            Управляйте записями из одной панели: салоны красоты, барбершопы, массаж, косметология,
            клиники и другие услуги. WhatsApp-подтверждения, календарь специалистов, отчёты — всё в
            одном месте.
          </p>
          <div className="mt-8 flex gap-3 justify-center">
            <Link to="/admin">
              <Button size="lg">Перейти в панель</Button>
            </Link>
          </div>
        </div>

        <div className="grid md:grid-cols-4 gap-4 mt-20">
          {[
            { icon: Calendar, title: "Календарь мастеров", desc: "День/неделя, drag-and-drop" },
            { icon: Users, title: "Мульти-бизнес", desc: "Один кабинет, много точек" },
            { icon: MessageCircle, title: "WhatsApp", desc: "Автоподтверждение записей" },
            { icon: BarChart3, title: "Статистика", desc: "Выручка, загрузка, ТОП" },
          ].map((f) => (
            <Card key={f.title} className="p-6">
              <f.icon className="h-8 w-8 text-primary mb-3" />
              <h3 className="font-semibold">{f.title}</h3>
              <p className="text-sm text-muted-foreground mt-1">{f.desc}</p>
            </Card>
          ))}
        </div>
      </main>

      <footer className="border-t bg-muted/30">
        <div className="container mx-auto grid gap-8 px-4 py-12 md:grid-cols-2">
          <div>
            <div className="text-lg font-semibold">Qabyl</div>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              Платформа онлайн-записи для сферы услуг с WhatsApp-уведомлениями.
            </p>
            <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Link to="/privacy" className="text-muted-foreground underline hover:text-foreground">
                Политика конфиденциальности
              </Link>
              <Link to="/terms" className="text-muted-foreground underline hover:text-foreground">
                Условия использования
              </Link>
            </p>
          </div>

          <div className="text-sm text-muted-foreground">
            <div className="font-semibold text-foreground">Реквизиты</div>
            <address className="mt-2 space-y-1 not-italic">
              <div>Индивидуальный предприниматель Акбаров Рамис Нургазыбекович</div>
              <div>ИНН: 22505200950633</div>
              <div>Регистрационный номер: 001-2026-169-2385</div>
              <div>
                Кыргызская Республика, г. Бишкек, Октябрьский р-н, Кара-Жыгач ж/м, улица Исакеева Б,
                дом 18/5, кв. 40
              </div>
              <div>
                Телефон:{" "}
                <a href="tel:+996556108099" className="hover:text-foreground">
                  +996 556 108 099
                </a>
              </div>
              <div>
                Email:{" "}
                <a href="mailto:support@qabyl.com" className="hover:text-foreground">
                  support@qabyl.com
                </a>
              </div>
            </address>
          </div>
        </div>

        <div className="border-t">
          <div className="container mx-auto px-4 py-4 text-xs text-muted-foreground">
            © {new Date().getFullYear()} Qabyl · Индивидуальный предприниматель Акбаров Рамис
            Нургазыбекович
          </div>
        </div>
      </footer>
    </div>
  );
}
