import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar, Users, MessageCircle, BarChart3 } from "lucide-react";
import { PublicBooking } from "@/components/book/PublicBooking";
import { SalonSite } from "@/components/site/SalonSite";
import { BookingSuspended } from "@/components/book/BookingSuspended";
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
  const [hostBlocked, setHostBlocked] = useState(false);
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
        if (data && data.length > 0) {
          setHostSalon(data[0]);
          // Подписка салона не оплачена — вместо сайта страница «запись временно недоступна».
          (supabase as any)
            .rpc("billing_salon_is_blocked", { _salon_id: data[0].id })
            .then(({ data: blocked }: any) => {
              if (!cancelled) setHostBlocked(blocked === true);
            });
        }
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
    if (hostBlocked) return <BookingSuspended salon={hostSalon} />;
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
      {/* Кнопка на посадочной вела в /admin — то есть в редирект на вход. Для человека, который
          видит Qabyl впервые, это тупик: он не понял, можно ли попробовать. Главное действие
          теперь одно и называется тем, что делает. */}
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="text-lg font-semibold">Qabyl</div>
          <p className="mt-3 flex gap-4 text-sm">
            <a className="underline" href="/pricing">
              Тарифы
            </a>
            <a className="underline" href="/payments">
              Оплата и возврат
            </a>
          </p>
          <div className="flex gap-2">
            {/* Вход — второстепенное действие и ведёт сразу в форму входа: для того, кто
                уже клиент, лишний клик по «Уже есть аккаунт?» — это просто лишний клик. */}
            <Link to="/auth" search={{ mode: "login" } as any}>
              <Button variant="ghost">Войти</Button>
            </Link>
            <Link to="/auth">
              <Button>Начать бесплатно</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Записывайте клиентов, пока вы работаете
          </h1>
          <p className="mt-6 text-lg text-muted-foreground sm:text-xl">
            Qabyl отвечает клиентам в WhatsApp, подбирает свободное время и записывает их сам —
            круглосуточно. Салоны красоты, барбершопы, массаж, косметология, клиники.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/auth">
              <Button size="lg">Создать салон за 5 минут</Button>
            </Link>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Без установки и без разработчика. Карта для старта не нужна.
          </p>
        </div>

        {/* Три шага вместо списка возможностей. Возможности отвечают на вопрос «что умеет», а
            человек на этой странице задаёт другой: «сколько мне это будет стоить усилий». */}
        <div className="mx-auto mt-20 grid max-w-4xl gap-6 sm:grid-cols-3">
          {[
            {
              n: "1",
              title: "Заведите салон",
              desc: "Название, сфера, город. Прайс подставим готовый — останется поправить цены.",
            },
            {
              n: "2",
              title: "Подключите WhatsApp",
              desc: "Одна кнопка и вход в Facebook. WhatsApp Business на телефоне продолжит работать.",
            },
            {
              n: "3",
              title: "Получайте записи",
              desc: "Клиент пишет — ассистент отвечает и записывает. Вы видите всё в календаре.",
            },
          ].map((s) => (
            <div key={s.n}>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {s.n}
              </div>
              <h3 className="mt-3 font-semibold">{s.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-20 grid gap-4 md:grid-cols-4">
          {[
            {
              icon: MessageCircle,
              title: "Ассистент в WhatsApp",
              desc: "Отвечает и записывает 24/7",
            },
            { icon: Calendar, title: "Календарь мастеров", desc: "День и неделя, перенос мышкой" },
            { icon: Users, title: "Филиалы и команда", desc: "Один кабинет, много точек" },
            { icon: BarChart3, title: "Статистика", desc: "Выручка, загрузка, топ услуг" },
          ].map((f) => (
            <Card key={f.title} className="p-6">
              <f.icon className="mb-3 h-8 w-8 text-primary" />
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.desc}</p>
            </Card>
          ))}
        </div>

        <div className="mx-auto mt-20 max-w-2xl rounded-2xl border bg-card p-8 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">Попробуйте на своём салоне</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Настройка занимает пять минут, и после неё у вас уже есть страница записи, которую можно
            отправить клиентам.
          </p>
          <Link to="/auth" className="mt-6 inline-block">
            <Button size="lg">Начать бесплатно</Button>
          </Link>
        </div>
      </main>

      <section className="container mx-auto px-4 py-12" aria-labelledby="pricing-title">
        <h2 id="pricing-title" className="text-2xl font-semibold">
          Тарифы Qabyl
        </h2>
        <p className="mt-3 text-muted-foreground">
          Start — 4 499 сом · Pro — 6 499 сом · Business — 10 499 сом в месяц.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Онлайн-запись, команда и сообщения клиентам. Начните с бесплатного пробного периода без
          карты.
        </p>
        <a className="mt-4 inline-block underline" href="/pricing">
          Сравнить возможности и условия тарифов
        </a>
      </section>
      <footer className="border-t bg-muted/30">
        <div className="container mx-auto grid gap-8 px-4 py-12 md:grid-cols-2">
          <div>
            <div className="text-lg font-semibold">Qabyl</div>
            <p className="mt-3 flex gap-4 text-sm">
              <a className="underline" href="/pricing">
                Тарифы
              </a>
              <a className="underline" href="/payments">
                Оплата и возврат
              </a>
            </p>
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
            {/* Латиница для ревью Meta: свидетельство ИП и поданная анкета — на кириллице,
                поэтому это дополнение для проверяющего, а не замена реквизитов выше. */}
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground/80" lang="en">
              Sole proprietor Akbarov Ramis Nurgazybekovich · Tax ID 22505200950633 · Registration
              no. 001-2026-169-2385 · Isakeeva B St. 18/5, apt. 40, Bishkek, Kyrgyz Republic ·{" "}
              <a href="tel:+996556108099" className="hover:text-foreground">
                +996 556 108 099
              </a>{" "}
              ·{" "}
              <a href="mailto:support@qabyl.com" className="hover:text-foreground">
                support@qabyl.com
              </a>
            </p>
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
