-- Подключение Instagram кнопкой через общее приложение Qabyl (Business Login for Instagram).
--
-- instagram_connected_via:
--   'manual'   — своё приложение салона, токен вставлен руками, вебхук на /api/public/ig/<salon>
--   'platform' — кнопка «Подключить Instagram», вебхук на общий /api/public/ig
--   NULL       — старые строки; ведут себя как 'manual'
--
-- instagram_token_expires_at нужен только для 'platform': такой токен продлеваем мы сами
-- (задача ig-token-refresh). Ручной токен продлевает владелец, как и раньше.
--
-- Идемпотентна.

alter table public.salon_secrets
  add column if not exists instagram_token_expires_at timestamptz,
  add column if not exists instagram_connected_via text;

do $$
begin
  alter table public.salon_secrets
    add constraint salon_secrets_instagram_connected_via_check
    check (instagram_connected_via is null or instagram_connected_via in ('manual', 'platform'));
exception
  when duplicate_object then null;
end $$;

comment on column public.salon_secrets.instagram_token_expires_at is
  'Когда истекает токен Instagram, полученный кнопкой. Продлевается cron-задачей ig-token-refresh.';
comment on column public.salon_secrets.instagram_connected_via is
  'manual — своё приложение салона; platform — кнопка через приложение Qabyl.';

-- Один аккаунт Instagram — один салон. Иначе общий вебхук не знает, кому отдать сообщение.
create unique index if not exists salon_secrets_instagram_user_id_uniq
  on public.salon_secrets (instagram_user_id)
  where instagram_user_id is not null and instagram_user_id <> '';

-- Раз в сутки, минута 23 — в стороне от ежечасных задач на :00 и :07.
do $$
begin
  perform cron.unschedule('ig-token-refresh');
exception
  when others then null;
end $$;

select cron.schedule(
  'ig-token-refresh',
  '23 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://qabyl.com/api/internal/cron/ig-token-refresh',
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
--   select cron.unschedule('ig-token-refresh');
--   drop index if exists salon_secrets_instagram_user_id_uniq;
--   alter table public.salon_secrets drop constraint if exists salon_secrets_instagram_connected_via_check;
--   alter table public.salon_secrets drop column if exists instagram_token_expires_at, drop column if exists instagram_connected_via;
