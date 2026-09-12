-- Каналы связи как отдельная сущность: Бизнес → Точки → Каналы.
--
-- ═══ ЧТО НЕ ТАК СЕЙЧАС ════════════════════════════════════════════════════
--
-- Реквизиты канала лежат в salon_secrets — а это ОДНА строка на салон. Значит по одному
-- WhatsApp и одному Instagram на весь бизнес, жёстко. Сеть из трёх точек, где у каждой свой
-- номер, в такую схему не помещается вообще: второй номер некуда записать.
--
-- Это не «неудобно», это потолок. Сеть — самый платёжеспособный клиент Qabyl, и продать ей
-- сегодня нечего.
--
-- ═══ КАК ПРАВИЛЬНО ════════════════════════════════════════════════════════
--
--   salons (бизнес)
--     └── branches (точки)
--     └── salon_channels (каналы)   ← новая таблица
--
-- У канала есть ОБЛАСТЬ ДЕЙСТВИЯ:
--   scope='salon'  — общий для всей сети, branch_id IS NULL. Ассистент спрашивает клиента,
--                    в какую точку он хочет, как и раньше.
--   scope='branch' — принадлежит одной точке. Ассистент не спрашивает ничего: услуги, мастера,
--                    свободное время и запись берутся только из этой точки.
--
-- Смешанная схема получается сама собой: точка A со своим WhatsApp и своим Instagram, точка B
-- со своими, точка C на общем номере сети и со своим Instagram — это просто разные строки.
--
-- ═══ КЛЮЧ МАРШРУТИЗАЦИИ ═══════════════════════════════════════════════════
--
-- external_id — то, чем канал представляется во входящем вебхуке: phone_number_id у WhatsApp
-- Cloud API, instagram_user_id у Instagram. Именно по нему приходящее сообщение находит и салон,
-- и точку. Он уникален в пределах вида канала на всю платформу: один и тот же номер не может
-- принадлежать двум салонам, и попытка подключить чужой номер упрётся в ограничение базы, а не
-- в тихую путаницу переписок между салонами.
--
-- ═══ ПОЧЕМУ ЭТО БЕЗОПАСНО ПРЯМО СЕЙЧАС ════════════════════════════════════
--
-- На момент миграции подключённых каналов нет НИ ОДНОГО: ни WhatsApp, ни Instagram ни у одного
-- из трёх салонов (проверено запросом к salon_secrets). Переносить нечего, ломать нечего.
-- Перенос всё равно написан — на случай, если канал подключат между написанием и применением.
--
-- Код продолжает читать salon_secrets и ничего не замечает: таблица только появляется. Переключение
-- маршрутизации — отдельный шаг, и делать его вместе с созданием таблицы значит смешать
-- «добавили» и «изменили» в одной миграции, которую потом нельзя откатить по частям.

create table if not exists public.salon_channels (
  id            uuid primary key default gen_random_uuid(),
  salon_id      uuid not null references public.salons(id) on delete cascade,

  kind          text not null check (kind in ('whatsapp', 'instagram')),

  -- Область действия. Инвариант держит база, а не код: 'salon' обязан быть без точки,
  -- 'branch' — обязательно с точкой. Строки «филиальный канал без филиала» не существует.
  scope         text not null default 'salon' check (scope in ('salon', 'branch')),
  branch_id     uuid references public.branches(id) on delete cascade,
  constraint salon_channels_scope_branch check (
    (scope = 'salon'  and branch_id is null) or
    (scope = 'branch' and branch_id is not null)
  ),

  -- Чем канал представляется во входящем вебхуке.
  external_id   text,

  -- Реквизиты канала. jsonb, а не колонки: у WhatsApp и Instagram наборы разные и меняются с
  -- каждой версией их API, а заводить по колонке на каждое поле — это миграция на каждый чих.
  credentials   jsonb not null default '{}'::jsonb,

  -- Отвечает ли здесь ассистент. Пер-канальный аналог salons.whatsapp_ai_enabled: у сети
  -- бывает нужно включить ИИ на одной точке и оставить живого администратора на другой.
  ai_enabled    boolean not null default true,
  is_active     boolean not null default true,

  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.salon_channels is
  'Каналы связи бизнеса. scope=salon — общий на сеть, scope=branch — закреплён за точкой. Маршрутизация входящих идёт по (kind, external_id).';

-- Один и тот же номер/аккаунт не может обслуживать два салона: иначе переписки разных бизнесов
-- смешаются в одну, и понять это можно будет только по жалобе клиента.
create unique index if not exists salon_channels_external_uniq
  on public.salon_channels (kind, external_id)
  where external_id is not null;

create index if not exists salon_channels_salon_idx on public.salon_channels (salon_id, kind);
create index if not exists salon_channels_branch_idx on public.salon_channels (branch_id)
  where branch_id is not null;

-- ── Перенос того, что уже подключено ────────────────────────────────────────
-- scope='salon': существующие салоны одноточечные, и их единственный канал обслуживает весь
-- бизнес. Это ровно сегодняшнее поведение, записанное в новых терминах.

insert into public.salon_channels (salon_id, kind, scope, external_id, credentials, display_name)
select s.salon_id,
       'whatsapp',
       'salon',
       s.whatsapp_cloud_phone_number_id,
       jsonb_strip_nulls(jsonb_build_object(
         'phone_number_id', s.whatsapp_cloud_phone_number_id,
         'waba_id',         s.whatsapp_cloud_waba_id,
         'token',           s.whatsapp_cloud_token,
         'app_secret',      s.whatsapp_cloud_app_secret
       )),
       'WhatsApp'
  from public.salon_secrets s
 where s.whatsapp_cloud_phone_number_id is not null
   and not exists (
     select 1 from public.salon_channels c
      where c.salon_id = s.salon_id and c.kind = 'whatsapp'
   );

insert into public.salon_channels (salon_id, kind, scope, external_id, credentials, display_name)
select s.salon_id,
       'instagram',
       'salon',
       s.instagram_user_id,
       jsonb_strip_nulls(jsonb_build_object(
         'instagram_user_id', s.instagram_user_id,
         'token',             s.instagram_token,
         'app_secret',        s.instagram_app_secret,
         'verify_token',      s.instagram_verify_token
       )),
       'Instagram'
  from public.salon_secrets s
 where s.instagram_user_id is not null
   and not exists (
     select 1 from public.salon_channels c
      where c.salon_id = s.salon_id and c.kind = 'instagram'
   );

-- ── Доступ ──────────────────────────────────────────────────────────────────
-- Реквизиты канала — это токены. Их не должен читать никто из браузера: ни владелец, ни
-- администратор. Поэтому RLS включён, а политик на чтение нет вообще: таблица доступна только
-- service-role, то есть серверным функциям, которые сами решают, что показать на экране
-- (подключён / не подключён), а что не показывать никогда.

alter table public.salon_channels enable row level security;

-- ── Маршрутизация ───────────────────────────────────────────────────────────
--
-- Одна функция, которая отвечает на единственный вопрос входящего вебхука: «чьё это сообщение и
-- в какую точку писать». Живёт в базе, а не в коде, потому что спрашивают её оба вебхука и
-- сверх того аналитика; две реализации одного вопроса рано или поздно начнут отвечать по-разному.

create or replace function public.resolve_channel(_kind text, _external_id text)
returns table (channel_id uuid, salon_id uuid, branch_id uuid, ai_enabled boolean)
language sql
stable security definer
set search_path to 'public'
as $$
  select c.id, c.salon_id, c.branch_id, c.ai_enabled
    from public.salon_channels c
   where c.kind = _kind
     and c.external_id = _external_id
     and c.is_active
   limit 1;
$$;

revoke all on function public.resolve_channel(text, text) from public, anon, authenticated;
