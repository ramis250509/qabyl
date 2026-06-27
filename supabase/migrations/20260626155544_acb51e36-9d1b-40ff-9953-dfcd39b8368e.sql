
-- 1. wa_conversations: lock + state machine
ALTER TABLE public.wa_conversations
  ADD COLUMN IF NOT EXISTS processing_lock_until timestamptz,
  ADD COLUMN IF NOT EXISTS processing_lock_id uuid,
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS state_data jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. wa_messages: processed marker
ALTER TABLE public.wa_messages
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

-- 3. appointments.source
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- 4. Update dispatch_whatsapp_confirmation to skip ai_assistant source
CREATE OR REPLACE FUNCTION public.dispatch_whatsapp_confirmation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
DECLARE
  fn_url TEXT := 'https://kcmxbzsjizhrierakvkj.supabase.co/functions/v1/send-whatsapp';
  secret TEXT;
  wa_on BOOLEAN;
BEGIN
  IF NEW.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;

  -- AI assistant already replied to the client in WhatsApp, do not double-send.
  IF NEW.source = 'ai_assistant' THEN
    RETURN NEW;
  END IF;

  SELECT whatsapp_enabled INTO wa_on
  FROM public.salons
  WHERE id = NEW.salon_id;

  IF NOT COALESCE(wa_on, false) THEN
    RETURN NEW;
  END IF;

  SELECT public.internal_get_cron_secret() INTO secret;

  IF secret IS NULL OR length(secret) = 0 THEN
    RAISE WARNING 'dispatch_whatsapp_confirmation skipped: cron secret is missing';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := fn_url,
    body := jsonb_build_object('appointment_id', NEW.id, 'kind', 'confirmation'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'dispatch_whatsapp_confirmation failed for appointment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- 5. Extend create_appointment with source + price_override (keeps old signature working via defaults)
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
  _price_override numeric DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _buffer int; _price numeric;
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

  SELECT duration_min, price, COALESCE(buffer_after_min,0), price_type, price_max
    INTO _duration, _price, _buffer, _price_type, _price_max
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

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

-- 6. Atomic lock acquisition helper (one SQL UPDATE; only succeeds if no live lock).
CREATE OR REPLACE FUNCTION public.wa_try_acquire_lock(
  _conversation_id uuid,
  _lock_id uuid,
  _ttl_seconds int DEFAULT 25
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _ok int;
BEGIN
  UPDATE public.wa_conversations
     SET processing_lock_id = _lock_id,
         processing_lock_until = now() + make_interval(secs => _ttl_seconds)
   WHERE id = _conversation_id
     AND (processing_lock_until IS NULL OR processing_lock_until < now());
  GET DIAGNOSTICS _ok = ROW_COUNT;
  RETURN _ok > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.wa_release_lock(
  _conversation_id uuid,
  _lock_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.wa_conversations
     SET processing_lock_id = NULL,
         processing_lock_until = NULL
   WHERE id = _conversation_id
     AND processing_lock_id = _lock_id;
END;
$$;
