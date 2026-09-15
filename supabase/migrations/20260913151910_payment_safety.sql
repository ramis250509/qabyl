-- Concurrent callbacks must commit the invoice and entitlement together. Unknown bank
-- outcomes stay pending: elapsed time is never evidence that money was not collected.
alter table public.salon_subscriptions add column if not exists auto_topup_threshold integer not null default 500 check (auto_topup_threshold in (500,1000));
alter table public.salon_subscriptions add column if not exists auto_topup_packs integer not null default 1 check (auto_topup_packs between 1 and 10);
alter table public.salon_subscriptions add column if not exists auto_topup_consent_at timestamptz;
alter table public.salon_subscriptions add column if not exists renewal_consent_at timestamptz;
alter table public.salon_subscriptions alter column auto_topup set default false;
alter table public.billing_invoices add column if not exists dispatch_started_at timestamptz;
alter table public.billing_invoices add column if not exists checkout_url text;
alter table public.billing_invoices add column if not exists refunded_kgs integer not null default 0 check (refunded_kgs >= 0);
alter table public.billing_invoices drop constraint if exists billing_invoices_status_check;
alter table public.billing_invoices add constraint billing_invoices_status_check check (status in ('pending','paid','failed','canceled','refunded'));

create table if not exists public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id),
  provider text not null check (provider = 'freedompay'),
  merchant_reference text,
  terminal_reference text,
  credentials_reference text,
  status text not null default 'unconfigured' check (status in ('unconfigured','pending_review','active','disabled')),
  created_at timestamptz not null default now(),
  unique (salon_id, provider)
);
comment on table public.payment_accounts is 'Reserved for salon-owned acquiring. No platform-account fallback. Credentials reference points to server secret storage, never raw keys.';
create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.billing_invoices(id),
  salon_id uuid not null references public.salons(id),
  provider text not null,
  event_key text not null unique,
  outcome text not null check (outcome in ('paid','failed','canceled','refunded')),
  created_at timestamptz not null default now()
);
alter table public.payment_accounts enable row level security;
alter table public.payment_webhook_events enable row level security;
revoke all on public.payment_accounts, public.payment_webhook_events from anon, authenticated;
grant all on public.payment_accounts, public.payment_webhook_events to service_role;

-- Display names change, stable codes and existing salon entitlements do not.
update public.billing_plans set name = 'Pro', updated_at = now() where code = 'business' and price_kgs = 6499;
update public.billing_plans set name = 'Business', updated_at = now() where code = 'pro' and price_kgs = 10499;

create or replace function public.billing_reserve_invoice(_salon_id uuid, _invoice jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.salon_subscriptions; i uuid;
begin
  select * into strict s from public.salon_subscriptions where salon_id = _salon_id for update;
  if _invoice->>'provider' <> 'manual' then
    if exists (select 1 from public.billing_invoices where salon_id = _salon_id
      and kind = _invoice->>'kind' and (status = 'pending' or
        (status = 'paid' and created_at > now() - interval '10 minutes'))) then
      raise exception 'Предыдущий платёж ещё ожидает подтверждения. Обновите историю оплаты.';
    end if;
    if _invoice->>'kind' = 'subscription' and exists (select 1 from public.billing_invoices
      where salon_id = _salon_id and kind = 'subscription' and status = 'paid'
      and period_start = (_invoice->>'period_start')::timestamptz) then
      raise exception 'Этот период уже оплачен';
    end if;
  end if;
  insert into public.billing_invoices(salon_id,kind,amount_kgs,provider,plan_code,period_start,period_end,metadata)
  values (_salon_id,_invoice->>'kind',(_invoice->>'amount_kgs')::integer,
    _invoice->>'provider',_invoice->>'plan_code',(_invoice->>'period_start')::timestamptz,
    (_invoice->>'period_end')::timestamptz,coalesce(_invoice->'metadata','{}')) returning id into i;
  return i;
end $$;

create or replace function public.billing_settle_invoice(_id uuid, _info jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare i public.billing_invoices; s public.salon_subscriptions; period timestamptz; ahead boolean;
begin
  -- Same lock order as reservation; serializes entitlements for a salon as well as callbacks.
  select salon_id into i.salon_id from public.billing_invoices where id = _id;
  if not found then raise exception 'Unknown invoice'; end if;
  select * into strict s from public.salon_subscriptions where salon_id = i.salon_id for update;
  select * into strict i from public.billing_invoices where id = _id for update;
  if i.status in ('paid','refunded') then return false; end if;
  if i.provider_payment_id is not null and _info->>'paymentId' is not null
    and i.provider_payment_id <> _info->>'paymentId' then raise exception 'Payment identity mismatch'; end if;
  if _info->>'cardMask' is not null and (_info->>'cardMask') !~ '^\*{4} [0-9]{4}$' then raise exception 'Invalid card display'; end if;
  update public.billing_invoices set status = 'paid', paid_at = now(), updated_at = now(),
    provider_payment_id = coalesce(_info->>'paymentId',provider_payment_id), last_error = null,
    next_attempt_at = null where id = _id;
  if _info->>'cardToken' is not null or _info->>'recurringProfileId' is not null then
    insert into public.billing_payment_methods(salon_id,provider,card_token,recurring_profile_id,card_mask)
      values(i.salon_id,i.provider,_info->>'cardToken',_info->>'recurringProfileId',_info->>'cardMask')
      on conflict(salon_id) do update set card_token = excluded.card_token,
      recurring_profile_id = excluded.recurring_profile_id, card_mask = excluded.card_mask, updated_at = now();
  end if;
  if i.kind = 'subscription' then
    if i.period_start is null or i.period_end is null or i.plan_code is null then raise exception 'Missing subscription period'; end if;
    ahead := i.period_start > now() + interval '1 minute' and s.status in ('trialing','active');
    if not ahead and (s.current_period_end is null or i.period_end > s.current_period_end) then
      update public.salon_subscriptions set status = 'active',plan_code = i.plan_code,
        current_period_start = i.period_start,current_period_end = i.period_end,
        pending_plan_code = null, grace_until = null,last_payment_error = null,updated_at = now()
        where salon_id = i.salon_id;
    end if;
  elsif i.kind = 'proration' then
    update public.salon_subscriptions set plan_code = i.plan_code,updated_at = now() where salon_id = i.salon_id;
  elsif i.kind = 'overage_pack' then
    period := public.billing_current_period_start(i.salon_id);
    if period is null or coalesce((i.metadata->>'messages')::integer,0) <= 0 then raise exception 'Invalid pack'; end if;
    insert into public.billing_credits(salon_id,period_start,messages,source,invoice_id)
      values(i.salon_id,period,(i.metadata->>'messages')::integer,'pack',i.id);
  end if;
  update public.salon_subscriptions set card_mask = coalesce(_info->>'cardMask',card_mask) where salon_id = i.salon_id;
  insert into public.billing_events(salon_id,type,payload) values(i.salon_id,'payment_succeeded',jsonb_build_object('invoiceId',i.id));
  insert into public.notifications(salon_id,type,title,body) values(i.salon_id,'billing','Оплата прошла',
    case when i.kind = 'overage_pack' then 'Пакет сообщений добавлен.' else 'Подписка оплачена.' end);
  return true;
end $$;

-- The event and its effects share a transaction; a crash cannot acknowledge lost credit.
create or replace function public.billing_receive_event(_id uuid, _key text, _outcome text, _info jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare i public.billing_invoices; inserted uuid;
begin
  select * into strict i from public.billing_invoices where id = _id;
  perform 1 from public.salon_subscriptions where salon_id = i.salon_id for update;
  select * into strict i from public.billing_invoices where id = _id for update;
  insert into public.payment_webhook_events(invoice_id,salon_id,provider,event_key,outcome)
    values(i.id,i.salon_id,i.provider,_key,_outcome) on conflict(event_key) do nothing returning id into inserted;
  if inserted is null then return false; end if;
  if _outcome = 'paid' then perform public.billing_settle_invoice(_id,_info);
  elsif _outcome in ('failed','canceled') and i.status = 'pending' then
    update public.billing_invoices set status = _outcome, next_attempt_at = null,
      last_error = 'Банк не подтвердил оплату. Проверьте баланс или используйте другую карту.',updated_at = now() where id = _id;
  elsif _outcome = 'refunded' then
    -- Refund entitlement decisions require approved commercial rules; record money only.
    if i.status not in ('paid','refunded') then raise exception 'Refund before payment'; end if;
    if _info->>'refundedKgs' is null or (_info->>'refundedKgs')::integer not between 1 and i.amount_kgs then raise exception 'Invalid refund'; end if;
    update public.billing_invoices set refunded_kgs = greatest(refunded_kgs,(_info->>'refundedKgs')::integer),
      status = case when (_info->>'refundedKgs')::integer = amount_kgs then 'refunded' else 'paid' end,
      updated_at = now() where id = _id;
    insert into public.billing_events(salon_id,type,payload) values(i.salon_id,'refund_review_required',jsonb_build_object('invoiceId',i.id));
  end if;
  return true;
end $$;
revoke all on function public.billing_reserve_invoice(uuid,jsonb), public.billing_settle_invoice(uuid,jsonb), public.billing_receive_event(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.billing_reserve_invoice(uuid,jsonb), public.billing_settle_invoice(uuid,jsonb), public.billing_receive_event(uuid,text,text,jsonb) to service_role;

create or replace function public.billing_reserve_topup(_salon_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.salon_subscriptions; p public.billing_plans; state jsonb; i uuid;
begin
  select * into strict s from public.salon_subscriptions where salon_id = _salon_id for update;
  if not s.auto_topup or s.auto_topup_consent_at is null or s.billing_exempt or s.status <> 'active' then return null; end if;
  state := public.billing_salon_state(_salon_id);
  if (state->>'exempt')::boolean or (state->>'messages_allowance')::integer < 0 then return null; end if;
  if (state->>'messages_allowance')::integer - (state->>'messages_used')::integer > s.auto_topup_threshold then return null; end if;
  -- No new attempt while a result is unknown. A confirmed failure has a 24h cooldown.
  if exists(select 1 from public.billing_invoices where salon_id = _salon_id and kind = 'overage_pack'
    and (status = 'pending' or created_at > now() - interval '10 minutes'
      or (status = 'failed' and metadata->>'source' = 'auto' and created_at > now() - interval '24 hours'))) then return null; end if;
  if not exists(select 1 from public.billing_payment_methods where salon_id = _salon_id
    and (card_token is not null or recurring_profile_id is not null)) then return null; end if;
  select * into strict p from public.billing_plans where code = s.plan_code and is_active;
  i := public.billing_reserve_invoice(_salon_id,jsonb_build_object(
    'kind','overage_pack','provider','freedompay','amount_kgs',(p.limits->>'overage_pack_price_kgs')::integer * s.auto_topup_packs,
    'metadata',jsonb_build_object('messages',(p.limits->>'overage_pack_messages')::integer*s.auto_topup_packs,
      'source','auto','via','recurring','consent_at',s.auto_topup_consent_at)));
  return i;
end $$;

create or replace function public.billing_claim_dispatch(_salon_id uuid, _id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare s public.salon_subscriptions; i public.billing_invoices;
begin
  select * into strict s from public.salon_subscriptions where salon_id = _salon_id for update;
  select * into strict i from public.billing_invoices where id = _id and salon_id = _salon_id for update;
  if i.status <> 'pending' or i.dispatch_started_at is not null then return false; end if;
  if i.metadata->>'source' = 'auto' and (not s.auto_topup or s.auto_topup_consent_at is null
    or s.auto_topup_consent_at::text <> (i.metadata->>'consent_at')::timestamptz::text) then
    update public.billing_invoices set status = 'canceled' where id = _id;
    return false;
  end if;
  if i.kind = 'subscription' and (s.cancel_at_period_end or s.renewal_consent_at is null) then return false; end if;
  update public.billing_invoices set dispatch_started_at = now(), next_attempt_at = null where id = _id;
  return true;
end $$;
revoke all on function public.billing_reserve_topup(uuid), public.billing_claim_dispatch(uuid,uuid) from public,anon,authenticated;
grant execute on function public.billing_reserve_topup(uuid), public.billing_claim_dispatch(uuid,uuid) to service_role;
