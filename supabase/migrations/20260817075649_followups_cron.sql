-- Cron-задача для догонялок: вытащена обратно в репозиторий 2026-08-19.
--
-- Миграция была применена к проду напрямую (через MCP/дашборд) и существовала только
-- в базе — файла в supabase/migrations/ не было. Это значит, что развернуть схему с
-- нуля из репозитория было нельзя: расписание догонялок просто не создалось бы.
-- Содержимое ниже снято с боевой записи supabase_migrations.schema_migrations
-- (версия 20260817075649).
--
-- Отличие от применённого оригинала: добавлен unschedule перед schedule. Оригинал при
-- повторном прогоне падал бы на дубликате имени задачи, а миграции в этом репозитории
-- обязаны быть идемпотентными.

-- Раз в 15 минут, как и напоминания. Кого именно догонять, решает сам эндпоинт;
-- большинство запусков не отправляет ничего — это ожидаемое поведение, а не простой.
do $$
begin
  perform cron.unschedule('send-followups');
exception
  when others then null; -- задачи ещё нет — это нормально при первом накате
end $$;

select cron.schedule(
  'send-followups',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://qabyl.com/api/internal/cron/followups',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT public.internal_get_cron_secret())
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);
