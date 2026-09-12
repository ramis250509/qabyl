-- Перезапуск необработанных входящих переезжает с удалённого Green-API на Cloud API.
--
-- ЧТО БЫЛО СЛОМАНО. Функция public.wa_run_reconciliation() (миграция 20260728120000) раз в минуту
-- постила в https://qabyl.com/api/public/wa/<salon_id>?token=<greenapi_webhook_token> — вебхук
-- Green-API. Транспорт удалён 28.08.2026 вместе с маршрутом, а задача осталась в расписании и
-- продолжала стучаться в никуда. То есть механизм, который должен подхватывать потерянные
-- сообщения клиентов, не работал вообще — и это не было видно, потому что после 26.08 ни один
-- салон не работал на WhatsApp.
--
-- ЧТО ТЕПЕРЬ. Задача зовёт /api/internal/cron/wa-reconcile (секрет в заголовке x-cron-secret, как
-- у остальных задач). Там код находит входящие с processed_at IS NULL старше пяти минут и
-- прогоняет их через тот же путь, что и обычный вебхук Meta, — с тем же замком и дедупликацией,
-- поэтому дважды ответить клиенту нельзя.
--
-- Старая функция НЕ удаляется: она безвредна без расписания и остаётся историей. Если понадобится
-- откат — вернуть её расписание (см. конец файла).

do $$
begin
  perform cron.unschedule('wa_reconcile_paused_every_minute');
exception
  when others then null;
end $$;

do $$
begin
  perform cron.unschedule('wa-reconcile');
exception
  when others then null;
end $$;

select cron.schedule(
  'wa-reconcile',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://qabyl.com/api/internal/cron/wa-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT public.internal_get_cron_secret())
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) AS request_id;
  $$
);

comment on function public.wa_run_reconciliation() is
  'УСТАРЕЛА 13.09.2026: постила в удалённый маршрут Green-API. Перезапуск живёт в задаче wa-reconcile → /api/internal/cron/wa-reconcile. Функция оставлена для истории и отката.';

-- ОТКАТ:
--   select cron.unschedule('wa-reconcile');
--   select cron.schedule('wa_reconcile_paused_every_minute', '* * * * *',
--     $cron$ SELECT public.wa_run_reconciliation(); $cron$);
