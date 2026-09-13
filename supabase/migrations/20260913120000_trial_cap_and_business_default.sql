-- Лимиты без убыточных хвостов и пробный период на Business.
--
-- Business 5000 → 4000: на полном лимите маржа была 22%, стала ~37%. Реальные салоны до 4000 не
-- доходят: у самого загруженного (Lashes Nurzhan) бот отправлял ~1100 сообщений в месяц — прежние
-- «3867» включали эхо сообщений, которые владелица писала сама с телефона, а их Meta не тарифицирует.
--
-- Pro без лимита → 8000 + пакеты. На безлимите после ~10 800 сообщений каждый клиент убыточен, а
-- Pro выбирают как раз самые загруженные. С числовым лимитом снова действует trial_messages
-- (см. 20260912140000: безлимит его обходил).
--
-- trial_messages 1000 на всех тарифах: пробный период стоит Qabyl не больше ~900 сом, даже если
-- салон не заплатит.
--
-- Новый салон стартует на Business (14 дней), а не на Start (30): видит все функции, привыкает к
-- цене главного тарифа и успевает принять решение об оплате в тот же месяц.

update public.billing_plans
   set limits = limits || '{"trial_messages": 1000}'::jsonb, updated_at = now()
 where code = 'start';

update public.billing_plans
   set limits = limits || '{"messages_month": 4000, "trial_messages": 1000}'::jsonb, updated_at = now()
 where code = 'business';

update public.billing_plans
   set limits = limits || '{"messages_month": 8000, "trial_messages": 1000}'::jsonb, updated_at = now()
 where code = 'pro';

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
   where p.code = 'business'
  on conflict (salon_id) do nothing;
  return new;
end;
$$;
