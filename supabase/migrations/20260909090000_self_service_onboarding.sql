-- Self-service онбординг: владелец салона заводит себя сам, а подключение WhatsApp перестаёт быть
-- набором полей и становится состоянием, за которым можно следить.
--
-- ЧТО ЗДЕСЬ ЕСТЬ
--   1. create_salon_for_owner  — единственный способ для НЕ-super_admin завести салон.
--   2. Уникальность номера и WABA на уровне БД, а не только в коде.
--   3. Состояние подключения WhatsApp: здоровье токена, качество номера, статус шаблонов.
--   4. wa_onboarding_events — журнал шагов подключения.
--
-- ЧТО ЭТА МИГРАЦИЯ НЕ МЕНЯЕТ. Ни один существующий салон не меняет поведения: все новые колонки
-- необязательные, все новые политики только ДОБАВЛЯЮТ права там, где раньше их не было ни у кого,
-- кроме super_admin. Существующие политики не трогаются.
--
-- ОТКАТ — в конце файла.

-- ---------------------------------------------------------------------------
-- 1. Кто владелец салона
-- ---------------------------------------------------------------------------
-- Право доступа по-прежнему даёт user_roles — эта колонка не участвует в RLS и нужна для другого:
-- ответить на вопрос «кто завёл этот салон» через полгода, когда прав у салона будет пятеро.
alter table public.salons
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

comment on column public.salons.owner_user_id is
  'Аккаунт, который завёл салон через self-service. Справочная колонка: доступ определяется user_roles, не ею.';

create index if not exists salons_owner_user_id_idx on public.salons (owner_user_id);

-- wa_provider пережил свой смысл: Green-API удалён из кода (28.08.2026), а все семь салонов в
-- проде стоят в 'green_api' — значении транспорта, которого больше нет. Колонку оставляем (её
-- читают четыре маршрута в select-списке), но помечаем, чтобы следующий читатель не принял её за
-- рабочий переключатель.
comment on column public.salons.wa_provider is
  'УСТАРЕЛО. Осталось от эпохи Green-API. Транспорт выбирается по заполненным реквизитам в salon_secrets, а не этой колонкой. Не читать в новом коде.';

-- ---------------------------------------------------------------------------
-- 2. Заведение салона владельцем
-- ---------------------------------------------------------------------------
-- Почему RPC, а не INSERT-политика на salons. Салон в одиночку бесполезен: без филиала не работает
-- расписание, без роли владелец не увидит собственную запись в базе, без строки salon_secrets
-- первый же экран настроек упадёт. Всё это должно появиться разом или не появиться вовсе —
-- значит, одна транзакция, а не четыре запроса из браузера, из которых второй может не долететь.
--
-- SECURITY DEFINER здесь — не дыра, а единственный способ: функция ПИШЕТ в user_roles, куда
-- политика пускает только super_admin. Все проверки сделаны внутри и перечислены по порядку.
create or replace function public.create_salon_for_owner(
  _name text,
  _timezone text default 'Asia/Bishkek',
  _phone text default null,
  _address text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  _uid uuid := auth.uid();
  _salon_id uuid;
  _base_slug text;
  _slug text;
  _n int := 0;
begin
  if _uid is null then
    raise exception 'Не авторизован' using errcode = '42501';
  end if;

  if coalesce(btrim(_name), '') = '' then
    raise exception 'Название салона не может быть пустым' using errcode = '22023';
  end if;

  -- Один аккаунт — один салон. Не про экономию, а про то, что второй салон почти всегда означает
  -- второй ФИЛИАЛ, а филиалы у нас уже есть и умеют своё расписание. Ограничение заодно закрывает
  -- самый дешёвый способ засорить базу: цикл по кнопке «создать салон».
  -- super_admin сюда не попадает — у него свой путь через /admin/salons.
  if exists (
    select 1 from public.user_roles
     where user_id = _uid and role::text in ('salon_admin', 'super_admin')
  ) then
    raise exception 'У этого аккаунта уже есть салон' using errcode = '23505';
  end if;

  -- Slug виден клиенту в адресе страницы записи, поэтому он должен быть читаемым, а не uuid.
  -- Транслитерацию делает клиент (там же, где показывает результат владельцу); сюда приходит уже
  -- латиница, и наша задача — только развести совпадения.
  _base_slug := nullif(regexp_replace(lower(btrim(_name)), '[^a-z0-9]+', '-', 'g'), '');
  _base_slug := btrim(coalesce(_base_slug, 'salon'), '-');
  if _base_slug = '' then _base_slug := 'salon'; end if;
  _base_slug := left(_base_slug, 40);

  _slug := _base_slug;
  while exists (select 1 from public.salons where slug = _slug) loop
    _n := _n + 1;
    if _n > 50 then
      -- Пятьдесят «my-salon-N» подряд означают не совпадение, а что-то другое. Уходим в заведомо
      -- свободное имя, а не крутим цикл дальше.
      _slug := _base_slug || '-' || replace(gen_random_uuid()::text, '-', '');
      exit;
    end if;
    _slug := _base_slug || '-' || _n::text;
  end loop;

  insert into public.salons (name, slug, timezone, phone, address, owner_user_id, is_active)
  values (btrim(_name), _slug, coalesce(nullif(btrim(_timezone), ''), 'Asia/Bishkek'),
          nullif(btrim(_phone), ''), nullif(btrim(_address), ''), _uid, true)
  returning id into _salon_id;

  -- Роль до филиала: если следующая вставка упадёт, транзакция откатится целиком, но порядок
  -- всё равно держим осмысленным — сначала право, потом объекты.
  insert into public.user_roles (user_id, role, salon_id)
  values (_uid, 'salon_admin', _salon_id);

  -- Главный филиал. Салон без филиала не отдаёт ни одного слота: get_available_slots ходит по
  -- master_schedules, а те привязаны к филиалу. Заводить его руками — шаг, который владелец не
  -- понимает и потому пропускает.
  insert into public.branches (salon_id, name, address, phone, sort_order, is_active)
  values (_salon_id, 'Главный филиал', nullif(btrim(_address), ''), nullif(btrim(_phone), ''), 0, true);

  -- Пустая строка секретов: половина экранов настроек делает upsert по salon_id, и её отсутствие
  -- превращается в гонку на первом же открытии вкладки.
  insert into public.salon_secrets (salon_id) values (_salon_id)
  on conflict (salon_id) do nothing;

  return _salon_id;
end;
$$;

revoke all on function public.create_salon_for_owner(text, text, text, text) from public;
grant execute on function public.create_salon_for_owner(text, text, text, text) to authenticated;

comment on function public.create_salon_for_owner(text, text, text, text) is
  'Self-service: заводит салон, главный филиал, роль salon_admin и строку секретов одной транзакцией. Единственный путь создать салон для того, кто не super_admin.';

-- ---------------------------------------------------------------------------
-- 3. Один номер WhatsApp — один салон, на уровне БД
-- ---------------------------------------------------------------------------
-- До сих пор это проверялось только в finishWaOnboarding, то есть на одном из трёх путей записи и
-- без защиты от гонки: две вкладки проходят проверку обе. Цена ошибки — общий вебхук перестаёт
-- понимать, кому адресовано сообщение, и салон молча немеет (см. wacloud.ts, ветка rows.length>1).
--
-- Индексы частичные: NULL здесь норма — большинство салонов WhatsApp ещё не подключали.
create unique index if not exists salon_secrets_wa_phone_number_uidx
  on public.salon_secrets (whatsapp_cloud_phone_number_id)
  where whatsapp_cloud_phone_number_id is not null;

-- WABA намеренно НЕ уникальна: у одного бизнес-аккаунта может быть несколько номеров, и сеть
-- салонов с общим WABA — законный сценарий. Индекс обычный, для поиска по вебхуку account_update.
create index if not exists salon_secrets_wa_waba_idx
  on public.salon_secrets (whatsapp_cloud_waba_id)
  where whatsapp_cloud_waba_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Состояние подключения WhatsApp
-- ---------------------------------------------------------------------------
-- Раньше «подключён» выводилось из наличия двух непустых полей. Этого мало: заполненные поля с
-- отозванным токеном выглядят точно так же, как рабочее подключение, и разница обнаруживается
-- только тем, что ассистент молчит. Здесь появляется то, что можно ПОКАЗАТЬ владельцу и по чему
-- можно бить тревогу заранее.
alter table public.salon_secrets
  -- Как подключён салон. 'platform' — через приложение Qabyl (Embedded Signup), вебхук общий,
  -- подпись проверяется секретом платформы. 'own_app' — у салона своё приложение Meta, вебхук
  -- пер-салонный, подпись его собственным секретом.
  add column if not exists wa_connection_kind text,
  add column if not exists wa_connected_at timestamptz,
  -- Что ответила Meta на последнюю проверку. 'valid' | 'invalid' | 'unknown'.
  add column if not exists wa_token_status text,
  add column if not exists wa_last_health_check_at timestamptz,
  -- Последняя причина, по которой канал не работает. Формулировка бизнесовая: она идёт владельцу
  -- на экран как есть, без кодов Graph API.
  add column if not exists wa_last_error text,
  add column if not exists wa_last_error_at timestamptz,
  -- Снимок с Meta: то, что владелец узнаёт о СВОЁМ номере, не заходя в кабинет Meta.
  add column if not exists wa_display_phone_number text,
  add column if not exists wa_verified_name text,
  add column if not exists wa_quality_rating text,
  add column if not exists wa_messaging_limit text,
  -- platform_type у номера: 'CLOUD_API' | 'ON_BIZ_APP' (coexistence) | 'NOT_APPLICABLE'.
  -- Отличать важно: у coexistence-номера свои ограничения (20 сообщений/сек, нет групп и звонков),
  -- и владельцу надо говорить разное.
  add column if not exists wa_platform_type text,
  -- Статус самой WABA: 'APPROVED' | 'PENDING' | 'REJECTED' | 'DISABLED' и т. п.
  add column if not exists wa_account_review_status text,
  add column if not exists wa_business_id text,
  -- Привязан ли к WABA способ оплаты. Мы — Tech Provider, а не Solution Partner: своей кредитной
  -- линией салон не покрываем, и без платёжки Meta не выпустит НИ ОДНОГО сообщения. Это шаг
  -- онбординга, а не сноска, поэтому у него своя колонка.
  add column if not exists wa_payment_ready boolean,
  add column if not exists wa_templates_synced_at timestamptz;

comment on column public.salon_secrets.wa_connection_kind is
  'platform — подключён через приложение Qabyl (общий вебхук, общий app secret). own_app — своё приложение Meta (пер-салонный вебхук, свой секрет). NULL — не подключён либо подключён до появления этой колонки.';
comment on column public.salon_secrets.wa_token_status is
  'Результат последней проверки токена в Graph API: valid | invalid | unknown. Отозванный токен — самая частая причина внезапной тишины, и узнавать о нём по молчанию ассистента нельзя.';
comment on column public.salon_secrets.wa_payment_ready is
  'Привязан ли к WABA салона способ оплаты. NULL — не проверяли. FALSE — Meta не выпустит ни одного сообщения, и это надо показать владельцу до того, как он напишет клиенту.';
comment on column public.salon_secrets.wa_platform_type is
  'CLOUD_API — номер целиком уехал в API. ON_BIZ_APP — coexistence: приложение на телефоне продолжает работать, но потолок 20 сообщений/сек и часть функций приложения отключена.';

-- Статус шаблона теперь живёт рядом с его именем: whatsapp_cloud_templates становится
-- {kind: {name, lang, status, status_at, reason}}. Старые читатели берут только name и lang и
-- ничего не замечают — поэтому колонка не меняется, меняется только то, что мы в неё кладём.
comment on column public.salon_secrets.whatsapp_cloud_templates is
  'Шаблоны по видам сообщений: {"reminder": {"name":"visit_reminder","lang":"ru","status":"APPROVED","status_at":"...","reason":null}, ...}. status — то, что ответила Meta: APPROVED | PENDING | REJECTED | PAUSED | DISABLED. Созданный шаблон приходит PENDING, и до APPROVED отправлять по нему нельзя.';

-- salons.wa_cloud_templates_ready остаётся, но его смысл уточняется: он поднимается только когда
-- Meta ОДОБРИЛА весь комплект, а не когда мы его создали. Разница — рабочие напоминания против
-- отказа 132000 на каждом.
comment on column public.salons.wa_cloud_templates_ready is
  'TRUE только когда ВСЕ шаблоны уведомлений имеют статус APPROVED у Meta. Создание шаблона даёт PENDING, а не APPROVED — поднимать флаг по факту создания значит отправлять по неодобренному шаблону и получать 132000.';

-- ---------------------------------------------------------------------------
-- 5. Журнал подключения
-- ---------------------------------------------------------------------------
-- Подключение — это девять последовательных вызовов Graph API. Когда оно ломается на шестом,
-- владелец видит одну строку в тосте, а мы через неделю — ничего. Журнал существует ровно для
-- того, чтобы на вопрос «почему у меня не подключилось во вторник» был ответ.
create table if not exists public.wa_onboarding_events (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  -- Одна попытка подключения = один attempt_id на все её шаги. Без него события двух попыток
  -- подряд склеиваются в кашу, а именно две попытки подряд и бывают, когда что-то не работает.
  attempt_id uuid not null,
  step text not null,
  ok boolean not null,
  -- Формулировка для владельца. Технические подробности — в details.
  detail text,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists wa_onboarding_events_salon_idx
  on public.wa_onboarding_events (salon_id, created_at desc);
create index if not exists wa_onboarding_events_attempt_idx
  on public.wa_onboarding_events (attempt_id);

alter table public.wa_onboarding_events enable row level security;

-- Читает владелец салона — это его собственная история подключения, и она нужна ему в поддержке.
-- Пишет только service_role: события кладёт сервер, браузеру там делать нечего.
drop policy if exists "Salon reads own onboarding events" on public.wa_onboarding_events;
create policy "Salon reads own onboarding events" on public.wa_onboarding_events
  for select to authenticated
  using (public.has_salon_access(auth.uid(), salon_id));

grant select on public.wa_onboarding_events to authenticated;

-- ---------------------------------------------------------------------------
-- ОТКАТ
-- ---------------------------------------------------------------------------
--   drop table if exists public.wa_onboarding_events;
--   drop function if exists public.create_salon_for_owner(text, text, text, text);
--   drop index if exists public.salon_secrets_wa_phone_number_uidx;
--   drop index if exists public.salon_secrets_wa_waba_idx;
--   alter table public.salon_secrets drop column if exists wa_connection_kind, ... (остальные из п.4);
--   alter table public.salons drop column if exists owner_user_id;
-- Колонки безопасно оставить: код, который их не знает, работает как раньше.
