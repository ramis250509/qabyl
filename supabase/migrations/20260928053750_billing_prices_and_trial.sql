-- Коммерческие цены и длительность пробного периода изменились перед production-запуском.
-- Обновляем единый каталог тарифов; уже начатые пробные периоды не сокращаем задним числом.

update public.billing_plans
set price_kgs = case code
      when 'start' then 4997
      when 'business' then 5997
      when 'pro' then 8997
      else price_kgs
    end,
    trial_days = 10,
    name = case code
      when 'start' then 'Start'
      when 'business' then 'Pro'
      when 'pro' then 'Business'
      else name
    end,
    updated_at = now()
where code in ('start', 'business', 'pro')
  and (
    trial_days is distinct from 10
    or price_kgs is distinct from case code
      when 'start' then 4997
      when 'business' then 5997
      when 'pro' then 8997
      else price_kgs
    end
    or name is distinct from case code
      when 'start' then 'Start'
      when 'business' then 'Pro'
      when 'pro' then 'Business'
      else name
    end
  );

-- Webhook уже идемпотентен по event_key и блокировке счёта. Уникальность invoice_id добавляет
-- последний барьер: один оплаченный счёт физически не сможет начислить пакет дважды.
create unique index if not exists billing_credits_invoice_uidx
  on public.billing_credits (invoice_id)
  where invoice_id is not null;
