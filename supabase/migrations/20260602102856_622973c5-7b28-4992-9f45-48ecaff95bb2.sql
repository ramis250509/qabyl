ALTER TABLE public.services ADD COLUMN IF NOT EXISTS buffer_after_min integer NOT NULL DEFAULT 0;
ALTER TABLE public.salons ADD COLUMN IF NOT EXISTS custom_html text;

CREATE OR REPLACE FUNCTION public.get_available_slots(_master_id uuid, _service_id uuid, _date date)
 RETURNS TABLE(slot_start timestamp with time zone, slot_end timestamp with time zone)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _buffer int; _tz text; _wd smallint; _sched record;
  _slot_start timestamptz; _slot_end timestamptz; _slot_block_end timestamptz;
  _step interval := interval '15 minutes';
BEGIN
  SELECT duration_min, COALESCE(buffer_after_min,0) INTO _duration, _buffer FROM services WHERE id = _service_id AND is_active = true;
  IF _duration IS NULL THEN RETURN; END IF;
  SELECT s.timezone INTO _tz FROM masters m JOIN salons s ON s.id = m.salon_id WHERE m.id = _master_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  _wd := EXTRACT(DOW FROM _date)::smallint;
  FOR _sched IN SELECT start_time, end_time FROM master_schedules WHERE master_id = _master_id AND weekday = _wd ORDER BY start_time LOOP
    _slot_start := ((_date::text || ' ' || _sched.start_time::text)::timestamp AT TIME ZONE _tz);
    LOOP
      _slot_end := _slot_start + (_duration || ' minutes')::interval;
      _slot_block_end := _slot_end + (_buffer || ' minutes')::interval;
      EXIT WHEN _slot_end > ((_date::text || ' ' || _sched.end_time::text)::timestamp AT TIME ZONE _tz);
      IF _slot_start <= now() THEN _slot_start := _slot_start + _step; CONTINUE; END IF;
      IF NOT EXISTS (SELECT 1 FROM appointments a WHERE a.master_id = _master_id AND a.status = 'confirmed' AND a.starts_at < _slot_block_end AND a.ends_at > _slot_start)
      AND NOT EXISTS (SELECT 1 FROM master_time_off t WHERE t.master_id = _master_id AND t.starts_at < _slot_block_end AND t.ends_at > _slot_start)
      THEN slot_start := _slot_start; slot_end := _slot_end; RETURN NEXT; END IF;
      _slot_start := _slot_start + _step;
    END LOOP;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_appointment(_salon_id uuid, _master_id uuid, _service_id uuid, _starts_at timestamp with time zone, _client_name text, _client_phone text, _client_notes text DEFAULT NULL::text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _duration int; _buffer int; _price numeric; _ends_at timestamptz; _block_end timestamptz; _new_id uuid;
BEGIN
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN RAISE EXCEPTION 'Invalid client name'; END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN RAISE EXCEPTION 'Invalid client phone'; END IF;
  SELECT duration_min, price, COALESCE(buffer_after_min,0) INTO _duration, _price, _buffer FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM masters m JOIN master_services ms ON ms.master_id = m.id WHERE m.id = _master_id AND m.salon_id = _salon_id AND m.is_active = true AND ms.service_id = _service_id)
  THEN RAISE EXCEPTION 'Master cannot perform this service'; END IF;
  _ends_at := _starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;
  IF _starts_at <= now() THEN RAISE EXCEPTION 'Cannot book in the past'; END IF;
  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id AND status = 'confirmed' AND starts_at < _block_end AND ends_at > _starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;
  INSERT INTO appointments(salon_id, master_id, service_id, client_name, client_phone, client_notes, starts_at, ends_at, price)
  VALUES (_salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes, _starts_at, _ends_at, _price)
  RETURNING id INTO _new_id;
  RETURN _new_id;
END;
$function$;

DROP FUNCTION IF EXISTS public.get_salon_by_host(text);
CREATE FUNCTION public.get_salon_by_host(_host text)
 RETURNS TABLE(id uuid, slug text, name text, custom_domain text, description text, address text, phone text, timezone text, brand_primary text, brand_accent text, logo_url text, site_template text, site_enabled boolean, hero_title text, hero_subtitle text, hero_image_url text, about_text text, gallery_images text[], instagram_url text, tiktok_url text, whatsapp_url text, telegram_url text, lat numeric, lng numeric, working_hours jsonb, custom_html text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT id, slug, name, custom_domain, description, address, phone, timezone,
         brand_primary, brand_accent, logo_url, site_template, site_enabled,
         hero_title, hero_subtitle, hero_image_url, about_text, gallery_images,
         instagram_url, tiktok_url, whatsapp_url, telegram_url, lat, lng, working_hours, custom_html
  FROM salons WHERE is_active = true AND (custom_domain = _host OR custom_domain = lower(_host)) LIMIT 1;
$function$;