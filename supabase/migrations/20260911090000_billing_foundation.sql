-- Биллинг Qabyl: тарифы, подписки, учёт расхода, счета.
--
-- ЗАЧЕМ. С единой кредитной линией за сообщения WhatsApp всех салонов платит Qabyl, а не салон.
-- Значит, Qabyl обязан брать деньги с салонов и не давать одному салону съесть маржу всех
-- остальных. До этой миграции в базе не было ни тарифа, ни учёта расхода — ассистент отвечал
-- без ограничений любому салону, и счёт Meta рос вслепую.
--
-- ГЛАВНЫЙ ПРИНЦИП: бизнес-логика — это данные, а не код. Цены, лимиты, пробные периоды,
-- себестоимость сообщения, длина отсрочки — всё лежит в таблицах billing_plans и
-- billing_settings. Поменять цену, лимит или курс доллара — это UPDATE, а не выкладка.
--
-- ЧТО ЗДЕСЬ:
--   1. billing_settings        — себестоимость и политика (курс, цена сообщения Meta, отсрочка)
--   2. billing_plans           — START / BUSINESS / PRO: цена, пробный период, лимиты, функции
--   3. salon_subscriptions     — тариф и статус оплаты каждого салона
--   4. billing_payment_methods — токен карты. Только service-role: браузер его не видит никогда
--   5. billing_usage           — счётчики расхода за период
--   6. billing_credits         — докупленные пакеты сообщений
--   7. billing_invoices        — счета и попытки списания
--   8. billing_events          — журнал всего, что происходило с оплатой
--   9. функции: учёт расхода, состояние салона, блокировка
--  10. триггеры: пробный период новому салону, запрет записи при блокировке, лимит филиалов
--
-- ДВА ВЫКЛЮЧАТЕЛЯ. billing_settings.config.enforcement_enabled = false выключает ограничения для всех
-- салонов разом (расход продолжает считаться). salon_subscriptions.billing_exempt — для одного салона.
-- Оба переключаются в админке: /admin/billing у владельца платформы.
--
-- СУЩЕСТВУЮЩИЕ САЛОНЫ получают billing_exempt = true: пилотные салоны не должны потерять запись
-- из-за того, что у них нет карты в системе, которой вчера не существовало. Снять освобождение —
-- это UPDATE по одному салону.
--
-- ОТКАТ — в конце файла.

-- ---------------------------------------------------------------------------
-- 1. Себестоимость и политика
-- ---------------------------------------------------------------------------
create table if not exists public.billing_settings (
  id boolean primary key default true check (id),
  config jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.billing_settings is
  'Одна строка. Себестоимость (курс, цена сообщения Meta, AI) и политика оплаты (отсрочка, повторы списания, пороги). Меняется UPDATE, без выкладки кода.';

insert into public.billing_settings (id, config) values (true, '{
  "usd_kgs": 87.45,
  "wa_message_usd": 0.0077,
  "ai_reply_kgs": 0.25,
  "infra_per_salon_kgs": 250,
  "gateway_fee_pct": 3,
  "grace_days": 3,
  "dunning_retry_days": [1, 2],
  "usage_warn_pct": 80,
  "notifications_ceiling_pct": 110,
  "trial_warn_days": 3,
  "enforcement_enabled": true,
  "manual_payment_instructions": null,
  "support_contact": "support@qabyl.com"
}'::jsonb)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Тарифы
-- ---------------------------------------------------------------------------
-- limits — числа, которые ограничивают расход и масштаб:
--   messages_month        сообщений, которые Qabyl отправляет от имени салона за оплаченный месяц
--                         (ответы ассистента + автоматические уведомления, все каналы)
--   trial_messages        то же на весь пробный период — защита от расхода на неоплативших
--   branches              филиалов
--   channels              каналов связи с клиентами (WhatsApp, Instagram)
--   overage_pack_messages размер докупаемого пакета
--   overage_pack_price_kgs его цена
-- features — что включено (true/false или уровень поддержки).
create table if not exists public.billing_plans (
  code text primary key,
  name text not null,
  tagline text,
  price_kgs integer not null check (price_kgs >= 0),
  currency text not null default 'KGS',
  trial_days integer not null default 14 check (trial_days between 0 and 90),
  sort_order integer not null default 0,
  is_featured boolean not null default false,
  is_public boolean not null default true,
  is_active boolean not null default true,
  limits jsonb not null default '{}'::jsonb,
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.billing_plans
  (code, name, tagline, price_kgs, trial_days, sort_order, is_featured, limits, features)
values
  ('start', 'Start', 'Для мастера или небольшого салона', 4499, 30, 1, false,
   '{"messages_month": 1500, "trial_messages": 500, "branches": 1, "channels": 1,
     "overage_pack_messages": 500, "overage_pack_price_kgs": 1490}'::jsonb,
   '{"booking_page": true, "reminders": true, "basic_stats": true,
     "analytics_advanced": false, "reactivation": false, "sales_mode": false,
     "prepayment": false, "export": false, "support": "standard"}'::jsonb),
  ('business', 'Business', 'Для салона, который растёт', 6499, 14, 2, true,
   '{"messages_month": 3000, "trial_messages": 700, "branches": 3, "channels": 2,
     "overage_pack_messages": 500, "overage_pack_price_kgs": 1190}'::jsonb,
   '{"booking_page": true, "reminders": true, "basic_stats": true,
     "analytics_advanced": true, "reactivation": true, "sales_mode": true,
     "prepayment": true, "export": false, "support": "priority"}'::jsonb),
  ('pro', 'Pro', 'Для сети и больших потоков', 10499, 14, 3, false,
   '{"messages_month": 6000, "trial_messages": 700, "branches": 10, "channels": 3,
     "overage_pack_messages": 500, "overage_pack_price_kgs": 990}'::jsonb,
   '{"booking_page": true, "reminders": true, "basic_stats": true,
     "analytics_advanced": true, "reactivation": true, "sales_mode": true,
     "prepayment": true, "export": true, "support": "dedicated"}'::jsonb)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Подписки
-- ---------------------------------------------------------------------------
-- Жизненный цикл: trialing → active ↔ past_due → suspended → (оплата) → active
--   past_due  — списание не прошло, идёт отсрочка до grace_until, всё работает, висит баннер;
--   suspended — отсрочка кончилась: кабинет закрыт экраном оплаты, запись и ассистент стоят;
--   canceled  — салон отказался, доступ до конца оплаченного периода, дальше как suspended.
create table if not exists public.salon_subscriptions (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  plan_code text not null references public.billing_plans(code),
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'suspended', 'canceled')),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  -- Понижение тарифа вступает в силу со следующего периода: уже оплаченное не отнимаем.
  pending_plan_code text references public.billing_plans(code),
  cancel_at_period_end boolean not null default false,
  -- Докупать пакет автоматически, когда сообщения кончились. Без этого ассистент замолкает.
  auto_topup boolean not null default true,
  -- Пилотные и служебные салоны: не блокируются и не списываются.
  billing_exempt boolean not null default false,
  card_mask text,
  card_brand text,
  last_payment_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists salon_subscriptions_status_idx
  on public.salon_subscriptions (status, current_period_end);

-- ---------------------------------------------------------------------------
-- 4. Способ оплаты — секрет
-- ---------------------------------------------------------------------------
-- Отдельной таблицей, а не колонкой в подписках: подписку салон читает из браузера, а токен
-- карты не должен покидать сервер. Колонку от SELECT не спрячешь политикой, таблицу — можно.
create table if not exists public.billing_payment_methods (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  provider text not null default 'freedompay',
  card_token text,
  recurring_profile_id text,
  card_mask text,
  card_brand text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. Расход
-- ---------------------------------------------------------------------------
-- metric: wa_out (сообщение WhatsApp — за него платит Meta), ig_out (Instagram — только AI),
-- ai_reply (ход ассистента). Лимит тарифа считается по wa_out + ig_out; ai_reply нужен для
-- себестоимости.
create table if not exists public.billing_usage (
  salon_id uuid not null references public.salons(id) on delete cascade,
  period_start timestamptz not null,
  metric text not null,
  quantity integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (salon_id, period_start, metric)
);

-- ---------------------------------------------------------------------------
-- 6. Докупленные пакеты
-- ---------------------------------------------------------------------------
create table if not exists public.billing_credits (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  period_start timestamptz not null,
  messages integer not null check (messages > 0),
  source text not null check (source in ('pack', 'grant')),
  invoice_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists billing_credits_salon_period_idx
  on public.billing_credits (salon_id, period_start);

-- ---------------------------------------------------------------------------
-- 7. Счета
-- ---------------------------------------------------------------------------
create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  kind text not null check (kind in ('subscription', 'overage_pack', 'proration', 'card_check')),
  plan_code text,
  amount_kgs integer not null check (amount_kgs >= 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'canceled')),
  period_start timestamptz,
  period_end timestamptz,
  provider text not null default 'freedompay',
  provider_payment_id text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_invoices_salon_idx
  on public.billing_invoices (salon_id, created_at desc);
create index if not exists billing_invoices_retry_idx
  on public.billing_invoices (status, next_attempt_at) where status = 'pending';
-- Один платёж шлюза — один счёт. Повторное уведомление Freedom Pay не должно дважды продлевать.
create unique index if not exists billing_invoices_provider_payment_uidx
  on public.billing_invoices (provider, provider_payment_id) where provider_payment_id is not null;

-- ---------------------------------------------------------------------------
-- 8. Журнал
-- ---------------------------------------------------------------------------
create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid references public.salons(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists billing_events_salon_idx
  on public.billing_events (salon_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 9. Функции
-- ---------------------------------------------------------------------------

-- Начало периода, по которому считается расход. У пробного — старт пробного, у оплаченного —
-- начало текущего оплаченного месяца. Период привязан к дате оплаты салона, а не к календарю:
-- иначе салон, оплативший 28-го, получил бы трёхдневный первый месяц.
create or replace function public.billing_current_period_start(_salon_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select case
           when s.status = 'trialing' then coalesce(s.trial_started_at, s.created_at)
           else coalesce(s.current_period_start, s.created_at)
         end
    from public.salon_subscriptions s
   where s.salon_id = _salon_id
$$;

-- Учёт расхода. Атомарный upsert: два вебхука в одну миллисекунду не теряют сообщение.
create or replace function public.billing_record_usage(
  _salon_id uuid,
  _metric text,
  _qty integer default 1
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _p timestamptz;
  _q integer;
begin
  if _salon_id is null or _qty is null or _qty <= 0 then
    return 0;
  end if;
  _p := public.billing_current_period_start(_salon_id);
  if _p is null then
    return 0;
  end if;
  insert into public.billing_usage (salon_id, period_start, metric, quantity)
  values (_salon_id, _p, _metric, _qty)
  on conflict (salon_id, period_start, metric)
  do update set quantity = public.billing_usage.quantity + excluded.quantity, updated_at = now()
  returning quantity into _q;
  return _q;
end;
$$;

-- Учёт по номеру WhatsApp — там, где отправка знает номер, но не салон.
create or replace function public.billing_record_wa_usage(
  _phone_number_id text,
  _qty integer default 1
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _salon uuid;
begin
  select salon_id into _salon
    from public.salon_secrets
   where whatsapp_cloud_phone_number_id = _phone_number_id
   limit 1;
  if _salon is null then
    return 0;
  end if;
  return public.billing_record_usage(_salon, 'wa_out', _qty);
end;
$$;

-- Учёт по аккаунту Instagram.
create or replace function public.billing_record_ig_usage(
  _instagram_user_id text,
  _qty integer default 1
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _salon uuid;
begin
  select salon_id into _salon
    from public.salon_secrets
   where instagram_user_id = _instagram_user_id
   limit 1;
  if _salon is null then
    return 0;
  end if;
  return public.billing_record_usage(_salon, 'ig_out', _qty);
end;
$$;

-- Заблокирован ли салон. Только да/нет — открыта всем, её спрашивает публичная страница записи.
create or replace function public.billing_salon_is_blocked(_salon_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select not s.billing_exempt
           and coalesce((select (b.config->>'enforcement_enabled')::boolean
                           from public.billing_settings b where b.id), true)
           and (
             s.status = 'suspended'
             or (s.status = 'canceled' and coalesce(s.current_period_end, now()) <= now())
           )
      from public.salon_subscriptions s
     where s.salon_id = _salon_id
  ), false)
$$;

-- Полное состояние салона: тариф, расход, лимит, что включено. Только для самого салона и
-- сервера — план и расход чужого салона посторонним не показываем.
create or replace function public.billing_salon_state(_salon_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _s public.salon_subscriptions;
  _p public.billing_plans;
  _cfg jsonb;
  _period timestamptz;
  _used integer;
  _credits integer;
  _allowance integer;
  _ceiling_pct integer;
  _enforced boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_salon_access(auth.uid(), _salon_id) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  select * into _s from public.salon_subscriptions where salon_id = _salon_id;
  if not found then
    return jsonb_build_object('has_subscription', false, 'blocked', false);
  end if;
  select * into _p from public.billing_plans where code = _s.plan_code;
  select config into _cfg from public.billing_settings where id = true;

  _period := public.billing_current_period_start(_salon_id);
  select coalesce(sum(quantity), 0) into _used
    from public.billing_usage
   where salon_id = _salon_id and period_start = _period and metric in ('wa_out', 'ig_out');
  select coalesce(sum(messages), 0) into _credits
    from public.billing_credits
   where salon_id = _salon_id and period_start = _period;

  _allowance := coalesce(
    case when _s.status = 'trialing'
         then (_p.limits->>'trial_messages')::int
         else (_p.limits->>'messages_month')::int end, 0) + _credits;
  _ceiling_pct := coalesce((_cfg->>'notifications_ceiling_pct')::int, 110);
  _enforced := coalesce((_cfg->>'enforcement_enabled')::boolean, true);

  return jsonb_build_object(
    'has_subscription', true,
    'plan_code', _s.plan_code,
    'plan_name', _p.name,
    'price_kgs', _p.price_kgs,
    'status', _s.status,
    -- exempt = «ограничения к салону не применяются»: освобождён сам или биллинг выключен для всех.
    'exempt', _s.billing_exempt or not _enforced,
    'salon_exempt', _s.billing_exempt,
    'enforced', _enforced,
    'blocked', public.billing_salon_is_blocked(_salon_id),
    'trial_ends_at', _s.trial_ends_at,
    'current_period_start', _s.current_period_start,
    'current_period_end', _s.current_period_end,
    'grace_until', _s.grace_until,
    'pending_plan_code', _s.pending_plan_code,
    'cancel_at_period_end', _s.cancel_at_period_end,
    'auto_topup', _s.auto_topup,
    'card_mask', _s.card_mask,
    'period_start', _period,
    'messages_used', _used,
    'messages_allowance', _allowance,
    'messages_credits', _credits,
    'usage_pct', case when _allowance > 0 then round(_used * 100.0 / _allowance) else 0 end,
    'usage_warn_pct', coalesce((_cfg->>'usage_warn_pct')::int, 80),
    'trial_warn_days', coalesce((_cfg->>'trial_warn_days')::int, 3),
    -- Ассистент замолкает на 100%, если нет автодокупки. Подтверждения и напоминания клиентам
    -- идут до потолка (по умолчанию 110%): записанный клиент не должен остаться без напоминания
    -- из-за того, что ассистент чуть переговорил.
    'assistant_paused', _enforced and not _s.billing_exempt and _used >= _allowance,
    'notifications_paused', _enforced and not _s.billing_exempt and _used >= _allowance * _ceiling_pct / 100,
    'limits', _p.limits,
    'features', _p.features
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Триггеры
-- ---------------------------------------------------------------------------

-- Новый салон сразу получает пробный период на Start. Триггер, а не код в RPC: салон создают и
-- create_salon_for_owner, и super_admin руками, и пробный период должен появиться в обоих случаях.
create or replace function public.billing_on_salon_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.salon_subscriptions (salon_id, plan_code, status, trial_started_at, trial_ends_at)
  select new.id, p.code, 'trialing', now(), now() + make_interval(days => p.trial_days)
    from public.billing_plans p
   where p.code = 'start'
  on conflict (salon_id) do nothing;
  return new;
end;
$$;

drop trigger if exists billing_on_salon_created on public.salons;
create trigger billing_on_salon_created
  after insert on public.salons
  for each row execute function public.billing_on_salon_created();

-- Запрет записи при блокировке. Триггер на таблице, а не проверка в create_appointment: записи
-- создаются несколькими путями (RPC, предоплата, импорт, super_admin), и проверка в одном из них
-- оставила бы остальные открытыми.
create or replace function public.billing_guard_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.billing_salon_is_blocked(new.salon_id) then
    raise exception 'salon_billing_suspended'
      using errcode = 'P0001', hint = 'Подписка Qabyl не оплачена — онлайн-запись приостановлена.';
  end if;
  return new;
end;
$$;

drop trigger if exists billing_guard_appointment on public.appointments;
create trigger billing_guard_appointment
  before insert on public.appointments
  for each row execute function public.billing_guard_appointment();

-- Лимит филиалов тарифа.
create or replace function public.billing_guard_branch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _limit integer;
  _exempt boolean;
  _count integer;
begin
  select (p.limits->>'branches')::int, s.billing_exempt
    into _limit, _exempt
    from public.salon_subscriptions s
    join public.billing_plans p on p.code = s.plan_code
   where s.salon_id = new.salon_id;

  if _limit is null or coalesce(_exempt, false)
     or not coalesce((select (config->>'enforcement_enabled')::boolean
                        from public.billing_settings where id), true) then
    return new;
  end if;

  select count(*) into _count from public.branches where salon_id = new.salon_id;
  if _count >= _limit then
    raise exception 'plan_branch_limit'
      using errcode = 'P0001', hint = format('На вашем тарифе до %s филиалов. Перейдите на тариф выше.', _limit);
  end if;
  return new;
end;
$$;

drop trigger if exists billing_guard_branch on public.branches;
create trigger billing_guard_branch
  before insert on public.branches
  for each row execute function public.billing_guard_branch();

-- ---------------------------------------------------------------------------
-- 11. Существующие салоны — освобождены
-- ---------------------------------------------------------------------------
insert into public.salon_subscriptions
  (salon_id, plan_code, status, billing_exempt, current_period_start, current_period_end)
select id, 'business', 'active', true, now(), now() + interval '30 days'
  from public.salons
on conflict (salon_id) do nothing;

-- ---------------------------------------------------------------------------
-- 12. Права
-- ---------------------------------------------------------------------------
alter table public.billing_settings enable row level security;
alter table public.billing_plans enable row level security;
alter table public.salon_subscriptions enable row level security;
alter table public.billing_payment_methods enable row level security;
alter table public.billing_usage enable row level security;
alter table public.billing_credits enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_events enable row level security;

-- Тарифы публичны: их показывает страница цен и мастер настройки до входа.
drop policy if exists "Anyone reads active plans" on public.billing_plans;
create policy "Anyone reads active plans" on public.billing_plans
  for select to anon, authenticated using (is_active);

-- Себестоимость — только владелец платформы.
drop policy if exists "Super admin reads billing settings" on public.billing_settings;
create policy "Super admin reads billing settings" on public.billing_settings
  for select to authenticated using (public.has_role(auth.uid(), 'super_admin'));

drop policy if exists "Salon reads own subscription" on public.salon_subscriptions;
create policy "Salon reads own subscription" on public.salon_subscriptions
  for select to authenticated using (public.has_salon_access(auth.uid(), salon_id));

drop policy if exists "Salon reads own usage" on public.billing_usage;
create policy "Salon reads own usage" on public.billing_usage
  for select to authenticated using (public.has_salon_access(auth.uid(), salon_id));

drop policy if exists "Salon reads own credits" on public.billing_credits;
create policy "Salon reads own credits" on public.billing_credits
  for select to authenticated using (public.has_salon_access(auth.uid(), salon_id));

drop policy if exists "Salon reads own invoices" on public.billing_invoices;
create policy "Salon reads own invoices" on public.billing_invoices
  for select to authenticated using (public.has_salon_access(auth.uid(), salon_id));

drop policy if exists "Super admin reads billing events" on public.billing_events;
create policy "Super admin reads billing events" on public.billing_events
  for select to authenticated using (public.has_role(auth.uid(), 'super_admin'));

-- Писать в биллинг из браузера нельзя никому: все изменения идут через серверные функции.
grant select on public.billing_plans to anon, authenticated;
grant select on public.billing_settings, public.salon_subscriptions, public.billing_usage,
  public.billing_credits, public.billing_invoices, public.billing_events to authenticated;
revoke all on public.billing_payment_methods from anon, authenticated;

revoke all on function public.billing_record_usage(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.billing_record_wa_usage(text, integer) from public, anon, authenticated;
revoke all on function public.billing_record_ig_usage(text, integer) from public, anon, authenticated;
revoke all on function public.billing_current_period_start(uuid) from public, anon, authenticated;
grant execute on function public.billing_record_usage(uuid, text, integer) to service_role;
grant execute on function public.billing_record_wa_usage(text, integer) to service_role;
grant execute on function public.billing_record_ig_usage(text, integer) to service_role;
grant execute on function public.billing_current_period_start(uuid) to service_role;

revoke all on function public.billing_salon_is_blocked(uuid) from public;
grant execute on function public.billing_salon_is_blocked(uuid) to anon, authenticated, service_role;

revoke all on function public.billing_salon_state(uuid) from public, anon;
grant execute on function public.billing_salon_state(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ОТКАТ
-- ---------------------------------------------------------------------------
--   drop trigger if exists billing_guard_branch on public.branches;
--   drop trigger if exists billing_guard_appointment on public.appointments;
--   drop trigger if exists billing_on_salon_created on public.salons;
--   drop function if exists public.billing_guard_branch(), public.billing_guard_appointment(),
--     public.billing_on_salon_created(), public.billing_salon_state(uuid),
--     public.billing_salon_is_blocked(uuid), public.billing_record_ig_usage(text, integer),
--     public.billing_record_wa_usage(text, integer), public.billing_record_usage(uuid, text, integer),
--     public.billing_current_period_start(uuid);
--   drop table if exists public.billing_events, public.billing_invoices, public.billing_credits,
--     public.billing_usage, public.billing_payment_methods, public.salon_subscriptions,
--     public.billing_plans, public.billing_settings;
-- Самый быстрый частичный откат без удаления данных — снять триггер блокировки записи.
