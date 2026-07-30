-- ============================================================================
-- OPS-AGENTS FOUNDATION (фазы 0 + 1)
-- ============================================================================
-- Внутренняя команда ИИ-агентов для управления бизнесом Qabyl через Telegram.
-- ПОЛНОСТЬЮ ИЗОЛИРОВАНА от клиентского продукта: все таблицы с префиксом ops_,
-- весь код — под /api/internal/**. Клиентский путь (booking, wa-агент) не трогается.
--
-- Что делает эта миграция:
--   1) Таблицы ops_* (конфиг/kill-switch, реестр агентов, аудит, событийная шина,
--      задачи, approvals, память, лиды/встречи — часть под фазу 2, заложена сейчас).
--   2) БД-роль ops_agent как ЗАГОТОВКА под фазу 2 (write-агенты). В фазе 1 код ходит
--      под service_role через узкий слой read-only RPC — блоб-радиус минимален
--      (только SELECT'ы + запись в ops_*). Полное разделение по роли включим в фазе 2,
--      когда у агентов появятся действия наружу.
--   3) Read-only RPC для дайджеста Кэпа и скана ошибок Деби (SECURITY DEFINER).
--   4) pg_cron: ежедневный дайджест + скан ошибок каждые 15 мин, бьют в Worker
--      (qabyl.com/api/internal/cron/*) с общим x-cron-secret (тот же vault 'cron_secret').
--
-- RLS включён на всех ops_* без policy для authenticated/anon — из браузера они
-- недоступны в принципе; пишет/читает только service_role (Worker), обходя RLS.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. KILL-SWITCH + мелкие курсоры
-- ---------------------------------------------------------------------------

-- Синглтон-строка (id=1). agents_enabled=false → аварийная остановка ВСЕЙ команды:
-- проверяется в начале Telegram-вебхука и каждого крон-эндпоинта.
CREATE TABLE IF NOT EXISTS public.ops_config (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  agents_enabled boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);
INSERT INTO public.ops_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Разное состояние агентов: курсор скана ошибок, время последнего дайджеста и т.п.
CREATE TABLE IF NOT EXISTS public.ops_kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. РЕЕСТР АГЕНТОВ
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ops_agents (
  key        text PRIMARY KEY,          -- 'chief' | 'sre' | 'sales' | 'marketer'
  name       text NOT NULL,             -- отображаемое имя (Кэп, Деби, Айдар, Мира)
  role_title text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  paused     boolean NOT NULL DEFAULT false,  -- пауза одного агента (/stop <имя>)
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.ops_agents (key, name, role_title, enabled, paused) VALUES
  ('chief',    'Кэп',   'Chief of Staff',  true,  false),
  ('sre',      'Деби',  'Dev/SRE',         true,  false),
  ('sales',    'Айдар', 'Sales',           true,  true),   -- включим в фазе 2
  ('marketer', 'Мира',  'Marketer',        true,  true)    -- включим в фазе 2
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. АУДИТ (append-only)
-- ---------------------------------------------------------------------------
-- Каждое предложенное/одобренное/выполненное действие. UPDATE/DELETE отозваны у
-- всех, включая service_role, чтобы историю нельзя было переписать (только вставка).
CREATE TABLE IF NOT EXISTS public.ops_audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text NOT NULL,               -- 'owner' | ключ агента | 'cron' | 'system'
  action   text NOT NULL,               -- 'digest.sent' | 'sre.alert' | 'killswitch.off' ...
  ref_type text,
  ref_id   text,
  detail   jsonb
);
CREATE INDEX IF NOT EXISTS ops_audit_log_at_idx ON public.ops_audit_log (at DESC);

-- ---------------------------------------------------------------------------
-- 4. СОБЫТИЙНАЯ ШИНА (общение между агентами) — заложена под фазу 2
-- ---------------------------------------------------------------------------
-- Агенты НЕ пишут друг другу напрямую. Один публикует событие (promo.planned,
-- lead.qualified, incident.opened), другие читают на своём запуске. hops — счётчик
-- цепочки, обрывает пинг-понг. handled_at — событие обработано подписчиком.
CREATE TABLE IF NOT EXISTS public.ops_events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  type         text NOT NULL,
  source_agent text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  hops         smallint NOT NULL DEFAULT 0,     -- защита от бесконечных цепочек
  handled_at   timestamptz
);
CREATE INDEX IF NOT EXISTS ops_events_unhandled_idx
  ON public.ops_events (at) WHERE handled_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. ДОСКА ЗАДАЧ
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ops_tasks (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  agent      text NOT NULL,             -- ответственный агент
  title      text NOT NULL,
  status     text NOT NULL DEFAULT 'proposed'
             CHECK (status IN ('proposed','awaiting_approval','approved','in_progress','done','rejected','blocked')),
  detail     jsonb
);
CREATE INDEX IF NOT EXISTS ops_tasks_status_idx ON public.ops_tasks (status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 6. APPROVALS (гейт одобрения) — каркас под кнопки Telegram
-- ---------------------------------------------------------------------------
-- Кнопка в Telegram несёт ТОЛЬКО id этой строки. Само действие хранится в action
-- (server-side) — payload кнопки подделать нельзя. Воркер выполняет action лишь
-- после status='approved'. В фазе 1 approvals не создаются (агенты только читают),
-- но таблица и обработчик колбэков готовы для фазы 2.
CREATE TABLE IF NOT EXISTS public.ops_approvals (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  agent      text NOT NULL,
  kind       text NOT NULL,             -- 'send_lead_message' | 'publish_post' | 'create_branch' ...
  summary    text NOT NULL,             -- что увидит владелец
  action     jsonb NOT NULL,            -- сохранённое действие для исполнения после approve
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','approved','rejected','expired','executed','failed')),
  tg_message_id bigint,                 -- сообщение с кнопками (для edit после решения)
  decided_at timestamptz,
  executed_at timestamptz,
  result     jsonb
);
CREATE INDEX IF NOT EXISTS ops_approvals_pending_idx
  ON public.ops_approvals (created_at DESC) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- 7. ПАМЯТЬ ДИАЛОГА (по агенту/топику)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ops_messages (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  thread   text NOT NULL,               -- ключ агента / топик
  role     text NOT NULL CHECK (role IN ('owner','agent','system')),
  text     text,
  meta     jsonb
);
CREATE INDEX IF NOT EXISTS ops_messages_thread_idx ON public.ops_messages (thread, at DESC);

-- ---------------------------------------------------------------------------
-- 8. ЛИДЫ + ВСТРЕЧИ (фаза 2 — заложены сейчас, пустые)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ops_leads (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name       text,
  phone      text,
  company    text,
  industry   text,
  stage      text NOT NULL DEFAULT 'new'
             CHECK (stage IN ('new','qualifying','meeting_set','won','lost')),
  needs      text,
  objections text,
  notes      text
);

CREATE TABLE IF NOT EXISTS public.ops_meetings (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  lead_id    bigint REFERENCES public.ops_leads(id) ON DELETE SET NULL,
  starts_at  timestamptz NOT NULL,
  location   text,                      -- адрес или ссылка (Zoom/Meet)
  notes      text,
  status     text NOT NULL DEFAULT 'scheduled'
             CHECK (status IN ('scheduled','done','cancelled','no_show'))
);

-- ---------------------------------------------------------------------------
-- 9. RLS — закрыть всё от браузера; service_role обходит RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ops_config','ops_kv','ops_agents','ops_audit_log','ops_events',
    'ops_tasks','ops_approvals','ops_messages','ops_leads','ops_meetings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    -- Никаких policy для authenticated/anon — доступ только у service_role.
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 10. РОЛЬ ops_agent — ЗАГОТОВКА под фазу 2 (не используется кодом в фазе 1)
-- ---------------------------------------------------------------------------
-- Создаём роль без логина и выдаём права ТОЛЬКО на ops_*. В фазе 2 подключим
-- отдельного supabase-клиента под этой ролью, чтобы write-агенты физически не
-- могли трогать ничего вне ops_*. Пока это groundwork.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_agent') THEN
    CREATE ROLE ops_agent NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ops_agent;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ops_config','ops_kv','ops_agents','ops_audit_log','ops_events',
    'ops_tasks','ops_approvals','ops_messages','ops_leads','ops_meetings'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO ops_agent;', t);
  END LOOP;
END $$;
-- Аудит неизменяем даже для ops_agent: только вставка.
REVOKE UPDATE, DELETE ON public.ops_audit_log FROM ops_agent;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ops_agent;

-- Аудит — append-only для ВСЕХ (в т.ч. service_role): только INSERT/SELECT.
REVOKE UPDATE, DELETE ON public.ops_audit_log FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 11. RPC ДЛЯ ДАЙДЖЕСТА КЭПА (один round-trip, вся сводка по бизнесу)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_digest_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'salons_total',        (SELECT count(*) FROM salons),
    'bookings_today',      (SELECT count(*) FROM appointments
                              WHERE created_at::date = now()::date AND status <> 'cancelled'),
    'bookings_7d',         (SELECT count(*) FROM appointments
                              WHERE created_at >= now() - interval '7 days' AND status <> 'cancelled'),
    'ai_bookings_7d',      (SELECT count(*) FROM appointments
                              WHERE created_at >= now() - interval '7 days'
                                AND status <> 'cancelled' AND source = 'ai_assistant'),
    'no_show_30d',         (SELECT count(*) FROM appointments
                              WHERE status = 'no_show' AND starts_at >= now() - interval '30 days'),
    'conversations_today', (SELECT count(*) FROM wa_conversations
                              WHERE last_message_at::date = now()::date),
    'errors_24h',          (SELECT count(*) FROM error_logs
                              WHERE ts >= now() - interval '24 hours' AND level = 'error'),
    'pending_approvals',   (SELECT count(*) FROM ops_approvals WHERE status = 'pending'),
    'open_tasks',          (SELECT count(*) FROM ops_tasks
                              WHERE status IN ('proposed','awaiting_approval','approved','in_progress'))
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.ops_digest_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_digest_snapshot() TO service_role, ops_agent;

-- ---------------------------------------------------------------------------
-- 12. RPC ДЛЯ СКАНА ОШИБОК ДЕБИ (новые ошибки после курсора, сгруппированы)
-- ---------------------------------------------------------------------------
-- Возвращает группы ошибок уровня 'error' с ts строго > _since. Группировка по
-- fingerprint: одна и та же поломка не спамит N строками. Затрагиваемые салоны
-- считаются как distinct salon_id внутри группы.
CREATE OR REPLACE FUNCTION public.ops_recent_errors(_since timestamptz)
RETURNS TABLE(
  fingerprint    text,
  source         text,
  sample_message text,
  cnt            integer,
  affected_salons integer,
  last_ts        timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(e.fingerprint, e.source || ':' || left(e.message, 40)) AS fingerprint,
    max(e.source)                                    AS source,
    (array_agg(e.message ORDER BY e.ts DESC))[1]     AS sample_message,
    count(*)::int                                    AS cnt,
    count(DISTINCT e.salon_id)::int                  AS affected_salons,
    max(e.ts)                                         AS last_ts
  FROM error_logs e
  WHERE e.level = 'error'
    AND e.ts > _since
  GROUP BY 1
  ORDER BY max(e.ts) DESC
  LIMIT 20;
$$;
REVOKE ALL ON FUNCTION public.ops_recent_errors(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_recent_errors(timestamptz) TO service_role, ops_agent;

-- ---------------------------------------------------------------------------
-- 13. pg_cron: дайджест (раз в день) + скан ошибок (каждые 15 мин)
-- ---------------------------------------------------------------------------
-- Бьют в Worker qabyl.com с общим x-cron-secret (vault 'cron_secret'). Worker
-- сверяет его с env CRON_SECRET и сам решает — слать в Telegram или нет
-- (например, kill-switch включён). Пока код не задеплоен в прод — эндпоинт вернёт
-- 404/ok, вреда нет.
--
-- Дайджест: 02:00 UTC = 08:00 Бишкек (UTC+6).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ops-daily-digest') THEN
    PERFORM cron.unschedule('ops-daily-digest');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ops-sre-scan') THEN
    PERFORM cron.unschedule('ops-sre-scan');
  END IF;
END $$;

SELECT cron.schedule(
  'ops-daily-digest',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://qabyl.com/api/internal/cron/digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT public.internal_get_cron_secret())
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'ops-sre-scan',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://qabyl.com/api/internal/cron/sre-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT public.internal_get_cron_secret())
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) AS request_id;
  $$
);
