# Instagram App Review: сценарий пересъёмки

Приложение: **Qabyl AI Admin** (App ID `1938248030209290`), Instagram-часть «Qabyl AI Admin-IG»
(Instagram app ID `1723210638757354`).

## Итог прошлой заявки (решение от 16.09.2026)

| Разрешение                                                                      | Итог         |
| ------------------------------------------------------------------------------- | ------------ |
| `instagram_business_basic`                                                      | ✅ одобрено  |
| `instagram_business_manage_messages`                                            | ❌ отклонено |
| `instagram_business_manage_comments`                                            | ❌ отклонено |
| `public_profile`, `whatsapp_business_messaging`, `whatsapp_business_management` | ✅ продлены  |

Причина отказа по обоим разрешениям: **«Screencast Not Aligned with Use Case Details»**. Meta
прямо пишет, что сам сценарий использования допустим («your app's use case is allowed»). Не
понравилось видео.

Замечание проверяющего по `manage_messages`, дословно по смыслу: в видео не видно, как сообщение
**отправляется из интерфейса Qabyl** и **то же сообщение появляется в самом Instagram**. Нужно
показать: (1) выбранный аккаунт, (2) живую отправку из нашего приложения, (3) доставленное
сообщение в приложении Instagram.

Общие требования ко всем видео:

1. Полный вход через Meta (Instagram Business Login).
2. Экран, где пользователь выдаёт разрешения.
3. Сценарий от начала до конца, ровно как он описан в тексте заявки.
4. **Английский интерфейс**, субтитры, пояснения к кнопкам.
5. Если приложение работает сервер-сервер или на system user token, это надо указать.

## Что было не так у нас и что исправлено в коде

1. **Кабинет был только на русском, английского не было даже в переключателе.** Теперь внизу
   бокового меню есть **RU / EN**. На английский переведены все экраны из видео: меню, вкладки
   салона, «Каналы», страница Instagram, «Переписки». Салонам по умолчанию по-прежнему показывается русский.
2. **После входа в Instagram кабинет открывался на WhatsApp**, а не на Instagram. Результат
   подключения и имя аккаунта были не видны, пока не нажмёшь «Instagram». Теперь возврат сразу
   открывает страницу Instagram с `@аккаунтом`.
3. **Подключённый аккаунт виден всегда**: на странице Instagram («Connected to Instagram —
   account @…») и прямо под полем ответа в «Переписках» («Your reply is sent in Instagram Direct as
   @…»). Это и есть «asset selection», о котором просил проверяющий.
4. Под кнопкой «Connect Instagram» перечислено, зачем Qabyl каждое разрешение (profile / messages /
   comments). Meta просит объяснять смысл кнопок в интерфейсе.
5. В «Переписках» у кнопки отправки есть подпись **Send**. Ответ владельца помечен «Sent by you from
   Qabyl», а сообщение, ушедшее в ответ на комментарий, подписано «Reply to the comment “…”».

Главная ошибка прошлого видео — не код. В видео **отвечал ИИ**, но не было кадра, где человек
печатает в Qabyl, жмёт Send и сообщение приходит в Instagram. В новом сценарии это центральная сцена.

---

## Подготовка (один раз, до записи)

1. **Выкатить код на qabyl.com** (Publish в Lovable) и убедиться, что внизу меню кабинета есть
   переключатель RU / EN.
2. **Демо-салон.** Не настоящий клиент: в видео не должно быть чужих переписок. У салона
   **одна точка**: при двух и больше на странице Instagram появляется выбор точки, он пока на
   русском. Добавьте 2–3 услуги с английскими названиями (например, `Manicure`,
   `Gel polish`), тогда ассистент ответит клиенту без русских слов.
3. **Два аккаунта Instagram:**
   - **аккаунт салона** — профессиональный (Business или Creator), например `@qabyl_demo`;
   - **аккаунт «клиента»** — обычный личный аккаунт, открыт в приложении Instagram на телефоне.
4. **Роли в приложении Meta.** Пока `manage_messages` не одобрен, переписка работает только для
   аккаунтов с ролью в приложении. Meta → приложение → App roles → Roles → Add People →
   **Instagram Tester** — добавить **оба** аккаунта. Принять приглашение в каждом Instagram:
   Настройки → Для профессионалов / Приложения и сайты → «Приглашения тестировщиков» → Принять
   (названия пунктов в Instagram слегка отличаются от версии к версии).
5. **Вебхуки в Meta App Dashboard** → Instagram → Webhooks: подписаны поля **`messages`** и
   **`comments`**.
6. **Чтобы экран разрешений точно показался в видео**, заранее отвяжите Qabyl от аккаунта салона:
   в Instagram салона → Настройки → «Приложения и сайты» (Website permissions → Apps and websites)
   → Qabyl AI Admin → Удалить. Иначе Instagram может пропустить экран разрешений как «уже выданный».
7. **В кабинете Qabyl:**
   - переключить язык на **EN** (внизу бокового меню);
   - «Каналы» → **общий выключатель «AI assistant» — On**;
   - если всплывёт экскурсия по кабинету или предложение установить приложение, закройте их;
   - откройте страницу Instagram прямой ссылкой, чтобы в кадр не попала вкладка «Основное»
     (она пока на русском): `https://qabyl.com/admin/salons/<ID салона>?tab=instagram`.
     ID салона виден в адресной строке, когда открываете «My salon».
8. **Как снимать.** Одна непрерывная запись экрана компьютера. Слева — Qabyl в браузере, справа —
   Instagram «клиента»:
   - **лучше всего:** экран телефона на компьютере. На Mac: QuickTime → «Новая видеозапись» →
     рядом с кнопкой записи выбрать iPhone как камеру, и экран телефона появится в окне;
   - **если так нельзя:** instagram.com в **другом** браузере (не в том, где открыт Qabyl), вход под
     «клиентом».
9. **Субтитры** добавить после записи в любом простом редакторе (CapCut бесплатный). Тексты
   субтитров ниже, их можно вставлять как есть. Паузы ожидания ответа вырезать.

---

## Видео 1 — `instagram_business_manage_messages` (главное, ≈2–3 мин)

Порядок важен. Сначала отвечает ассистент, потом вмешивается владелец. После ручного ответа
ассистент молчит 5 минут, так что наоборот снять не получится.

| #   | Что на экране                                                                                                                                                                  | Субтитр (English)                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Страница Instagram в Qabyl, язык EN                                                                                                                                            | Qabyl is an online booking and AI front-desk platform for beauty salons. This video shows how Qabyl uses instagram_business_manage_messages. |
| 1   | Навести на список под кнопкой (profile / messages / comments)                                                                                                                  | The salon owner opens Channels → Instagram. Qabyl explains which Instagram permissions it asks for and why.                                  |
| 2   | Нажать **Connect Instagram**                                                                                                                                                   | The owner clicks "Connect Instagram" to start Instagram Business Login.                                                                      |
| 3   | Экран входа Instagram → войти в аккаунт салона. Логин аккаунта должен быть виден                                                                                               | The owner logs in to the salon's Instagram professional account.                                                                             |
| 4   | Экран разрешений. Задержаться 2–3 сек, чтобы список прочитался. Нажать **Allow**                                                                                               | The owner grants Qabyl access: basic profile and Instagram Direct messages.                                                                  |
| 5   | Возврат в Qabyl: «Instagram is connected» и «Connected to Instagram — account @…»                                                                                              | Back in Qabyl, the connected account @qabyl_demo is shown.                                                                                   |
| 6   | Включить **AI assistant replies on Instagram**                                                                                                                                 | The owner turns on the AI assistant for Instagram Direct.                                                                                    |
| 7   | Телефон «клиента», приложение Instagram: написать салону `Hi! How much is a manicure?`                                                                                         | A client sends a Direct message to the salon from the Instagram app.                                                                         |
| 8   | Qabyl → вкладка **Chats**: сообщение клиента и ответ ассистента                                                                                                                | The message arrives in Qabyl → Chats through the Instagram Messaging API. The AI assistant replies automatically.                            |
| 9   | Телефон: ответ ассистента в переписке Instagram                                                                                                                                | The assistant's reply is delivered to the client in the Instagram app.                                                                       |
| 10  | Qabyl → Chats: навести на строку «Your reply is sent in Instagram Direct as @…», напечатать `Hello from the salon team! Would tomorrow at 3 pm work for you?`, нажать **Send** | The owner types a reply in Qabyl and clicks Send. It is sent as @qabyl_demo through the Instagram API.                                       |
| 11  | В Qabyl сообщение появилось с пометкой «Sent by you from Qabyl». Телефон: **то же сообщение** в Instagram, задержаться 3 сек                                                   | The same message is delivered to the client in the native Instagram app.                                                                     |
| 12  | Финальный кадр                                                                                                                                                                 | Qabyl uses this permission only to receive clients' Direct messages and to send replies from the salon owner or the salon's AI assistant.    |

## Видео 2 — `instagram_business_manage_comments` (≈1,5–2 мин)

Начало — те же сцены 2–5 из видео 1 (вход и разрешения). Можно вставить тот же отрывок записи:
Meta ждёт вход через Meta в каждом видео.

| #   | Что на экране                                                                                                                                                                                                                                  | Субтитр (English)                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Вход и разрешения (как в видео 1)                                                                                                                                                                                                              | The salon owner connects the salon's Instagram account with Instagram Business Login and grants access to comments. |
| 2   | Qabyl → Instagram → карточка **Comment keyword → private message in Direct**: Keyword `WANT`, Private message `Hi! Thanks for your comment 🙂 Would you like to book a manicure this week?`, Public reply `Sent you a DM 💌` → **Add keyword** | The owner sets a keyword. Qabyl will watch new comments on the salon's posts for it.                                |
| 3   | Телефон «клиента»: открыть пост салона, написать комментарий `WANT`                                                                                                                                                                            | A follower comments "WANT" under the salon's post in the Instagram app.                                             |
| 4   | Телефон: под комментарием появился ответ салона `Sent you a DM 💌`                                                                                                                                                                             | Qabyl replies to the comment publicly on the salon's behalf.                                                        |
| 5   | Телефон: Direct — пришло личное сообщение от салона                                                                                                                                                                                            | …and sends the commenter one private reply in Direct.                                                               |
| 6   | Qabyl: у слова `WANT` «triggered 1»; в Chats новая переписка с пометкой «Reply to the comment “WANT”»                                                                                                                                          | The conversation appears in Qabyl → Chats, where the owner or the AI assistant continues it.                        |

Если дубль не удался: Instagram разрешает **один** личный ответ человеку, пока он не ответит.
Для повторной попытки сначала ответьте с «клиента» в Direct или комментируйте с другого аккаунта.
Комментарий должен быть не старше 7 дней.

---

## Тексты для заявки (вставлять как есть)

**`instagram_business_manage_messages` — How will your app use this permission?**

> Qabyl is an online booking and AI front-desk platform for beauty salons. The salon owner connects
> the salon's Instagram professional account in the Qabyl dashboard with Instagram Business Login.
> We use instagram_business_manage_messages to (1) receive the Direct messages that clients send to
> the salon and show them in the "Chats" section of the Qabyl dashboard, and (2) send replies to
> those clients: either a reply the salon owner types in Qabyl and sends with the "Send" button, or
> an automatic reply from the salon's AI assistant, which answers questions about services, prices
> and free time slots. Qabyl only messages clients who wrote to the salon first, and only within
> Instagram's 24-hour messaging window. The screencast shows: Instagram Business Login and the permission
> screen, the connected account (@qabyl_demo) in Qabyl, a client message arriving in Qabyl, the AI
> assistant's reply, and a reply typed and sent from the Qabyl UI, delivered to the client in the
> native Instagram app.

**`instagram_business_manage_comments` — How will your app use this permission?**

> The salon owner sets a keyword in Qabyl (for example "WANT"). We use
> instagram_business_manage_comments to receive comments on the salon's own posts through the
> comments webhook, check them for the keyword, and publish a short public reply to the matching
> comment on the salon's behalf. The commenter then receives one private reply in Direct, and the
> conversation appears in the Qabyl "Chats" section, where the salon owner or the AI assistant
> continues it. We do not read comments for any other purpose. The screencast shows: Instagram
> Business Login and the permission screen, setting the keyword in Qabyl, a follower commenting the
> keyword in the Instagram app, the public reply under the comment and the private message in the
> native Instagram app, and the resulting conversation in Qabyl.

**Notes for the reviewer (общее поле с инструкциями):**

> Qabyl is a web app: https://qabyl.com. Test login: <email демо-владельца> / <пароль>. The dashboard
> language switch (RU / EN) is at the bottom of the left menu — please select EN. Instagram settings:
> My salon → Messaging → Channels → Instagram. Conversations: My salon → Messaging → Chats.
> Qabyl is not a server-to-server app and does not use a system user token: each salon owner
> connects their own Instagram account with Instagram Business Login, and all messages are sent with
> the access token the owner granted there — including the automatic replies of the salon's AI
> assistant, which our server sends on the owner's behalf.

Раздел Data handling — те же ответы, что в заявке WhatsApp 30.08.2026: обработчики Supabase Inc.,
Cloudflare Inc., Google LLC (Gemini получает тексты сообщений). Ответственное лицо — ИП Акбаров Рамис
Нургазыбекович. Подсказки «Use This» / «Ask AI» в форме **не нажимать**: их текст утверждает, что
мы не храним данные, а мы храним переписку.

## Если одобрят сообщения, а комментарии снова нет

Кнопка «Connect Instagram» просит у Instagram все три разрешения (`IG_LOGIN_SCOPES` в
`src/lib/ig-oauth.server.ts`). Если `manage_comments` останется неодобренным, его нужно убрать из
этого списка: иначе вход у обычных салонов может ломаться на неодобренном разрешении. Правка в одну
строку. Кодовые слова в комментариях до одобрения просто не будут работать.
