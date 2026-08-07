-- ============================================================================
-- Make the prepayment hold a MODE of create_appointment instead of a copy of it.
-- ============================================================================
-- 20260801130000 introduced create_appointment_with_prepayment as a second,
-- hand-written booking function. It was already missing, relative to the real
-- create_appointment: the per-master advisory lock (so two prepayment holds can
-- race into the same slot), the master-break check, service add-ons, the price
-- override for range-priced services, the photo-assessed duration override, and
-- the `source` column. Every future fix to create_appointment would have had to
-- be remembered twice — which is exactly how the same migration ended up
-- reverting get_available_slots to a body that predated branch opening hours.
--
-- So: create_appointment gains one optional parameter, _hold_minutes.
--   * NULL (every existing caller — website widget, admin, WhatsApp, Instagram)
--     → byte-identical behaviour to before: status 'confirmed', no hold.
--   * a positive number → the row is written as 'pending_payment' with
--     hold_expires_at = now() + that many minutes.
-- and create_appointment_with_prepayment becomes a thin wrapper that computes
-- the amount, delegates, and records the prepayment.
--
-- The overlap check is widened to treat a live hold as busy — without that, two
-- clients could each hold the same slot. This is the create_appointment
-- counterpart of the same change already made in get_available_slots.
--
-- Idempotent.
-- ============================================================================

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
  _duration_override_min int DEFAULT NULL,
  _hold_minutes int DEFAULT NULL
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

  -- Hold mode. Bounded by the same 5..720 range prepayment_settings.hold_minutes
  -- enforces, so a caller cannot park a slot for a week.
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

  -- A live prepayment hold occupies the slot exactly like a confirmed booking does.
  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id
             AND status IN ('confirmed','pending_payment')
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

GRANT EXECUTE ON FUNCTION public.create_appointment(uuid,uuid,uuid,timestamptz,text,text,text,uuid,uuid[],text,numeric,int,int) TO anon, authenticated;

-- ── create_appointment_with_prepayment → thin wrapper ───────────────────────
-- Drop the standalone 8-argument version from 20260801130000; its body is now
-- redundant and would drift.
DROP FUNCTION IF EXISTS public.create_appointment_with_prepayment(uuid,uuid,uuid,timestamptz,text,text,text,uuid);

CREATE OR REPLACE FUNCTION public.create_appointment_with_prepayment(
  _salon_id     uuid,
  _master_id    uuid,
  _service_id   uuid,
  _starts_at    timestamptz,
  _client_name  text,
  _client_phone text,
  _client_notes text DEFAULT NULL,
  _branch_id    uuid DEFAULT NULL,
  _addon_ids    uuid[] DEFAULT '{}'::uuid[],
  _source       text DEFAULT 'ai_assistant',
  _price_override numeric DEFAULT NULL,
  _duration_override_min int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _cfg record;
  _amount numeric;
  _base numeric;
  _new_id uuid;
  _prepay_id uuid;
  _token uuid;
  _hold_until timestamptz;
BEGIN
  SELECT * INTO _cfg FROM prepayment_settings WHERE salon_id = _salon_id;
  IF _cfg.salon_id IS NULL OR NOT _cfg.enabled THEN
    RAISE EXCEPTION 'Prepayment is not enabled for this salon';
  END IF;

  -- Percent-based prepayment must be a percentage of what the client was actually
  -- quoted, not of the service's floor price. For a range-priced service the
  -- assistant negotiates a number and passes it as _price_override; using the
  -- floor here would undercharge every range service.
  _base := COALESCE(_price_override, (SELECT price FROM services WHERE id = _service_id AND salon_id = _salon_id));
  IF _base IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  IF _cfg.amount_type = 'fixed' THEN
    _amount := _cfg.amount_value;
  ELSE
    _amount := ROUND(_base * _cfg.amount_value / 100.0, 2);
  END IF;
  IF _cfg.min_amount IS NOT NULL AND _amount < _cfg.min_amount THEN _amount := _cfg.min_amount; END IF;
  IF _cfg.max_amount IS NOT NULL AND _amount > _cfg.max_amount THEN _amount := _cfg.max_amount; END IF;
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Prepayment amount misconfigured (got %)', _amount;
  END IF;

  -- All validation (advisory lock, slot overlap, breaks, branch, addons, price
  -- clamp, duration clamp) happens in there. Same transaction, so if anything
  -- below fails the booking is rolled back with it.
  _new_id := public.create_appointment(
    _salon_id, _master_id, _service_id, _starts_at, _client_name, _client_phone,
    _client_notes, _branch_id, _addon_ids, _source, _price_override,
    _duration_override_min, _cfg.hold_minutes
  );

  SELECT hold_expires_at, manage_token INTO _hold_until, _token
  FROM appointments WHERE id = _new_id;

  INSERT INTO appointment_prepayments(
    appointment_id, salon_id, expected_amount, currency, hold_expires_at
  ) VALUES (
    _new_id, _salon_id, _amount, _cfg.currency, _hold_until
  )
  RETURNING id INTO _prepay_id;

  INSERT INTO prepayment_audit(appointment_id, salon_id, actor_kind, action, detail)
  VALUES (_new_id, _salon_id, 'system', 'created',
          jsonb_build_object('amount', _amount, 'currency', _cfg.currency, 'hold_until', _hold_until));

  RETURN jsonb_build_object(
    'appointment_id', _new_id,
    'prepayment_id',  _prepay_id,
    'amount',         _amount,
    'currency',       _cfg.currency,
    'hold_expires_at',_hold_until,
    'manage_token',   _token
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_appointment_with_prepayment(uuid,uuid,uuid,timestamptz,text,text,text,uuid,uuid[],text,numeric,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_appointment_with_prepayment(uuid,uuid,uuid,timestamptz,text,text,text,uuid,uuid[],text,numeric,int) TO anon, authenticated;
