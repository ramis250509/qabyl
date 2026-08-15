-- Уровень 2 аудита: ограничение частоты на публичных путях.
--
-- Применять ПОСЛЕ 20260813120000 и 20260813130000.
--
-- После того как 20260813120000 закрыл прямой INSERT для anon, единственная
-- публичная дверь к календарю — RPC create_appointment. Она анонимна и никак не
-- ограничена по частоте: один скрипт способен за минуту забить салону весь
-- рабочий день фиктивными записями. Ограничение живёт в БД, а не в Worker'е,
-- потому что Cloudflare поднимает много изолированных инстансов и счётчик в
-- памяти одного из них не значит почти ничего.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Универсальный счётчик обращений
-- ═════════════════════════════════════════════════════════════════════════════
-- Одна строка на (ключ, окно). Ключ формирует вызывающая сторона: для записи это
-- телефон и салон, для проверки номера в WhatsApp — салон.
--
-- Намеренно НЕ храним IP: за NAT мобильного оператора в Бишкеке сидят тысячи
-- людей с одним адресом, и ограничение по IP отрезало бы реальных клиентов.
CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Таблица служебная: читать и писать её напрямую не должен никто, кроме функций
-- под SECURITY DEFINER.
ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_counters FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS rate_limit_counters_window_idx
  ON public.rate_limit_counters (window_start);

-- Инкремент с проверкой. Возвращает true, если обращение разрешено.
--
-- ON CONFLICT DO UPDATE делает счётчик атомарным: два параллельных запроса не
-- прочитают одно и то же значение и не пройдут оба. Именно так выглядит гонка,
-- ради которой лимит и ставят.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  _bucket text, _limit integer, _window interval
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _win timestamptz;
  _hits integer;
BEGIN
  -- Дискретное окно вместо скользящего: считаем от «начала текущего окна».
  -- Скользящее точнее, но требует хранить каждое обращение; для защиты от
  -- скрипта разницы нет, а данных на порядок меньше.
  _win := to_timestamp(floor(extract(epoch FROM now()) / extract(epoch FROM _window))
                       * extract(epoch FROM _window));

  INSERT INTO rate_limit_counters(bucket, window_start, hits)
  VALUES (_bucket, _win, 1)
  ON CONFLICT (bucket, window_start)
  DO UPDATE SET hits = rate_limit_counters.hits + 1
  RETURNING hits INTO _hits;

  RETURN _hits <= _limit;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(text, integer, interval) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rate_limit_hit(text, integer, interval) TO service_role;

-- Уборка. Без неё таблица растёт вечно, а старые окна не нужны уже через час.
CREATE OR REPLACE FUNCTION public.prune_rate_limit_counters()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  DELETE FROM rate_limit_counters WHERE window_start < now() - interval '1 day';
$function$;

SELECT cron.schedule(
  'prune-rate-limit-counters',
  '30 3 * * *',
  $$ SELECT public.prune_rate_limit_counters(); $$
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Ограничение на создание записей
-- ═════════════════════════════════════════════════════════════════════════════
-- Реализовано триггером, а не правкой create_appointment, по двум причинам:
-- функция и так переопределяется двумя миграциями подряд (лишний повод для
-- расхождения), и триггер закроет ЛЮБОЙ будущий путь вставки, а не только
-- сегодняшний RPC.
--
-- Пороги намеренно щедрые: задача — остановить скрипт, а не живого человека.
-- Клиент, который записался, передумал, отменил и записался заново три раза за
-- час, проходит свободно.
--
--   на телефон: 6 записей в час   — норма 1–2 за визит
--   на салон:  60 записей в час   — у салона с 10 мастерами это 6 записей на
--                                   мастера в час, недостижимо вручную
CREATE OR REPLACE FUNCTION public.guard_appointment_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _digits text;
BEGIN
  -- Ручная запись администратора и импорт — не публичные пути, их не трогаем.
  -- Владелец салона имеет право забить календарь как ему угодно.
  IF NEW.source NOT IN ('widget', 'ai_assistant') THEN
    RETURN NEW;
  END IF;

  _digits := regexp_replace(COALESCE(NEW.client_phone, ''), '[^0-9]', '', 'g');

  IF NOT public.rate_limit_hit(
       'appt:phone:' || NEW.salon_id::text || ':' || _digits, 6, interval '1 hour') THEN
    RAISE EXCEPTION 'Слишком много записей с этого номера за час. Позвоните в салон.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.rate_limit_hit(
       'appt:salon:' || NEW.salon_id::text, 60, interval '1 hour') THEN
    RAISE EXCEPTION 'Слишком много записей за короткое время. Попробуйте позже.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS appointments_rate_limit_trg ON public.appointments;
CREATE TRIGGER appointments_rate_limit_trg
  BEFORE INSERT ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.guard_appointment_rate_limit();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Ограничение на проверку номера в WhatsApp
-- ═════════════════════════════════════════════════════════════════════════════
-- checkPhoneWhatsapp публичен (виджет анонимен), и каждое непрокэшированное
-- обращение тратит один платный запрос из квоты Green-API салона. Лимит в
-- wa-check.functions.ts живёт в памяти инстанса Worker'а — на Cloudflare это
-- означает, что при десяти инстансах реальный порог в десять раз выше
-- заявленного. Эта функция даёт общий счётчик на всех.
CREATE OR REPLACE FUNCTION public.wa_check_rate_limit(_salon_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  -- 40 проверок за 5 минут на салон — тот же порог, что был в памяти, но теперь
  -- он действительно один на всех.
  SELECT public.rate_limit_hit('wacheck:' || _salon_id::text, 40, interval '5 minutes');
$function$;

REVOKE EXECUTE ON FUNCTION public.wa_check_rate_limit(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.wa_check_rate_limit(uuid) TO service_role;
