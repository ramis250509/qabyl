import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { I18nProvider } from "@/lib/i18n";

import { THEME_BOOTSTRAP } from "@/lib/theme";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Страница не найдена</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Возможно, ссылка устарела или страница была перемещена.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Не удалось загрузить страницу
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Произошла ошибка на нашей стороне. Попробуйте обновить страницу или вернуться на главную.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Попробовать снова
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            На главную
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // Подтверждение домена для бизнес-портфолио Qabyl 1 (business_id 1212172691984078).
      // React дедуплицирует meta по name — второй такой тег молча вытеснит этот.
      { name: "facebook-domain-verification", content: "jxl0lw6rrlvw8aeqka03i008w5x7ds" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#ffffff" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "Qabyl" },
      { title: "Qabyl — онлайн-запись для сферы услуг" },
      {
        name: "description",
        content:
          "Qabyl — платформа онлайн-записи для салонов, барбершопов, клиник и мастеров: календарь специалистов, WhatsApp-уведомления и собственный сайт салона.",
      },
      { name: "author", content: "Qabyl" },
      { property: "og:site_name", content: "Qabyl" },
      { property: "og:title", content: "Qabyl — онлайн-запись для сферы услуг" },
      {
        property: "og:description",
        content:
          "Платформа онлайн-записи для сферы услуг: календарь специалистов, WhatsApp-уведомления и сайт салона.",
      },
      { property: "og:type", content: "website" },
      { property: "og:locale", content: "ru_RU" },
      { property: "og:locale:alternate", content: "ky_KG" },
      { property: "og:image", content: "https://qabyl.com/og-image.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Qabyl — онлайн-запись для сферы услуг" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Qabyl — онлайн-запись для сферы услуг" },
      {
        name: "twitter:description",
        content:
          "Платформа онлайн-записи для сферы услуг: календарь специалистов, WhatsApp-уведомления и сайт салона.",
      },
      { name: "twitter:image", content: "https://qabyl.com/og-image.png" },
    ],
    links: [
      // Onest — единственный сторонний ресурс в шапке. preconnect стоит до него: без него
      // браузер узнаёт про fonts.gstatic.com только прочитав CSS, и первый текст на экране
      // успевает моргнуть системным шрифтом.
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "icon", type: "image/png", sizes: "192x192", href: "/icon-192.png" },
      { rel: "icon", type: "image/png", sizes: "512x512", href: "/icon-512.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning — из-за скрипта темы ниже.
    //
    // Он ставит класс `dark` на <html> ДО гидратации, и сервер об этом знать не может: ни
    // системная настройка браузера, ни выбор из localStorage до него не доезжают. React при
    // гидратации видит расхождение и один раз пишет о нём в консоль — на <html> подавление до
    // него не доходит, и убрать эту строчку можно было бы только хранением темы в cookie,
    // то есть ради одной строки в консоли разработчика.
    //
    // Расхождение здесь безвредно и проверено: React пишет «this won't be patched up», то есть
    // класс остаётся на месте, тема применяется, страница отрисовывается правильно. Цена
    // альтернативы — вспышка белого экрана в лицо тому, кто открыл кабинет ночью.
    <html lang="ru" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Тема ставится ДО первой отрисовки. Если делать это из React, страница успевает
            нарисоваться светлой и только потом темнеет — вспышка белого в лицо тому, кто
            открыл кабинет ночью. Скрипт синхронный и крошечный: см. src/lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
        <Toaster richColors position="top-center" />
      </I18nProvider>
    </QueryClientProvider>
  );
}
