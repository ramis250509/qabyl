-- Уровень 1 аудита 2026-08-13: упреждение записи, аудит-лог, статус доставки.
--
-- Применять ПОСЛЕ 20260813120000_booking_integrity_fixes.sql — здесь
-- переопределяется assert_master_available, созданная той миграцией.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Минимальное упреждение записи
-- ═════════════════════════════════════════════════════════════════════════════
-- Раньше единственным ограничением было «не в прошлое»: клиент мог занять слот
-- за минуту до визита, когда мастер уже физически не успевает его принять.
--
-- Живёт рядом с manage_cutoff_hours (за сколько часов клиент может сам отменить)
-- — это парная настройка того же смысла, и UI для неё уже на том же экране.
-- 0 = выключено, поведение остаётся прежним.
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS min_lead_minutes integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.salon_ai_assistant.min_lead_minutes IS
  'За сколько минут до визита закрывается онлайн-запись. 0 = без ограничения. Не действует на ручную запись администратора (source=manual).';

ALTER TABLE public.salon_ai_assistant
  DROP CONSTRAINT IF EXISTS salon_ai_assistant_min_lead_minutes_check;
ALTER TABLE public.salon_ai_assistant
  ADD CONSTRAINT salon_ai_assistant_min_lead_minutes_check
  CHECK (min_lead_minutes >= 0 AND min_lead_minutes <= 1440);

-- Слоты, до которых осталось меньше упреждения, не показываются вовсе.
-- Правило обязано действовать в обоих местах: спрятать слот, но разрешить его
-- занять прямым вызовом RPC — это ровно тот класс расхождений, который аудит и
-- нашёл (список слотов честный, запись не проверяет ничего).
CREATE OR REPLACE FUNCTION public.get_available_slots(_master_id uuid, _service_id uuid, _date date)
 RETURNS TABLE(slot_start timestamp with time zone, slot_end timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _buffer int; _tz text; _wd smallint;
  _branch_id uuid; _branch_hours jsonb; _branch_intervals jsonb;
  _override record; _override_intervals jsonb;
  _master_intervals jsonb;
  _break_intervals jsonb;
  _slot_start timestamptz; _slot_end timestamptz; _slot_block_end timestamptz;
  _step interval := interval '15 minutes';
  _eff_start time; _eff_end time;
  _row record;
  _salon_id uuid; _lead int; _earliest timestamptz;
BEGIN
  SELECT duration_min, COALESCE(buffer_after_min,0) INTO _duration, _buffer
  FROM services WHERE id = _service_id AND is_active = true;
  IF _duration IS NULL THEN RETURN; END IF;

  SELECT s.timezone, m.branch_id, m.salon_id INTO _tz, _branch_id, _salon_id
  FROM masters m JOIN salons s ON s.id = m.salon_id WHERE m.id = _master_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;

  -- ДОБАВЛЕНО: порог «не раньше чем через N минут». LEFT JOIN по смыслу —
  -- у салона может не быть строки salon_ai_assistant вовсе.
  SELECT COALESCE(min_lead_minutes, 0) INTO _lead
  FROM salon_ai_assistant WHERE salon_id = _salon_id;
  _earliest := now() + (COALESCE(_lead, 0) || ' minutes')::interval;

  _wd := EXTRACT(DOW FROM _date)::smallint;

  IF _branch_id IS NOT NULL THEN
    SELECT working_hours INTO _branch_hours FROM branches WHERE id = _branch_id;
    IF _branch_hours IS NOT NULL AND jsonb_typeof(_branch_hours) = 'object' THEN
      _branch_intervals := _branch_hours -> _wd::text;
      IF _branch_intervals IS NOT NULL AND jsonb_typeof(_branch_intervals) = 'array'
         AND jsonb_array_length(_branch_intervals) = 0 THEN RETURN; END IF;
    END IF;
  END IF;

  SELECT * INTO _override FROM master_day_overrides
  WHERE master_id = _master_id AND date = _date;

  IF FOUND AND (_override.is_off OR _override.kind = 'off') THEN RETURN; END IF;

  IF FOUND AND _override.kind = 'workday'
     AND _override.intervals IS NOT NULL AND jsonb_typeof(_override.intervals) = 'array'
     AND jsonb_array_length(_override.intervals) > 0 THEN
    _override_intervals := _override.intervals;
  END IF;

  IF FOUND AND _override.kind = 'break'
     AND _override.intervals IS NOT NULL AND jsonb_typeof(_override.intervals) = 'array' THEN
    _break_intervals := _override.intervals;
  END IF;

  IF _override_intervals IS NOT NULL THEN
    _master_intervals := _override_intervals;
  ELSE
    SELECT jsonb_agg(jsonb_build_object('start', start_time::text, 'end', end_time::text))
    INTO _master_intervals
    FROM master_schedules WHERE master_id = _master_id AND weekday = _wd;
  END IF;

  IF _master_intervals IS NULL OR jsonb_array_length(_master_intervals) = 0 THEN RETURN; END IF;

  FOR _row IN
    SELECT
      GREATEST((mi->>'start')::time,
        CASE WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
             THEN (mi->>'start')::time ELSE (bi->>'start')::time END) AS s,
      LEAST((mi->>'end')::time,
        CASE WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
             THEN (mi->>'end')::time ELSE (bi->>'end')::time END) AS e
    FROM jsonb_array_elements(_master_intervals) mi
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
           THEN jsonb_build_array(mi) ELSE _branch_intervals END
    ) bi ON true
  LOOP
    _eff_start := _row.s; _eff_end := _row.e;
    IF _eff_start >= _eff_end THEN CONTINUE; END IF;
    _slot_start := ((_date::text || ' ' || _eff_start::text)::timestamp AT TIME ZONE _tz);
    LOOP
      _slot_end := _slot_start + (_duration || ' minutes')::interval;
      _slot_block_end := _slot_end + (_buffer || ' minutes')::interval;
      EXIT WHEN _slot_end > ((_date::text || ' ' || _eff_end::text)::timestamp AT TIME ZONE _tz);
      -- ИЗМЕНЕНО: было `_slot_start <= now()`.
      IF _slot_start <= _earliest THEN _slot_start := _slot_start + _step; CONTINUE; END IF;
      IF NOT EXISTS (SELECT 1 FROM appointments a WHERE a.master_id = _master_id AND a.status IN ('confirmed','pending_payment') AND a.starts_at < _slot_block_end AND a.ends_at > _slot_start)
      AND NOT EXISTS (SELECT 1 FROM master_time_off t WHERE t.master_id = _master_id AND t.starts_at < _slot_block_end AND t.ends_at > _slot_start)
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(_break_intervals,'[]'::jsonb)) bi
        WHERE ((_date::text || ' ' || (bi->>'start'))::timestamp AT TIME ZONE _tz) < _slot_block_end
          AND ((_date::text || ' ' || (bi->>'end'))::timestamp AT TIME ZONE _tz) > _slot_start
      )
      THEN slot_start := _slot_start; slot_end := _slot_end; RETURN NEXT; END IF;
      _slot_start := _slot_start + _step;
    END LOOP;
  END LOOP;
END;
$function$;

-- Тот же порог на стороне записи. Живёт в assert_master_available, чтобы
-- create_appointment не пришлось переопределять второй раз: вызов уже вшит в неё
-- миграцией 20260813120000 и срабатывает только для widget/ai_assistant.
CREATE OR REPLACE FUNCTION public.assert_master_available(
  _master_id uuid, _service_id uuid, _starts_at timestamptz, _ends_at timestamptz
) RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _tz text; _date date; _has_schedule boolean; _salon_id uuid; _lead int;
BEGIN
  SELECT COALESCE(s.timezone,'UTC'), m.salon_id INTO _tz, _salon_id
  FROM masters m JOIN salons s ON s.id = m.salon_id WHERE m.id = _master_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  _date := (_starts_at AT TIME ZONE _tz)::date;

  SELECT COALESCE(min_lead_minutes, 0) INTO _lead
  FROM salon_ai_assistant WHERE salon_id = _salon_id;
  IF COALESCE(_lead, 0) > 0 AND _starts_at <= now() + (_lead || ' minutes')::interval THEN
    RAISE EXCEPTION 'Онлайн-запись закрывается за % мин до визита. Позвоните в салон.', _lead;
  END IF;

  IF EXISTS (SELECT 1 FROM master_time_off
             WHERE master_id = _master_id
               AND starts_at < _ends_at AND ends_at > _starts_at) THEN
    RAISE EXCEPTION 'Мастер не работает в это время (отпуск)';
  END IF;

  IF EXISTS (SELECT 1 FROM master_day_overrides
             WHERE master_id = _master_id AND date = _date
               AND (is_off OR kind = 'off')) THEN
    RAISE EXCEPTION 'У мастера выходной в этот день';
  END IF;

  SELECT EXISTS (SELECT 1 FROM master_schedules WHERE master_id = _master_id)
      OR EXISTS (SELECT 1 FROM master_day_overrides
                 WHERE master_id = _master_id AND date = _date AND kind = 'workday')
    INTO _has_schedule;
  IF NOT _has_schedule THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.get_available_slots(_master_id, _service_id, _date) g
    WHERE g.slot_start = _starts_at
  ) THEN
    RAISE EXCEPTION 'Это время вне рабочего графика мастера';
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.assert_master_available(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Аудит-лог изменений записей
-- ═════════════════════════════════════════════════════════════════════════════
-- Сейчас на вопрос «кто перенёс эту запись и когда» ответа нет вообще. Для
-- предоплаты такой журнал есть (prepayment_audit), для самих записей — не было.
--
-- FK на appointment_id намеренно НЕТ: главная ценность журнала — пережить
-- удаление записи и сохранить, кто её удалил.
CREATE TABLE IF NOT EXISTS public.appointment_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL,
  salon_id       uuid NOT NULL,
  -- NULL, когда изменение сделал сервер (ИИ-ассистент, крон, edge-функция):
  -- под service_role auth.uid() не существует.
  actor_id       uuid,
  actor_kind     text NOT NULL CHECK (actor_kind IN ('user','system')),
  action         text NOT NULL CHECK (action IN ('created','status_changed','rescheduled','master_changed','contact_changed','deleted')),
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_audit_appointment_idx
  ON public.appointment_audit (appointment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS appointment_audit_salon_idx
  ON public.appointment_audit (salon_id, created_at DESC);

ALTER TABLE public.appointment_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Salon admin reads appointment audit" ON public.appointment_audit;
CREATE POLICY "Salon admin reads appointment audit" ON public.appointment_audit
  FOR SELECT TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id)
         OR salon_id = public.user_manager_salon_id(auth.uid()));

-- Пишет только триггер под SECURITY DEFINER. Журнал, который можно
-- отредактировать, журналом не является.
REVOKE INSERT, UPDATE, DELETE ON public.appointment_audit FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_appointment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _actor uuid := auth.uid();
  _kind  text := CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'user' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO appointment_audit(appointment_id, salon_id, actor_id, actor_kind, action, detail)
    VALUES (NEW.id, NEW.salon_id, _actor, _kind, 'created',
      jsonb_build_object('source', NEW.source, 'status', NEW.status,
                         'starts_at', NEW.starts_at, 'master_id', NEW.master_id,
                         'price', NEW.price));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO appointment_audit(appointment_id, salon_id, actor_id, actor_kind, action, detail)
    VALUES (OLD.id, OLD.salon_id, _actor, _kind, 'deleted',
      jsonb_build_object('client_name', OLD.client_name, 'starts_at', OLD.starts_at,
                         'master_id', OLD.master_id, 'status', OLD.status));
    RETURN OLD;
  END IF;

  -- UPDATE: по одной записи на каждое СМЫСЛОВОЕ изменение, а не одна свалка на
  -- строку. Иначе «перенесли и отменили» неотличимо от «отменили».
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO appointment_audit(appointment_id, salon_id, actor_id, actor_kind, action, detail)
    VALUES (NEW.id, NEW.salon_id, _actor, _kind, 'status_changed',
      jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;

  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    INSERT INTO appointment_audit(appointment_id, salon_id, actor_id, actor_kind, action, detail)
    VALUES (NEW.id, NEW.salon_id, _actor, _kind, 'rescheduled',
      jsonb_build_object('from', OLD.starts_at, 'to', NEW.starts_at));
  END IF;

  IF NEW.master_id IS DISTINCT FROM OLD.master_id THEN
    INSERT INTO appointment_audit(appointment_id, salon_id, actor_id, actor_kind, action, detail)
    VALUES (NEW.id, NEW.salon_id, _actor, _kind, 'master_changed',
      jsonb_build_object('from', OLD.master_id, 'to', NEW.master_id));
  END IF;

  IF NEW.client_phone IS DISTINCT FROM OLD.client_phone
     OR NEW.client_name IS DISTINCT FROM OLD.client_name THEN
    INSERT INTO appointment_audit(appointment_id, salon_id, actor_id, actor_kind, action, detail)
    VALUES (NEW.id, NEW.salon_id, _actor, _kind, 'contact_changed',
      jsonb_build_object('name_from', OLD.client_name, 'name_to', NEW.client_name,
                         'phone_changed', NEW.client_phone IS DISTINCT FROM OLD.client_phone));
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS appointments_audit_trg ON public.appointments;
CREATE TRIGGER appointments_audit_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.log_appointment_change();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Статус доставки подтверждения
-- ═════════════════════════════════════════════════════════════════════════════
-- Замена невозможной проверки номера. checkWhatsapp есть только у Green-API, а
-- основной салон уже на Cloud API — то есть «проверить номер до записи» больше
-- не работает в принципе.
--
-- Правильный ответ: не блокировать запись, а честно показывать владельцу, что
-- клиент подтверждение не получил. Провайдер сам сообщает статус доставки, и
-- 'noAccount' от Green-API — это ровно «номера нет в WhatsApp», причём факт, а
-- не догадка до отправки.
--
-- Значения:
--   pending   — отправка ещё не пыталась выполниться
--   skipped   — WhatsApp выключен у салона, или source=ai_assistant/import
--   sent      — провайдер принял сообщение (НЕ означает «клиент прочитал»)
--   delivered — провайдер подтвердил доставку на устройство
--   failed    — провайдер отказал; в confirmation_detail лежит причина
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS confirmation_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS confirmation_detail text,
  ADD COLUMN IF NOT EXISTS confirmation_at timestamptz,
  -- id сообщения у провайдера: по нему вебхук статуса находит запись.
  ADD COLUMN IF NOT EXISTS confirmation_message_id text;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_confirmation_status_check;
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_confirmation_status_check
  CHECK (confirmation_status IN ('pending','skipped','sent','delivered','failed'));

CREATE INDEX IF NOT EXISTS appointments_confirmation_message_idx
  ON public.appointments (confirmation_message_id)
  WHERE confirmation_message_id IS NOT NULL;

-- Существующие записи не размечаем задним числом: у нас нет данных о том, что
-- по ним произошло, а 'pending' на прошлом визите — это ложная тревога в
-- календаре. Всё, что было до миграции, считаем пропущенным.
UPDATE public.appointments SET confirmation_status = 'skipped'
WHERE confirmation_status = 'pending';
