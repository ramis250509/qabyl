-- Буфер уборки должен действовать в обе стороны.
--
-- Найдено 2026-08-15 поведенческим тестом B3 на полигоне в Токио — то есть
-- багом, который жил в проде и которого не видел ни один из предыдущих аудитов.
--
-- Что было. Проверка пересечения сравнивала «блок новой записи» (её длительность
-- ПЛЮС её собственный буфер) с голым интервалом существующих записей
-- (starts_at..ends_at). Буфер существующей записи не учитывался нигде.
--
-- Отсюда асимметрия, зависящая от порядка бронирования:
--
--   окрашивание 12:00–13:00 (+30 мин уборки), затем маникюр на 13:15
--     → РАЗРЕШАЛОСЬ. Клиент садится в кресло, которое ещё убирают.
--   маникюр 13:15, затем окрашивание на 12:00
--     → отклонялось.
--
-- В жизни записи создаются по возрастанию времени, то есть срабатывал именно
-- первый случай: буфер не защищал ничего. Хуже того, get_available_slots сам
-- ПРЕДЛАГАЛ клиенту 13:15 — салон обещал время, которого у него нет.
--
-- Исправление одно и то же в трёх местах: конец занятости существующей записи
-- считается как ends_at + её собственный buffer_after_min.
--
-- LEFT JOIN, а не JOIN: услугу могли удалить, и запись с висящим service_id не
-- должна исчезать из проверки пересечений — это превратило бы дыру в графике в
-- дыру в защите.
--
-- Ограничение appointments_no_overlap намеренно НЕ трогаем: буфер — это правило
-- салона, а не целостность данных. Ограничение остаётся последним рубежом против
-- двойной записи на одно и то же время.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Выдача слотов
-- ═════════════════════════════════════════════════════════════════════════════
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
      IF _slot_start <= _earliest THEN _slot_start := _slot_start + _step; CONTINUE; END IF;
      -- ИЗМЕНЕНО: конец занятости существующей записи = ends_at + ЕЁ буфер.
      IF NOT EXISTS (
        SELECT 1 FROM appointments a
        LEFT JOIN services sv ON sv.id = a.service_id
        WHERE a.master_id = _master_id
          AND a.status IN ('confirmed','pending_payment')
          AND a.starts_at < _slot_block_end
          AND a.ends_at + (COALESCE(sv.buffer_after_min,0) || ' minutes')::interval > _slot_start)
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

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Создание записи
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_appointment(
  _salon_id uuid, _master_id uuid, _service_id uuid,
  _starts_at timestamp with time zone,
  _client_name text, _client_phone text,
  _client_notes text DEFAULT NULL::text,
  _branch_id uuid DEFAULT NULL::uuid,
  _addon_ids uuid[] DEFAULT '{}'::uuid[],
  _source text DEFAULT 'manual'::text,
  _price_override numeric DEFAULT NULL::numeric,
  _duration_override_min integer DEFAULT NULL::integer,
  _hold_minutes integer DEFAULT NULL::integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _duration_max int; _buffer int; _price numeric;
  _price_type text; _price_max numeric;
  _final_price numeric;
  _addon_price numeric := 0;
  _ends_at timestamptz; _block_end timestamptz; _new_id uuid; _mb uuid;
  _tz text; _date date; _row record; _bstart timestamptz; _bend timestamptz;
  _status appointment_status; _hold_until timestamptz;
BEGIN
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN RAISE EXCEPTION 'Invalid client name'; END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN RAISE EXCEPTION 'Invalid client phone'; END IF;
  IF _source NOT IN ('manual','widget','ai_assistant') THEN
    RAISE EXCEPTION 'Invalid source';
  END IF;

  IF _hold_minutes IS NOT NULL THEN
    IF _hold_minutes < 5 OR _hold_minutes > 720 THEN
      RAISE EXCEPTION 'Hold minutes out of range';
    END IF;
    _status := 'pending_payment';
    _hold_until := now() + (_hold_minutes || ' minutes')::interval;
  ELSE
    _status := 'confirmed';
    _hold_until := NULL;
  END IF;

  SELECT duration_min, duration_max_min, price, COALESCE(buffer_after_min,0), price_type, price_max
    INTO _duration, _duration_max, _price, _buffer, _price_type, _price_max
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  IF _duration_override_min IS NOT NULL AND _duration_max IS NOT NULL AND _duration_max > _duration THEN
    _duration := LEAST(GREATEST(_duration_override_min, _duration), _duration_max);
  END IF;

  SELECT branch_id INTO _mb FROM masters WHERE id = _master_id AND salon_id = _salon_id AND is_active = true;
  IF NOT EXISTS (SELECT 1 FROM masters m JOIN master_services ms ON ms.master_id = m.id
                 WHERE m.id = _master_id AND m.salon_id = _salon_id AND m.is_active = true AND ms.service_id = _service_id)
  THEN RAISE EXCEPTION 'Master cannot perform this service'; END IF;
  IF _branch_id IS NOT NULL AND _mb IS NOT NULL AND _mb <> _branch_id THEN
    RAISE EXCEPTION 'Master does not work at this branch';
  END IF;

  IF _addon_ids IS NOT NULL AND array_length(_addon_ids, 1) > 0 THEN
    SELECT COALESCE(SUM(price),0) INTO _addon_price
    FROM service_addons
    WHERE id = ANY(_addon_ids) AND salon_id = _salon_id AND is_active = true;
  END IF;

  IF _price_override IS NOT NULL THEN
    IF _price_type <> 'range' THEN
      RAISE EXCEPTION 'Price override allowed only for range-priced services';
    END IF;
    IF _price_max IS NULL OR _price_override < _price OR _price_override > _price_max THEN
      RAISE EXCEPTION 'Price override out of allowed range';
    END IF;
    _final_price := _price_override;
  ELSE
    _final_price := _price;
  END IF;

  _ends_at := _starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;

  IF _starts_at <= now() THEN RAISE EXCEPTION 'Cannot book in the past'; END IF;

  IF _source IN ('widget', 'ai_assistant') THEN
    PERFORM public.assert_master_available(_master_id, _service_id, _starts_at, _ends_at);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_master_id::text, 0));

  -- ИЗМЕНЕНО: учитываем буфер СУЩЕСТВУЮЩЕЙ записи, а не только своей.
  IF EXISTS (
    SELECT 1 FROM appointments a
    LEFT JOIN services sv ON sv.id = a.service_id
    WHERE a.master_id = _master_id
      AND a.status IN ('confirmed','pending_payment')
      AND a.starts_at < _block_end
      AND a.ends_at + (COALESCE(sv.buffer_after_min,0) || ' minutes')::interval > _starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  SELECT COALESCE(timezone,'UTC') INTO _tz FROM salons WHERE id = _salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  FOR _date IN
    SELECT d::date FROM generate_series(
      (_starts_at AT TIME ZONE _tz)::date,
      (_ends_at   AT TIME ZONE _tz)::date,
      interval '1 day'
    ) d
  LOOP
    FOR _row IN
      SELECT i AS interval_json
      FROM master_day_overrides o,
           LATERAL jsonb_array_elements(o.intervals) i
      WHERE o.master_id = _master_id
        AND o.date = _date
        AND o.kind = 'break'
        AND jsonb_typeof(o.intervals) = 'array'
    LOOP
      _bstart := ((_date::text || ' ' || (_row.interval_json->>'start'))::timestamp AT TIME ZONE _tz);
      _bend   := ((_date::text || ' ' || (_row.interval_json->>'end'))::timestamp AT TIME ZONE _tz);
      IF _starts_at < _bend AND _ends_at > _bstart THEN
        RAISE EXCEPTION 'У мастера установлен перерыв с % до %',
          to_char(_bstart AT TIME ZONE _tz, 'HH24:MI'),
          to_char(_bend   AT TIME ZONE _tz, 'HH24:MI');
      END IF;
    END LOOP;
  END LOOP;

  INSERT INTO appointments(salon_id, master_id, service_id, client_name, client_phone, client_notes, starts_at, ends_at, price, branch_id, source, status, hold_expires_at)
  VALUES (_salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes, _starts_at, _ends_at, _final_price + _addon_price, COALESCE(_branch_id, _mb), _source, _status, _hold_until)
  RETURNING id INTO _new_id;

  IF _addon_ids IS NOT NULL AND array_length(_addon_ids, 1) > 0 THEN
    INSERT INTO appointment_addons (appointment_id, addon_id, name_snapshot, price_snapshot, duration_snapshot)
    SELECT _new_id, a.id, a.name, a.price, a.duration_min
    FROM service_addons a
    WHERE a.id = ANY(_addon_ids) AND a.salon_id = _salon_id AND a.is_active = true;
  END IF;

  RETURN _new_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_appointment(uuid, uuid, uuid, timestamptz, text, text, text, uuid, uuid[], text, numeric, integer, integer)
  TO anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Перенос записи
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.reschedule_appointment_v2(
  _appointment_id uuid,
  _new_starts_at timestamp with time zone,
  _new_master_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _salon_id uuid; _master_id uuid; _service_id uuid; _status text;
  _duration int; _buffer int; _new_branch uuid;
  _ends_at timestamptz; _block_end timestamptz;
  _tz text; _date date; _row record; _bstart timestamptz; _bend timestamptz;
BEGIN
  SELECT salon_id, master_id, service_id, status
    INTO _salon_id, _master_id, _service_id, _status
  FROM appointments WHERE id = _appointment_id;
  IF _salon_id IS NULL THEN RAISE EXCEPTION 'Appointment not found'; END IF;
  IF _status <> 'confirmed' THEN RAISE EXCEPTION 'Only confirmed appointments can be rescheduled'; END IF;
  IF _new_starts_at <= now() THEN RAISE EXCEPTION 'Cannot reschedule to the past'; END IF;

  IF _new_master_id IS NOT NULL AND _new_master_id <> _master_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM masters
      WHERE id = _new_master_id AND salon_id = _salon_id AND is_active = true
    ) THEN RAISE EXCEPTION 'Master not found'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM master_services
      WHERE master_id = _new_master_id AND service_id = _service_id
    ) THEN RAISE EXCEPTION 'Master does not offer this service'; END IF;
    _master_id := _new_master_id;
  END IF;

  SELECT branch_id INTO _new_branch FROM masters WHERE id = _master_id;

  SELECT duration_min, COALESCE(buffer_after_min,0) INTO _duration, _buffer
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  _ends_at := _new_starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;

  PERFORM pg_advisory_xact_lock(hashtextextended(_master_id::text, 0));

  -- ИЗМЕНЕНО: буфер существующей записи, как и в create_appointment.
  IF EXISTS (
    SELECT 1 FROM appointments a
    LEFT JOIN services sv ON sv.id = a.service_id
    WHERE a.master_id = _master_id
      AND a.status IN ('confirmed', 'pending_payment')
      AND a.id <> _appointment_id
      AND a.starts_at < _block_end
      AND a.ends_at + (COALESCE(sv.buffer_after_min,0) || ' minutes')::interval > _new_starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  SELECT COALESCE(timezone,'UTC') INTO _tz FROM salons WHERE id = _salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  FOR _date IN
    SELECT d::date FROM generate_series(
      (_new_starts_at AT TIME ZONE _tz)::date,
      (_ends_at       AT TIME ZONE _tz)::date,
      interval '1 day'
    ) d
  LOOP
    FOR _row IN
      SELECT i AS interval_json
      FROM master_day_overrides o,
           LATERAL jsonb_array_elements(o.intervals) i
      WHERE o.master_id = _master_id
        AND o.date = _date
        AND o.kind = 'break'
        AND jsonb_typeof(o.intervals) = 'array'
    LOOP
      _bstart := ((_date::text || ' ' || (_row.interval_json->>'start'))::timestamp AT TIME ZONE _tz);
      _bend   := ((_date::text || ' ' || (_row.interval_json->>'end'))::timestamp AT TIME ZONE _tz);
      IF _new_starts_at < _bend AND _ends_at > _bstart THEN
        RAISE EXCEPTION 'У мастера установлен перерыв с % до %',
          to_char(_bstart AT TIME ZONE _tz, 'HH24:MI'),
          to_char(_bend   AT TIME ZONE _tz, 'HH24:MI');
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (SELECT 1 FROM master_time_off
             WHERE master_id = _master_id
               AND starts_at < _block_end AND ends_at > _new_starts_at)
  THEN RAISE EXCEPTION 'Мастер не работает в это время'; END IF;

  UPDATE appointments
  SET starts_at = _new_starts_at, ends_at = _ends_at,
      master_id = _master_id, branch_id = COALESCE(_new_branch, branch_id)
  WHERE id = _appointment_id;

  RETURN _appointment_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reschedule_appointment_v2(uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reschedule_appointment_v2(uuid, timestamptz, uuid) TO service_role;
