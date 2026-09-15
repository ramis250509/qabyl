import { createFileRoute } from "@tanstack/react-router";
import { getPublicPricing } from "@/lib/public-pricing.functions";
import { LegalLinks } from "@/components/billing/LegalLinks";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Тарифы Qabyl — Start, Pro, Business" },
      {
        name: "description",
        content:
          "Start — 4 499 сом, Pro — 6 499 сом, Business — 10 499 сом в месяц. Онлайн-запись, календарь и сообщения для сервисного бизнеса.",
      },
    ],
    links: [{ rel: "canonical", href: "https://qabyl.com/pricing" }],
  }),
  loader: () => getPublicPricing(),
  errorComponent: () => (
    <main className="max-w-3xl mx-auto px-6 py-16 space-y-6">
      <h1 className="text-2xl font-semibold">Тарифы временно не загрузились</h1>
      <p>Уточните актуальные условия: support@qabyl.com.</p>
      <LegalLinks />
    </main>
  ),
  component: Pricing,
});
function Pricing() {
  const plans = Route.useLoaderData();
  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-12 space-y-10">
      <LegalLinks />
      <header className="max-w-2xl space-y-3">
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
          Ваш бизнес. Ваш тариф.
        </h1>
        <p className="text-muted-foreground">
          Qabyl — сервис онлайн-записи для салонов, мастеров и сервисного бизнеса: календарь,
          команда, страница записи, общение с клиентами и автоматический ассистент. Подписку
          оплачивает салон; услуги салона оплачиваются отдельно.
        </p>
      </header>
      <div className="grid gap-5 md:grid-cols-3">
        {plans.map((p) => (
          <Card key={p.code} className="p-6 flex flex-col gap-5">
            <h2 className="text-xl font-semibold">{p.name}</h2>
            <p>
              <strong className="text-3xl">{p.price.toLocaleString("ru-RU")}</strong>{" "}
              <span className="text-muted-foreground">сом / месяц</span>
            </p>
            <ul className="space-y-3 text-sm flex-1">
              {p.lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              Пробный период: {p.trialDays} дней, до {p.trialMessages.toLocaleString("ru-RU")}{" "}
              сообщений. Точные даты указаны в кабинете. Смена тарифа не начинает пробный период
              заново.
            </p>
            <p className="text-sm">
              Дополнительно: {p.packMessages.toLocaleString("ru-RU")} сообщений за{" "}
              {p.packPrice.toLocaleString("ru-RU")} сом.
            </p>
            <a
              className="rounded-md bg-primary text-primary-foreground px-4 py-3 text-center text-sm font-medium"
              href="/auth"
            >
              Начать бесплатно
            </a>
          </Card>
        ))}
      </div>
      {!plans.length && <p>Актуальный каталог обновляется. Уточните условия в поддержке.</p>}
      <section className="max-w-3xl space-y-3 text-sm text-muted-foreground">
        <h2 className="text-lg font-semibold text-foreground">Как работает подписка</h2>
        <p>
          Пробный период доступен без банковской карты. Новый салон начинает с тарифа Pro. Сообщения
          — исходящие ответы ассистента, подтверждения и напоминания; входящие сообщения не
          расходуют пакет. Лимит общий для всех филиалов салона.
        </p>
        <p>
          После пробного периода выберите тариф и оплатите месяц доступа. Доступ активируется после
          подтверждения оплаты. Оплаченный заранее месяц начинается после текущего периода.
        </p>
        <p>
          Оплата картой через Freedom Pay готовится к подключению. Доступные способы оплаты показаны
          в кабинете. Автоматические списания будут доступны только после подключения и отдельного
          согласия; сейчас они не выполняются.
        </p>
        <a className="underline" href="/payments">
          Способы оплаты, продление и возврат
        </a>
      </section>
      <LegalLinks />
    </main>
  );
}
