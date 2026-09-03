-- Gupshup Self-Serve: реквизиты и карантин событий. Этап 1 — вертикальный пилот.
--
-- ЗАЧЕМ. Пока приложение Qabyl имеет только Standard Access, оно не может обращаться к WABA чужого
-- бизнес-портфолио. Мост через Make это обходит, но стоит кредитов и не даёт статусов доставки.
-- Gupshup — BSP: у него своё одобренное приложение, WABA остаётся у салона, а платит общий кошелёк
-- Qabyl. Транспорт третий по счёту, и он встаёт на то же место, что и мост Make: в интерфейс
-- WaTransport, без второго пайплайна.
--
-- ЭТА МИГРАЦИЯ НИЧЕГО НЕ МЕНЯЕТ НИ ДЛЯ ОДНОГО САЛОНА. Все колонки необязательные, обе таблицы
-- новые, ни одно значение по умолчанию не включает новый путь. Салон уходит на Gupshup только
-- когда кто-то явно проставит ему три поля разом — см. gupshup_enabled ниже.
--
-- ОТКАТ описан в конце файла.

-- ---------------------------------------------------------------------------
-- 1. Реквизиты Gupshup, свои на каждый салон.
-- ---------------------------------------------------------------------------
-- salon_secrets доступна только service_role (REVOKE в 20260613184801), поэтому ключ сюда класть
-- можно — браузер эту строку не прочитает даже с валидной сессией салона.
alter table public.salon_secrets
  add column if not exists gupshup_app_id        text,
  add column if not exists gupshup_app_name      text,
  add column if not exists gupshup_api_key       text,
  add column if not exists gupshup_source_number text,
  add column if not exists gupshup_waba_id       text,
  add column if not exists gupshup_webhook_token text,
  add column if not exists gupshup_enabled       boolean not null default false,
  add column if not exists gupshup_connected_at  timestamptz,
  add column if not exists gupshup_last_event_at timestamptz,
  add column if not exists gupshup_last_error    text,
  add column if not exists gupshup_last_error_at timestamptz;

comment on column public.salon_secrets.gupshup_app_name is
  'Имя приложения Gupshup (поле "app" в каждом событии). Второй ключ сверки после токена в адресе вебхука: одного адреса мало, потому что адрес не секрет.';
comment on column public.salon_secrets.gupshup_api_key is
  'Ключ Access API. Уходит заголовком apikey на каждой отправке. Никогда не возвращается в браузер и не пишется в логи.';
comment on column public.salon_secrets.gupshup_source_number is
  'Номер салона в формате Gupshup: только цифры, с кодом страны, без +. Идёт полем source при отправке.';
comment on column public.salon_secrets.gupshup_webhook_token is
  'Наш секрет в пути вебхука /api/public/wagupshup/<token>. У Gupshup нет подписи X-Hub-Signature-256 — запрос шлёт он, а не Meta, — поэтому аутентификация держится на этом значении.';
comment on column public.salon_secrets.gupshup_enabled is
  'Выключатель этапа 1. Маршрут отказывает салону, пока это false, даже при заполненных реквизитах. Снятие галочки — самый быстрый откат, без деплоя.';

-- Одно имя приложения = один салон. Два салона с общим app_name означали бы, что события одного
-- уедут в переписку другого; отказать на записи дешевле, чем разбирать это потом по логам.
create unique index if not exists salon_secrets_gupshup_app_uidx
  on public.salon_secrets (gupshup_app_name)
  where gupshup_app_name is not null;

-- Токен вебхука — тоже ключ поиска салона, и он обязан быть уникальным по той же причине.
create unique index if not exists salon_secrets_gupshup_hook_uidx
  on public.salon_secrets (gupshup_webhook_token)
  where gupshup_webhook_token is not null;

-- ---------------------------------------------------------------------------
-- 2. Канал.
-- ---------------------------------------------------------------------------
-- Диалоги и сообщения общие для всех каналов — это решение принято ещё при Instagram и повторено
-- при Cloud API. Новый канал не заводит своих таблиц, он добавляет значение в дискриминатор.
alter table public.wa_conversations
  drop constraint if exists wa_conversations_channel_chk;
alter table public.wa_conversations
  add constraint wa_conversations_channel_chk
  check (channel in ('whatsapp', 'whatsapp_cloud', 'whatsapp_gupshup', 'instagram'));

comment on column public.wa_conversations.channel is
  'Транспорт, которым пришёл диалог: whatsapp (Green-API, удалён) | whatsapp_cloud (прямой Cloud API и мост Make) | whatsapp_gupshup (BSP Gupshup) | instagram.';

-- ---------------------------------------------------------------------------
-- 3. Второй идентификатор сообщения.
-- ---------------------------------------------------------------------------
-- У Gupshup их ДВА: свой gsId и метовский wamid. Причём одно и то же поле payload.id означает
-- разное в разных событиях — в enqueued/failed это gsId, а в sent/delivered/read это wamid.
-- Сложить оба в green_api_message_id значит получить ложный дедуп: событие о доставке затрёт
-- строку входящего сообщения с тем же значением.
--
-- Поэтому wamid остаётся в исторической колонке (её читает весь существующий код дедупликации),
-- а gsId получает свою.
alter table public.wa_messages
  add column if not exists provider            text,
  add column if not exists provider_message_id text;

comment on column public.wa_messages.provider_message_id is
  'Идентификатор сообщения В СИСТЕМЕ ПРОВАЙДЕРА, когда он не совпадает с метовским. Gupshup: gsId. Метовский wamid по-прежнему живёт в green_api_message_id — на нём держится дедупликация всех каналов.';

create unique index if not exists wa_messages_provider_id_uidx
  on public.wa_messages (salon_id, provider_message_id)
  where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Карантин событий.
-- ---------------------------------------------------------------------------
-- Требование этапа 1: неизвестные события безопасно сохранять и логировать. Плюс это единственный
-- способ ответить на вопрос «а Gupshup вообще к нам стучался?» — тот же вопрос, ради которого в
-- облачном пути живёт getWaCloudDiagnostics.
--
-- salon_id допускает NULL: событие от неопознанного приложения тоже надо сохранить, иначе разбор
-- «почему салон молчит» упирается в пустоту.
create table if not exists public.wa_webhook_events (
  id           uuid primary key default gen_random_uuid(),
  salon_id     uuid references public.salons(id) on delete cascade,
  provider     text not null,
  event_type   text,
  external_id  text,
  raw          jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  attempts     integer not null default 0,
  last_error   text
);

comment on table public.wa_webhook_events is
  'Сырые события вебхуков: неизвестные типы, неопознанные салоны и всё, что не удалось обработать. Хранится в обезличенном виде — токены и ключи вырезаются ДО записи (см. redactForStorage в wa-gupshup-events.server.ts).';
comment on column public.wa_webhook_events.raw is
  'Полезная нагрузка события БЕЗ секретов. Никогда не писать сюда заголовки запроса: там живёт apikey.';

create index if not exists wa_webhook_events_pending_idx
  on public.wa_webhook_events (received_at)
  where processed_at is null;

create index if not exists wa_webhook_events_salon_idx
  on public.wa_webhook_events (salon_id, received_at desc);

alter table public.wa_webhook_events enable row level security;
-- Ни SELECT, ни INSERT для authenticated: строки содержат переписку клиентов и пишутся только
-- сервисной ролью из маршрута вебхука. Политик нет намеренно — RLS без политик запрещает всё.
grant all on public.wa_webhook_events to service_role;

-- ---------------------------------------------------------------------------
-- ОТКАТ
-- ---------------------------------------------------------------------------
-- Быстрый (без деплоя, ~30 секунд), достаточный в 99% случаев:
--   update public.salon_secrets set gupshup_enabled = false where gupshup_enabled;
--
-- Полный откат схемы не требуется: все колонки необязательные, обе таблицы новые, существующий
-- код их не читает. Если он всё же понадобится:
--   drop table if exists public.wa_webhook_events;
--   drop index if exists public.wa_messages_provider_id_uidx;
--   alter table public.wa_messages drop column if exists provider_message_id, drop column if exists provider;
--   alter table public.wa_conversations drop constraint if exists wa_conversations_channel_chk;
--   alter table public.wa_conversations add constraint wa_conversations_channel_chk
--     check (channel in ('whatsapp', 'whatsapp_cloud', 'instagram'));
--   drop index if exists public.salon_secrets_gupshup_hook_uidx;
--   drop index if exists public.salon_secrets_gupshup_app_uidx;
--   alter table public.salon_secrets
--     drop column if exists gupshup_app_id, drop column if exists gupshup_app_name,
--     drop column if exists gupshup_api_key, drop column if exists gupshup_source_number,
--     drop column if exists gupshup_waba_id, drop column if exists gupshup_webhook_token,
--     drop column if exists gupshup_enabled, drop column if exists gupshup_connected_at,
--     drop column if exists gupshup_last_event_at, drop column if exists gupshup_last_error,
--     drop column if exists gupshup_last_error_at;
-- ВНИМАНИЕ: снос колонки channel-константы возможен только когда ни один диалог не имеет
-- channel = 'whatsapp_gupshup', иначе CHECK не встанет.
