# Instagram App Review — памятка для съёмки

Приложение: **Qabyl AI Admin** (App ID `1938248030209290`), Instagram-часть «Qabyl AI Admin-IG»
(Instagram app ID `1723210638757354`).

Запрашиваем три разрешения, на каждое — своё видео:

| Разрешение                           | Что показывает видео                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `instagram_business_basic`           | Подключение аккаунта кнопкой и то, что Qabyl показывает подключённый аккаунт |
| `instagram_business_manage_messages` | Клиент пишет в Direct → ассистент отвечает → запись появляется в календаре   |
| `instagram_business_manage_comments` | Комментарий с кодовым словом → личное сообщение клиенту                      |

## Перед записью (один раз)

1. Meta → приложение → **App roles → Roles → Add People → Instagram Tester** → имя аккаунта салона.
   Принять приглашение в самом Instagram: «Настройки» → «Для профессионалов» → «Приложения и
   сайты» → «Приглашения тестировщиков». До одобрения кнопка работает только для таких аккаунтов.
2. Аккаунт салона — профессиональный (Бизнес или Автор).
3. Второй, обычный Instagram-аккаунт — «клиент». Он пишет в Direct и оставляет комментарий.
4. В записи экрана — английский интерфейс кабинета или хотя бы подписи на английском: проверяющий
   Meta должен понимать, что происходит. Язык кабинета переключается внизу бокового меню.

## Видео 1 — `instagram_business_basic` (≈1 мин)

1. Открыть qabyl.com → войти → салон → вкладка «Каналы» → Instagram.
2. Нажать **«Подключить Instagram»**.
3. Показать экран входа Instagram, войти в аккаунт салона, показать экран разрешений, подтвердить.
4. Вернуться в кабинет: зелёная плашка «Instagram подключён», нажать «Проверить связь» — видно
   `@имя_аккаунта`.

## Видео 2 — `instagram_business_manage_messages` (≈2 мин)

1. Включить переключатель «Ассистент отвечает в Instagram».
2. С телефона «клиента» написать в Direct салона: «Здравствуйте, хочу записаться на маникюр завтра».
3. Показать ответ ассистента в Instagram, пройти запись до конца (ассистент попросит номер).
4. В кабинете показать переписку в разделе диалогов и запись в календаре.

## Видео 3 — `instagram_business_manage_comments` (≈1,5 мин)

1. Вкладка Instagram → «Кодовое слово в комментариях» → добавить слово, например `ХОЧУ`, и текст
   сообщения.
2. С «клиента» оставить под постом салона комментарий `ХОЧУ`.
3. Показать, что «клиенту» пришло личное сообщение, и счётчик «сработало 1» в кабинете.

## Тексты для заявки (что писать в «How will your app use this permission»)

- **basic:** Qabyl is a booking platform for beauty salons. The salon owner connects their Instagram
  professional account with Business Login so our AI assistant can answer their clients. We read the
  account id and username to show which account is connected.
- **manage_messages:** When a client writes to the salon in Instagram Direct, our assistant replies on
  the salon's behalf, answers questions about services and prices and books an appointment into the
  salon's calendar. Conversations are shown to the salon owner in the Qabyl dashboard.
- **manage_comments:** The salon owner sets a keyword (e.g. "WANT") in Qabyl. When someone comments that
  keyword under the salon's post, we send one private reply with the owner's message, after which the
  assistant continues the conversation in Direct.

Раздел Data handling — те же ответы, что в заявке WhatsApp 30.08.2026: обработчики Supabase Inc.,
Cloudflare Inc., Google LLC (Gemini получает тексты сообщений); ответственное лицо — ИП Акбаров Рамис
Нургазыбекович. Подсказки «Use This» / «Ask AI» в форме **не нажимать** — их текст утверждает, что
мы не храним данные, а мы храним переписку.
