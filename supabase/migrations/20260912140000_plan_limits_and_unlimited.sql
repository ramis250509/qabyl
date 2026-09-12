-- Новые лимиты сообщений и понятие «безлимит».
--
-- Start 1500 → 2000, Business 3000 → 5000, Pro 6000 → без лимита.
--
-- КАК ЗАПИСАН БЕЗЛИМИТ И ПОЧЕМУ ИМЕННО ТАК. limits->>'messages_month' = -1.
--
-- Ноль не годится: по всему коду allowance <= 0 уже означает «лимита нет вообще», и на таком
-- тарифе ассистент замолчал бы с первого сообщения — ровно наоборот тому, что обещает карточка.
-- NULL не годится тоже: coalesce(..., 0) в этой же функции превратил бы его в тот же ноль.
-- Отрицательное число ни с чем не путается и читается однозначно: «считать не нужно».
--
-- БЕЗЛИМИТ ДЕЙСТВУЕТ И В ПРОБНЫЙ ПЕРИОД. Обычно на пробном действует отдельный лимит
-- trial_messages — страховка от того, чтобы бесплатным периодом пользовались как тарифом. Но на
-- тарифе, который называется «безлимит», такая страховка превращается в обман: карточка обещает
-- «сообщений сколько угодно», а на семисотом ассистент замолкает. Обещание дороже страховки,
-- тем более что тариф продаётся руками, а не самообслуживанием.

update public.billing_plans
   set limits = jsonb_set(limits, '{messages_month}', '2000'::jsonb),
       updated_at = now()
 where code = 'start';

update public.billing_plans
   set limits = jsonb_set(limits, '{messages_month}', '5000'::jsonb),
       updated_at = now()
 where code = 'business';

update public.billing_plans
   set limits = jsonb_set(limits, '{messages_month}', '-1'::jsonb),
       updated_at = now()
 where code = 'pro';

-- Состояние салона: научить считать безлимит.
--
-- Отличается от прежней версии тремя строками: _unlimited, и три поля, которые от него зависят.
-- Всё остальное — без изменений.
create or replace function public.billing_salon_state(_salon_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
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
  _unlimited boolean;
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

  _unlimited := coalesce((_p.limits->>'messages_month')::int, 0) < 0;

  _allowance := coalesce(
    case when _s.status = 'trialing' and not _unlimited
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
    -- −1 доезжает до интерфейса как есть: там он означает «показывай „без лимита“», а не число.
    'messages_allowance', case when _unlimited then -1 else _allowance end,
    'messages_credits', _credits,
    'usage_pct', case when _unlimited then 0
                      when _allowance > 0 then round(_used * 100.0 / _allowance)
                      else 0 end,
    'usage_warn_pct', coalesce((_cfg->>'usage_warn_pct')::int, 80),
    'trial_warn_days', coalesce((_cfg->>'trial_warn_days')::int, 3),
    'assistant_paused',
      not _unlimited and _enforced and not _s.billing_exempt and _used >= _allowance,
    'notifications_paused',
      not _unlimited and _enforced and not _s.billing_exempt
      and _used >= _allowance * _ceiling_pct / 100,
    'limits', _p.limits,
    'features', _p.features
  );
end;
$function$;
