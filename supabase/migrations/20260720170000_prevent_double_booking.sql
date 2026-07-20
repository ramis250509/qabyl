-- Harden bookings against a concurrency race that could double-book one master/slot.
--
-- The bug: create_appointment and reschedule_appointment_v2 use a "check then write" pattern —
-- they run `IF EXISTS (overlapping confirmed appt) THEN reject` and then INSERT/UPDATE. Under the
-- default READ COMMITTED isolation two concurrent bookings for the SAME master + overlapping time
-- can each pass the EXISTS check (neither sees the other's uncommitted row) and both commit, i.e.
-- a double-booking. The WA agent's per-conversation advisory lock does NOT cover this: two
-- different clients, or a website booking racing a WhatsApp booking, are not serialized.
--
-- Two layers of defence, both backward compatible:
--   1) A per-MASTER transaction advisory lock at the top of each booking function's critical
--      section. Concurrent bookings for the same master now serialize: the second waits, then sees
--      the first's committed row and correctly returns "Time slot is no longer available". Bookings
--      for DIFFERENT masters never block each other, so throughput is unaffected. Since every insert
--      path funnels through create_appointment (there is no direct anon INSERT policy) and every
--      move through reschedule_appointment_v2, this fully closes the race in practice.
--   2) A partial EXCLUDE constraint as a hard invariant the database enforces regardless of write
--      path (future RPCs, manual SQL edits, data imports). It only considers status='confirmed'
--      rows and uses [starts_at, ends_at) ranges, so back-to-back bookings (end == next start) are
--      allowed. If historical data already contains overlaps the constraint is skipped with a
--      WARNING (layer 1 still protects going forward) — the migration never hard-fails.

-- ---- Layer 1a: create_appointment with a per-master advisory lock ----
CREATE OR REPLACE FUNCTION public.create_appointment(
  _salon_id uuid,
  _master_id uuid,
  _service_id uuid,
  _starts_at timestamp with time zone,
  _client_name text,
  _client_phone text,
  _client_notes text DEFAULT NULL::text,
  _branch_id uuid DEFAULT NULL::uuid,
  _addon_ids uuid[] DEFAULT '{}'::uuid[],
  _source text DEFAULT 'manual',
  _price_override numeric DEFAULT NULL,
  _duration_override_min int DEFAULT NULL
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
BEGIN
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN RAISE EXCEPTION 'Invalid client name'; END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN RAISE EXCEPTION 'Invalid client phone'; END IF;
  IF _source NOT IN ('manual','widget','ai_assistant') THEN
    RAISE EXCEPTION 'Invalid source';
  END IF;

  SELECT duration_min, duration_max_min, price, COALESCE(buffer_after_min,0), price_type, price_max
    INTO _duration, _duration_max, _price, _buffer, _price_type, _price_max
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  -- Duration override: honoured only for a range-duration service and clamped to
  -- [duration_min, duration_max_min]. The Assistant passes what it judged from the client photo;
  -- the website never sends it, so site bookings keep the standard duration_min.
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
    SELECT COALESCE(SUM(price),0)
      INTO _addon_price
    FROM service_addons
    WHERE id = ANY(_addon_ids) AND salon_id = _salon_id AND is_active = true;
  END IF;

  -- price_override only honored for range services and within [price, price_max]
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

  -- Serialize concurrent bookings for THIS master so the overlap check + insert below are atomic
  -- (transaction-scoped lock, auto-released at commit). Different masters don't contend.
  PERFORM pg_advisory_xact_lock(hashtextextended(_master_id::text, 0));

  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id AND status = 'confirmed'
             AND starts_at < _block_end AND ends_at > _starts_at)
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

  INSERT INTO appointments(salon_id, master_id, service_id, client_name, client_phone, client_notes, starts_at, ends_at, price, branch_id, source)
  VALUES (_salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes, _starts_at, _ends_at, _final_price + _addon_price, COALESCE(_branch_id, _mb), _source)
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

-- ---- Layer 1b: reschedule_appointment_v2 with the same per-master advisory lock ----
CREATE OR REPLACE FUNCTION public.reschedule_appointment_v2(
  _appointment_id uuid,
  _new_starts_at timestamp with time zone,
  _new_master_id uuid DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _salon_id uuid; _master_id uuid; _service_id uuid; _status text;
  _duration int; _buffer int;
  _ends_at timestamptz; _block_end timestamptz;
  _tz text; _date date; _row record; _bstart timestamptz; _bend timestamptz;
BEGIN
  SELECT salon_id, master_id, service_id, status
    INTO _salon_id, _master_id, _service_id, _status
  FROM appointments WHERE id = _appointment_id;
  IF _salon_id IS NULL THEN RAISE EXCEPTION 'Appointment not found'; END IF;
  IF _status <> 'confirmed' THEN RAISE EXCEPTION 'Only confirmed appointments can be rescheduled'; END IF;
  IF _new_starts_at <= now() THEN RAISE EXCEPTION 'Cannot reschedule to the past'; END IF;

  -- Target master: the new one when given (must belong to the same salon and be active).
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

  SELECT duration_min, COALESCE(buffer_after_min,0) INTO _duration, _buffer
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  _ends_at := _new_starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;

  -- Lock the TARGET master (after any master change) so the overlap check + update are atomic.
  PERFORM pg_advisory_xact_lock(hashtextextended(_master_id::text, 0));

  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id AND status = 'confirmed'
             AND id <> _appointment_id
             AND starts_at < _block_end AND ends_at > _new_starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  SELECT COALESCE(timezone,'UTC') INTO _tz FROM salons WHERE id = _salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  FOR _date IN
    SELECT d::date FROM generate_series(
      (_new_starts_at AT TIME ZONE _tz)::date,
      (_ends_at        AT TIME ZONE _tz)::date,
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

  UPDATE appointments
  SET starts_at = _new_starts_at, ends_at = _ends_at, master_id = _master_id
  WHERE id = _appointment_id;

  RETURN _appointment_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.reschedule_appointment_v2(uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_appointment_v2(uuid, timestamptz, uuid) TO service_role;

-- ---- Layer 2: hard EXCLUDE constraint (database-enforced, any write path) ----
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap') THEN
    BEGIN
      ALTER TABLE public.appointments
        ADD CONSTRAINT appointments_no_overlap
        EXCLUDE USING gist (
          master_id WITH =,
          tstzrange(starts_at, ends_at) WITH &&
        ) WHERE (status = 'confirmed');
      RAISE NOTICE 'appointments_no_overlap: жёсткая защита от пересечений включена.';
    EXCEPTION WHEN exclusion_violation OR unique_violation THEN
      RAISE WARNING 'appointments_no_overlap НЕ добавлена: в базе уже есть пересекающиеся подтверждённые записи. Advisory-lock уже защищает от новых двойных записей. Почистите пересечения и примените миграцию повторно, чтобы включить жёсткую гарантию на уровне БД.';
    END;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
