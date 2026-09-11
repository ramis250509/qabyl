-- Ежечасный цикл биллинга: конец пробного периода, продление, повторные списания, отсрочка,
-- блокировка, предупреждения о расходе.
--
-- Минута 17: в 0 стоят напоминания, в 7 — проверка здоровья WhatsApp. Цикл биллинга ходит в
-- Freedom Pay и не должен стартовать одновременно с задачами, которые ходят в Meta.
--
-- Идемпотентна: unschedule перед schedule.

do $$
begin
  perform cron.unschedule('billing-cycle');
exception
  when others then null;
end $$;

select cron.schedule(
  'billing-cycle',
  '17 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://qabyl.com/api/internal/cron/billing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT public.internal_get_cron_secret())
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);

-- ОТКАТ:
--   select cron.unschedule('billing-cycle');
