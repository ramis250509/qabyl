import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar, Users, MessageCircle, BarChart3 } from "lucide-react";
import { PublicBooking } from "@/components/book/PublicBooking";
import { SalonSite } from "@/components/site/SalonSite";
import { FullScreenLoader } from "@/components/ui/loading-state";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Qabyl — онлайн-запись для салонов красоты" },
      { name: "description", content: "Qabyl: платформа онлайн-записи с WhatsApp-уведомлениями для салонов красоты" },
    ],
  }),
  component: Index,
});

function Index() {
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
        })
      );
      return () => { cancelled = true; };
    }
    import("@/integrations/supabase/client").then(({ supabase }) =>
      supabase.rpc("get_salon_by_host", { _host: host }).then(({ data }) => {
        if (cancelled) return;
        if (data && data.length > 0) setHostSalon(data[0]);
        setResolved(true);
      })
    );
    return () => { cancelled = true; };
  }, [navigate]);

  useEffect(() => {
    if (hostSalon) {
      document.title = `${hostSalon.name} — онлайн-запись`;
    }
  }, [hostSalon]);

  if (!resolved) {
    return <FullScreenLoader />;
  }

  if (hostSalon) {
    return hostSalon.site_enabled !== false
      ? <SalonSite salon={hostSalon} />
      : <PublicBooking salon={hostSalon} />;
  }

  return <Landing />;
}

function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <header className="border-b">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="font-semibold text-lg">Qabyl</div>
          <div className="flex gap-2">
            <Link to="/auth"><Button variant="ghost">Войти</Button></Link>
            <Link to="/admin"><Button>Админ-панель</Button></Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-20">
        <div className="text-center max-w-3xl mx-auto">
          <h1 className="text-5xl font-bold tracking-tight">
            Онлайн-запись для салонов красоты
          </h1>
          <p className="mt-6 text-xl text-muted-foreground">
            Управляйте записями десятков салонов из одной панели. WhatsApp-подтверждения,
            календарь мастеров, отчёты — всё в одном месте.
          </p>
          <div className="mt-8 flex gap-3 justify-center">
            <Link to="/admin"><Button size="lg">Перейти в панель</Button></Link>
          </div>
        </div>

        <div className="grid md:grid-cols-4 gap-4 mt-20">
          {[
            { icon: Calendar, title: "Календарь мастеров", desc: "День/неделя, drag-and-drop" },
            { icon: Users, title: "Мульти-салон", desc: "Один кабинет, много салонов" },
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
              Платформа онлайн-записи для салонов красоты с WhatsApp-уведомлениями.
            </p>
            <p className="mt-4 text-sm">
              <Link to="/privacy" className="text-muted-foreground underline hover:text-foreground">
                Политика конфиденциальности
              </Link>
            </p>
          </div>

          <div className="text-sm text-muted-foreground">
            <div className="font-semibold text-foreground">Реквизиты</div>
            <address className="mt-2 space-y-1 not-italic">
              <div>ИП Акбаров Рамис Нургазыбекович</div>
              <div>ИНН: 22505200950633</div>
              <div>Кыргызская Республика, г. Бишкек, ул. Исакеева Б, дом 18/5, кв. 40</div>
              <div>
                Телефон:{" "}
                <a href="tel:+996707111726" className="hover:text-foreground">
                  +996 707 111 726
                </a>
              </div>
              <div>
                Email:{" "}
                <a href="mailto:ramisakbarovvv@gmail.com" className="hover:text-foreground">
                  ramisakbarovvv@gmail.com
                </a>
              </div>
            </address>
          </div>
        </div>

        <div className="border-t">
          <div className="container mx-auto px-4 py-4 text-xs text-muted-foreground">
            © {new Date().getFullYear()} Qabyl · ИП Акбаров Рамис Нургазыбекович
          </div>
        </div>
      </footer>
    </div>
  );
}
