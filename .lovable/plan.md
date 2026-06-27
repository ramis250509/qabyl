
## 1. Архитектурное замечание (важно)

WhatsApp-вебхук у Qabyl — это **не** Supabase Edge Function, а TanStack server-route: `src/routes/api/public/wa.$salonId.ts` + серверный модуль `src/lib/wa-agent.server.ts`. Переписываем их (а не создаём Edge Function), чтобы не плодить второй runtime и сохранить общий `supabaseAdmin`, типы и логику нотификаций.

Модель — напрямую через Google AI Studio по ключу `GEMINI_API_KEY` (REST, без npm-пакета `@google/generative-ai`, чтобы не тянуть Node-only зависимости в Worker). Дефолт — `gemini-1.5-flash`, для фото-оценки и сложных шагов — `gemini-1.5-pro`. Lovable AI Gateway для WhatsApp-агента выключаем полностью.

## 2. Миграция БД (lock + state machine + цена)

Добавляем в `public.wa_conversations`:
- `processing_lock_until timestamptz` — мягкий лок на одну активную обработку номера.
- `processing_lock_id uuid` — id текущего worker'а, чтобы только он мог снять лок.
- `state text not null default 'idle'` — состояние машины: `idle | collecting | awaiting_photo | priced | awaiting_master_choice | booking | done`.
- `state_data jsonb not null default '{}'` — текущий выбор: `service_id, master_id?, branch_id?, day, part_of_day, slot_start, slot_end, candidate_masters[], priced_value, photo_paths[]`.
- `pending_message_ids text[] not null default '{}'` — для слияния гонок.

Атомарный захват лока делается одним `UPDATE ... WHERE (lock истёк OR null) RETURNING id` — если строка не вернулась, второй вебхук ждёт (короткий polling, до ~8 сек) и потом подхватывает свежее состояние/сообщения уже обработанной сессии.

В `public.appointments` ничего не меняем — `price` мы уже умеем передавать в `create_appointment` (расширим RPC только если потребуется, см. §6).

## 3. Секрет

Запрашиваем у пользователя `GEMINI_API_KEY` через `add_secret` (отдельным сообщением после плана). Серверный код читает `process.env.GEMINI_API_KEY` только в обработчике.

## 4. Анти-гонка вебхуков (Green-API часто шлёт два webhook'а параллельно)

В `wa.$salonId.ts`:
1. Принимаем payload → как сейчас, дедуп по `green_api_message_id`, всегда отвечаем 200.
2. Кладём входящее сообщение в `wa_messages` **до** попытки лока.
3. Пытаемся атомарно взять лок на `wa_conversations` (TTL ~25 сек).
4. Если лок не взят — выходим. Активный worker сам подберёт сообщение в шаге 5 (он перечитывает `wa_messages` после каждого тура агента, пока есть необработанные новые входящие).
5. Активный worker внутри цикла: загрузить новые `in`-сообщения с `processed_at IS NULL`, слить их в один логический ход, прогнать через агента, ответить одним сообщением, пометить входящие как processed, и если за время хода пришли новые — повторить цикл (максимум 3 итерации, потом снять лок).
6. На любой ошибке: снимаем лок, пишем `meta.fatalError`, отвечаем ровно один раз дружелюбной фразой и **не** залипаем — следующее сообщение клиента берёт чистый лок (баг «бесконечная заглушка» уходит, потому что лок и состояние не остаются в «битом» состоянии).

Добавляем в `wa_messages` колонку `processed_at timestamptz` (миграция).

## 5. Машина состояний (вместо свободного tool-loop)

`src/lib/wa-agent.server.ts` переписываем вокруг явного state-machine. Gemini используется как:
- **Классификатор намерения** на каждом ходе (`intent: greet|choose_service|choose_master|choose_time|confirm|cancel|ask_price|smalltalk|other`, + извлечённые сущности).
- **Генератор финального текста** ответа (1 сообщение) на текущем языке клиента (ru/ky/en, авто-детект).

Переходы состояний и работа со слотами/мастерами идут детерминированным TS-кодом, не моделью. Это убирает баги «слоты прыгают» и «бот теряет контекст» — модель больше не выбирает время сама.

Алгоритм по состояниям (кратко):
- `collecting` — добираем недостающие поля (`service`, `day`, `part_of_day`). Услугу и день парсим из intent-результата, валидируем по БД. Для «сегодня» берём now() в `salon.timezone`.
- На запрос слотов: вызываем `get_available_slots` для всех мастеров услуги, объединяем, **фильтруем по part_of_day и по now()+15мин** (отсекаем прошедшее время суток на сегодня), сохраняем стабильный массив `state_data.slots` (id → start/end + masters[]). Показываем клиенту максимум 3 окна.
- При выборе времени:
  - если на это окно ровно один мастер → переходим к `booking`;
  - если несколько → `awaiting_master_choice`, спрашиваем «свободны Улуу и Алина, к кому или непринципиально?». Если «непринципиально» — берём первого по `sort_order`.
- Для услуг с `price_type='range'`: до показа слотов переходим в `awaiting_photo`, отвечаем фиксированной фразой «пришлите фото». Когда приходит `imageMessage` — отдельным вызовом `gemini-1.5-pro` с `inline_data` (base64 скачанного из `wa-media` файла) + `pricing_rules` салона; модель возвращает строго JSON `{price:number, explanation:string}`, цена клампится в `[price, price_max]`. Озвучиваем цену, ждём подтверждения, затем продолжаем как обычно — `state_data.priced_value` идёт в `appointments.price` через расширенный вызов RPC (см. §6).
- `booking` — вызываем `public.create_appointment(...)`. После успеха:
  - ставим `status='booked'`, `last_appointment_at=now()`, `state='done'`;
  - **отключаем стандартное WhatsApp-подтверждение** для этой записи (см. §7);
  - отправляем единственное сообщение от ассистента с подтверждением.

Если на любом шаге `intent='cancel'` или клиент явно меняет услугу/день — сбрасываем `state_data` и возвращаемся в `collecting`, не теряя выбранную услугу, если не было явной отмены.

## 6. Цена из диапазона при бронировании

`create_appointment` сейчас всегда берёт `services.price`. Расширяем RPC одним опциональным параметром `_price_override numeric default null` (только для `price_type='range'`, и только в пределах `[price, price_max]` — иначе ошибка). Агент передаёт `priced_value` туда; виджет и админ продолжают работать без изменений.

## 7. Убрать дубль подтверждающего WhatsApp

Триггер `dispatch_whatsapp_confirmation` шлёт стандартное «вы записаны…» на каждый INSERT в `appointments`. Когда запись создал агент, это даёт второе сообщение поверх ответа ассистента.

Решение: добавляем в `appointments` колонку `source text default 'manual'` (`manual|widget|ai_assistant`) и в триггере `dispatch_whatsapp_confirmation` пропускаем строки с `source='ai_assistant'`. Агент при создании записи помечает её этим источником (через тот же расширенный RPC).

## 8. Фильтр прошедшего времени и дат

В системный промпт и в TS-логику передаём `now_iso`, `today_local`, `tomorrow_local`, `weekday_local` (вычисляем по `salon.timezone`). Слоты на «сегодня» дополнительно фильтруются `slot_start > now() + 15 минут`, а `part_of_day` отсекает утро/день, если они уже прошли — клиенту просто не предлагаются, и ассистент сам предлагает «на сегодня свободно только вечером, или давайте на завтра?».

## 9. UI: «ИИ Ассистент» → «Ассистент»

Замены строк только в презентационных файлах: `src/components/admin/AiAssistantTab.tsx`, и в местах, где вкладка добавляется в `src/routes/admin/salons/$salonId.tsx`. Без бизнес-логики.

## 10. Технические детали реализации

- HTTP к Gemini: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=${GEMINI_API_KEY}`, JSON-mode через `response_mime_type: "application/json"` + `response_schema` для intent-классификатора, обычный текст для финальной реплики.
- Фото: качаем подписанным URL из `wa-media` (как уже делает webhook), отдаём как `inline_data { mime_type, data: base64 }`. Лимит — 1 фото на запрос, размер режем до ≤ 4 МБ.
- Ретраи: только 429/5xx, максимум 2 попытки с экспоненциальной паузой; 4xx — терминальная ошибка, снимаем лок, отвечаем дружелюбно, **не зацикливаемся**.
- Языки: `languages` из `salon_ai_assistant`, авто-детект по последнему сообщению (простая эвристика на кириллицу/латиницу/кыргызские буквы), форсим язык ответа в финальном промпте.
- Удаляем зависимость WhatsApp-агента от `src/lib/ai-gateway.server.ts` (Lovable Gateway больше не используется этим путём; в остальных местах оставляем как есть).

## 11. Файлы, которые меняются

- `supabase` миграция: новые колонки в `wa_conversations`, `wa_messages.processed_at`, `appointments.source`, обновлённая `create_appointment` (доп. параметры), обновлённый `dispatch_whatsapp_confirmation`.
- `src/lib/wa-agent.server.ts` — полная переписка под state-machine + прямой Gemini REST.
- `src/routes/api/public/wa.$salonId.ts` — лок сессии, цикл обработки, передача state.
- `src/components/admin/AiAssistantTab.tsx`, `src/routes/admin/salons/$salonId.tsx` — переименование «ИИ Ассистент» → «Ассистент».

## 12. Проверка после имплементации

- curl на server-route с фейковым `incomingMessageReceived` (token из `salon_secrets`): два параллельных запроса должны дать ровно один ответ.
- Через `psql` — проверка, что `appointments` создаётся с `source='ai_assistant'` и стандартный WhatsApp-конферматор не зовётся.
- Реальный тест в WhatsApp по сценариям: (a) «запиши на сегодня вечером», (b) услуга с диапазоном цены + фото, (c) «на 14:00» при двух свободных мастерах.

## 13. Что НЕ делаем в этом плане

- Не трогаем виджет публичной записи и админ-календарь.
- Не переносим другие AI-функции платформы (Lovable Gateway остаётся для них, если они есть).
- Не вводим отдельную таблицу `whatsapp_sessions` — `wa_conversations` + новые колонки достаточно.
