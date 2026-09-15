import { LegalLinks } from "@/components/billing/LegalLinks";
import { createFileRoute, Link } from "@tanstack/react-router";

const CONTACT_EMAIL = "support@qabyl.com";
const LAST_UPDATED = "14 сентября 2026";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Политика конфиденциальности — Qabyl" },
      {
        name: "description",
        content:
          "Политика конфиденциальности Qabyl: какие данные мы собираем, как используем и как их удалить.",
      },
    ],
  }),
  component: PrivacyPolicy,
});

function PrivacyPolicy() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-foreground">
      <div className="mb-10">
        <Link
          to="/"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Qabyl
        </Link>
      </div>

      <LegalLinks />
      <h1 className="text-3xl font-bold tracking-tight">Политика конфиденциальности</h1>
      <p className="mt-2 text-sm text-muted-foreground">Последнее обновление: {LAST_UPDATED}</p>

      <div className="mt-10 space-y-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="text-lg font-semibold">Данные об оплате</h2>
          <p className="mt-3">
            Для учёта оплаты Qabyl обрабатывает сумму, валюту, дату, результат операции,
            идентификатор платежа и последние четыре цифры карты, если их передал платёжный
            провайдер. После подключения сохранения карты безопасный идентификатор способа оплаты
            будет доступен только серверу. Qabyl не хранит полный номер карты и код безопасности.
            Данные, необходимые для проведения платежа, передаются Freedom Pay. Подробнее —{" "}
            <a className="underline" href="/payments">
              условия оплаты
            </a>
            .
          </p>
        </section>
        <section>
          <p>
            Qabyl — платформа онлайн-записи для сферы услуг. Мы уважаем вашу конфиденциальность и
            обрабатываем персональные данные только в объёме, необходимом для работы сервиса записи
            и общения через WhatsApp.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">1. Какие данные мы собираем</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>Имя клиента</li>
            <li>Номер телефона (в том числе номер WhatsApp)</li>
            <li>Информация о записях: услуга, мастер, дата и время визита</li>
            <li>Переписка с ассистентом в WhatsApp, необходимая для оформления записи</li>
            <li>Фотографии, которые клиент добровольно отправляет для оценки услуги</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold">2. Как мы используем данные</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>Оформление и управление записями в салон</li>
            <li>Отправка подтверждений и напоминаний о визите</li>
            <li>Ответы на вопросы клиента об услугах и ценах</li>
            <li>Улучшение качества сервиса</li>
          </ul>
          <p className="mt-3">
            Мы не продаём ваши данные третьим лицам и не используем их для сторонней рекламы.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">3. Передача данных</h2>
          <p className="mt-3">
            Данные передаются только сервисам, обеспечивающим работу платформы: WhatsApp (Meta
            Platforms) — для обмена сообщениями, и нашему поставщику баз данных и хостинга. Эти
            сервисы обрабатывают данные исключительно для предоставления своих функций.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">4. Хранение и удаление</h2>
          <p className="mt-3">
            Мы храним данные ровно столько, сколько необходимо для работы сервиса. Вы можете
            запросить удаление своих данных в любой момент — мы удалим их незамедлительно. При
            закрытии аккаунта салона все связанные данные удаляются в течение 30 дней.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">5. Ваши права</h2>
          <p className="mt-3">
            Вы имеете право запросить доступ к своим данным, их исправление или удаление. Для этого
            напишите нам на{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">6. Контакты</h2>
          <p className="mt-3">
            По любым вопросам о конфиденциальности пишите на{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>

        <hr className="border-border" />

        {/* English version — Meta review is in English, so we provide it inline. */}
        <section className="space-y-6">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Privacy Policy</h2>
          <p className="text-xs text-muted-foreground">Last updated: July 3, 2026</p>

          <p>
            Qabyl is an online booking platform for service businesses. We respect your privacy and
            only process personal data to the extent necessary to run the booking service and to
            communicate over WhatsApp.
          </p>

          <div>
            <h3 className="font-semibold">1. Data we collect</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Client name</li>
              <li>Phone number (including WhatsApp number)</li>
              <li>Booking details: service, specialist, date and time</li>
              <li>WhatsApp conversation needed to complete a booking</li>
              <li>Photos a client voluntarily sends to price a service</li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold">2. How we use data</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Creating and managing salon bookings</li>
              <li>Sending booking confirmations and reminders</li>
              <li>Answering client questions about services and prices</li>
              <li>Improving the quality of the service</li>
            </ul>
            <p className="mt-2">
              We do not sell your data to third parties and do not use it for third-party
              advertising.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">3. Data sharing</h3>
            <p className="mt-2">
              Data is shared only with services that power the platform: WhatsApp (Meta Platforms)
              for messaging, and our database and hosting provider. These services process the data
              solely to provide their functionality.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">4. Retention and deletion</h3>
            <p className="mt-2">
              We keep data only as long as needed to operate the service. You may request deletion
              of your data at any time and we will remove it promptly. When a salon account is
              closed, all associated data is deleted within 30 days.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">5. Your rights</h3>
            <p className="mt-2">
              You may request access to, correction of, or deletion of your data by emailing{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </div>

          <div>
            <h3 className="font-semibold">6. Contact</h3>
            <p className="mt-2">
              For any privacy questions, contact us at{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
