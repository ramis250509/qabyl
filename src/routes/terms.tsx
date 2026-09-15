import { LegalLinks } from "@/components/billing/LegalLinks";
import { createFileRoute, Link } from "@tanstack/react-router";

const CONTACT_EMAIL = "support@qabyl.com";
const LAST_UPDATED = "14 сентября 2026";
const LAST_UPDATED_EN = "September 14, 2026";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Условия использования — Qabyl" },
      {
        name: "description",
        content:
          "Условия использования платформы Qabyl: кто оказывает услугу, что входит в сервис, обязанности салона и правила работы с каналами WhatsApp и Instagram.",
      },
    ],
  }),
  component: TermsOfService,
});

function TermsOfService() {
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
      <h1 className="text-3xl font-bold tracking-tight">Условия использования</h1>
      <p className="mt-2 text-sm text-muted-foreground">Последнее обновление: {LAST_UPDATED}</p>

      <div className="mt-10 space-y-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="text-lg font-semibold">1. Кто оказывает услугу</h2>
          <p className="mt-3">
            Платформа Qabyl (сайт{" "}
            <a href="https://qabyl.com" className="underline">
              qabyl.com
            </a>
            ) принадлежит и управляется индивидуальным предпринимателем Акбаровым Рамисом
            Нургазыбековичем, зарегистрированным в Кыргызской Республике.
          </p>
          <address className="mt-3 space-y-1 not-italic text-muted-foreground">
            <div>ИП Акбаров Рамис Нургазыбекович</div>
            <div>ИНН: 22505200950633</div>
            <div>Регистрационный номер: 001-2026-169-2385</div>
            <div>
              Кыргызская Республика, г. Бишкек, Октябрьский р-н, Кара-Жыгач ж/м, улица Исакеева Б,
              дом 18/5, кв. 40
            </div>
            <div>
              Email:{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
                {CONTACT_EMAIL}
              </a>
            </div>
          </address>
          <p className="mt-3">
            Далее по тексту — «Qabyl» или «мы». «Салон» — юридическое лицо, индивидуальный
            предприниматель или частный мастер, использующий платформу для приёма записей. «Клиент»
            — конечный посетитель, который записывается к салону.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">2. Что такое Qabyl</h2>
          <p className="mt-3">
            Qabyl — программное обеспечение по модели SaaS для онлайн-записи в сфере услуг.
            Платформа предоставляет салону:
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>календарь записей, справочник услуг, мастеров и филиалов;</li>
            <li>страницу онлайн-записи и сайт салона;</li>
            <li>
              приём и обработку сообщений в WhatsApp и Instagram Direct от имени салона, включая
              автоматического ассистента, который помогает клиенту записаться;
            </li>
            <li>подтверждения и напоминания о визите;</li>
            <li>статистику по записям и загрузке мастеров.</li>
          </ul>
          <p className="mt-3">
            Qabyl не оказывает услуги красоты, медицинские или иные услуги салона, не является
            стороной договора между салоном и его клиентом и не несёт ответственности за качество,
            стоимость и исполнение этих услуг.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">3. Аккаунт и доступ</h2>
          <p className="mt-3">
            Для работы с платформой салон создаёт аккаунт. Салон отвечает за достоверность указанных
            данных, за сохранность паролей и за действия всех сотрудников, которым он выдал доступ.
            О любом подозрении на несанкционированный доступ следует немедленно сообщить нам.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">4. Стоимость</h2>
          <p className="mt-3">
            Состав тарифов, стоимость и пробный период опубликованы на{" "}
            <a className="underline" href="/pricing">
              странице тарифов
            </a>
            . Способы оплаты, продление, отмена и порядок обращения за возвратом описаны в{" "}
            <a className="underline" href="/payments">
              условиях оплаты
            </a>
            . Автоматические платежи готовятся к подключению и потребуют отдельного согласия.
          </p>
          <p className="mt-3">
            Стоимость сторонних сервисов, которые салон подключает самостоятельно (например, тарифы
            провайдера WhatsApp или платные функции Meta), оплачивается салоном напрямую поставщику
            и в стоимость Qabyl не входит.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">5. Обязанности салона</h2>
          <p className="mt-3">Используя Qabyl, салон подтверждает, что:</p>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>
              он является законным владельцем подключаемых аккаунтов WhatsApp Business и Instagram
              либо имеет прямое разрешение владельца на их использование;
            </li>
            <li>
              он получил согласие своих клиентов на обработку их персональных данных и на получение
              сообщений о записи;
            </li>
            <li>
              содержание переписки, описания услуг, цены и загружаемые материалы соответствуют
              законодательству и не нарушают прав третьих лиц;
            </li>
            <li>
              он соблюдает политики Meta Platforms, включая условия WhatsApp Business и Instagram, и
              не использует платформу для рассылки нежелательных сообщений.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold">6. Данные и роли сторон</h2>
          <p className="mt-3">
            В отношении персональных данных клиентов салон выступает владельцем данных и определяет
            цели их обработки, а Qabyl обрабатывает эти данные по поручению салона и исключительно
            для работы платформы. Мы не продаём данные и не используем переписку клиентов салона для
            сторонней рекламы. Подробности — в{" "}
            <Link to="/privacy" className="underline">
              Политике конфиденциальности
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">7. Сторонние сервисы</h2>
          <p className="mt-3">
            Для работы платформы используются сторонние сервисы: WhatsApp и Instagram (Meta
            Platforms) для обмена сообщениями, поставщики облачной базы данных и хостинга, а также
            сервис генеративного ИИ для формирования ответов ассистента. Доступность и правила этих
            сервисов определяются их поставщиками; их сбои или изменения условий могут временно
            влиять на работу Qabyl.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">8. Недопустимое использование</h2>
          <p className="mt-3">Запрещается использовать платформу для:</p>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>массовых рассылок и сообщений без согласия получателя;</li>
            <li>обмана, мошенничества или выдачи себя за другое лицо или организацию;</li>
            <li>размещения незаконных, оскорбительных материалов или материалов 18+;</li>
            <li>
              попыток обойти технические ограничения, нагрузочных атак, автоматизированного сбора
              чужих данных;
            </li>
            <li>перепродажи доступа к платформе третьим лицам без нашего согласия.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold">9. Доступность и ответственность</h2>
          <p className="mt-3">
            Мы прилагаем разумные усилия для бесперебойной работы платформы, но не гарантируем её
            непрерывность: возможны плановые работы, сбои у поставщиков связи и хостинга.
            Ответственность Qabyl ограничена суммой, фактически уплаченной салоном за использование
            платформы за последние три месяца. Мы не отвечаем за упущенную выгоду салона и за
            последствия действий его сотрудников или клиентов.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">10. Приостановка и прекращение</h2>
          <p className="mt-3">
            Салон может прекратить использование платформы в любой момент, сообщив нам об этом. Мы
            вправе приостановить или прекратить доступ при нарушении настоящих условий, политик Meta
            или законодательства, а также при поступлении обоснованных жалоб. После закрытия
            аккаунта данные удаляются в течение 30 дней; до истечения этого срока салон может
            запросить выгрузку своих данных.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">11. Изменения условий</h2>
          <p className="mt-3">
            Мы можем обновлять настоящие условия. Актуальная редакция всегда доступна по адресу
            qabyl.com/terms с датой последнего обновления. О существенных изменениях мы уведомляем
            салоны заранее. Продолжение использования платформы после вступления изменений в силу
            означает согласие с ними.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">12. Применимое право</h2>
          <p className="mt-3">
            К настоящим условиям применяется законодательство Кыргызской Республики. Споры стороны
            стремятся решить переговорами, а при недостижении согласия — в судах по месту
            регистрации ИП.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">13. Контакты</h2>
          <p className="mt-3">
            По вопросам об условиях использования пишите на{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>

        <hr className="border-border" />

        {/* English version — Meta review is in English, so we provide it inline. */}
        <section className="space-y-6">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Terms of Service</h2>
          <p className="text-xs text-muted-foreground">Last updated: {LAST_UPDATED_EN}</p>

          <div>
            <h3 className="font-semibold">1. Who provides the service</h3>
            <p className="mt-2">
              The Qabyl platform (qabyl.com) is owned and operated by Akbarov Ramis Nurgazybekovich,
              a sole proprietor registered in the Kyrgyz Republic (Tax ID 22505200950633,
              registration number 001-2026-169-2385, Bishkek, Kyrgyz Republic). Referred to below as
              "Qabyl" or "we". A "Salon" is the business or independent professional using the
              platform to take bookings; a "Client" is the end customer booking an appointment.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">2. What Qabyl is</h3>
            <p className="mt-2">
              Qabyl is SaaS software for online appointment booking in the service industry. It
              gives a Salon a booking calendar, a service and staff directory, a public booking page
              and salon website, statistics, and handling of WhatsApp and Instagram Direct messages
              on the Salon's behalf — including an automated assistant that helps a Client complete
              a booking.
            </p>
            <p className="mt-2">
              Qabyl does not provide beauty, medical or any other services offered by a Salon, is
              not a party to the agreement between a Salon and its Client, and is not responsible
              for the quality, price or delivery of those services.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">3. Accounts</h3>
            <p className="mt-2">
              A Salon creates an account to use the platform and is responsible for the accuracy of
              the details it provides, for keeping its credentials secure, and for the actions of
              every staff member it grants access to. Please notify us immediately of any suspected
              unauthorised access.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">4. Fees</h3>
            <p className="mt-2">
              Subscription terms are agreed with each Salon before onboarding. As of the date of
              these terms, basic access to the platform is provided at no subscription fee. If a
              paid plan is introduced, we will notify the Salon in advance and it may stop using the
              platform without penalty. Third-party costs the Salon arranges directly (for example a
              WhatsApp provider's fees or paid Meta features) are paid by the Salon to that provider
              and are not included in Qabyl.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">5. Salon obligations</h3>
            <p className="mt-2">By using Qabyl, the Salon confirms that:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                it lawfully owns the connected WhatsApp Business and Instagram accounts, or has the
                owner's explicit permission to use them;
              </li>
              <li>
                it has obtained its Clients' consent to process their personal data and to receive
                booking-related messages;
              </li>
              <li>
                its message content, service descriptions, prices and uploaded materials comply with
                applicable law and do not infringe third-party rights;
              </li>
              <li>
                it complies with Meta Platforms policies, including the WhatsApp Business and
                Instagram terms, and does not use the platform to send unsolicited messages.
              </li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold">6. Data and the roles of the parties</h3>
            <p className="mt-2">
              With respect to Client personal data, the Salon is the data controller and determines
              the purposes of processing; Qabyl processes that data on the Salon's instructions and
              solely to operate the platform. We do not sell data and do not use Salon Client
              conversations for third-party advertising. See our{" "}
              <Link to="/privacy" className="underline">
                Privacy Policy
              </Link>{" "}
              for details.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">7. Third-party services</h3>
            <p className="mt-2">
              The platform relies on third-party services: WhatsApp and Instagram (Meta Platforms)
              for messaging, cloud database and hosting providers, and a generative AI service that
              produces the assistant's replies. Their availability and terms are set by those
              providers, and their outages or policy changes may temporarily affect Qabyl.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">8. Prohibited use</h3>
            <p className="mt-2">
              The platform must not be used for bulk or unsolicited messaging; fraud, deception or
              impersonation; unlawful, abusive or adult content; attempts to circumvent technical
              limits, denial-of-service attacks or automated scraping of other parties' data; or
              reselling access to the platform without our consent.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">9. Availability and liability</h3>
            <p className="mt-2">
              We make reasonable efforts to keep the platform running but do not guarantee
              uninterrupted availability: maintenance windows and failures at connectivity and
              hosting providers are possible. Qabyl's liability is limited to the amount actually
              paid by the Salon for use of the platform over the preceding three months. We are not
              liable for a Salon's lost profits or for the actions of its staff or Clients.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">10. Suspension and termination</h3>
            <p className="mt-2">
              A Salon may stop using the platform at any time by notifying us. We may suspend or
              terminate access for breach of these terms, of Meta policies or of applicable law, or
              upon substantiated complaints. After an account is closed, data is deleted within 30
              days; a Salon may request an export of its data before that period ends.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">11. Changes to these terms</h3>
            <p className="mt-2">
              We may update these terms. The current version is always available at qabyl.com/terms
              with its last-updated date. We notify Salons of material changes in advance, and
              continued use after the changes take effect constitutes acceptance.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">12. Governing law</h3>
            <p className="mt-2">
              These terms are governed by the law of the Kyrgyz Republic. The parties will seek to
              resolve disputes by negotiation and, failing that, in the courts at the place of the
              sole proprietor's registration.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">13. Contact</h3>
            <p className="mt-2">
              For questions about these terms, contact us at{" "}
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
