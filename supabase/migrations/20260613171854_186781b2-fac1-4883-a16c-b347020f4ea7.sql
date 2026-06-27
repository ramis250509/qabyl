
-- =========================================
-- 1) service_addons
-- =========================================
CREATE TABLE public.service_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  name text NOT NULL,
  duration_min int NOT NULL DEFAULT 0 CHECK (duration_min >= 0),
  price numeric NOT NULL DEFAULT 0 CHECK (price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.service_addons TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_addons TO authenticated;
GRANT ALL ON public.service_addons TO service_role;

ALTER TABLE public.service_addons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_addons public read active"
  ON public.service_addons FOR SELECT
  USING (is_active = true);

CREATE POLICY "service_addons admin manage"
  ON public.service_addons FOR ALL
  USING (public.has_salon_access(auth.uid(), salon_id))
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

CREATE TRIGGER service_addons_touch_updated_at
  BEFORE UPDATE ON public.service_addons
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX idx_service_addons_salon ON public.service_addons(salon_id) WHERE is_active = true;

-- =========================================
-- 2) appointment_addons
-- =========================================
CREATE TABLE public.appointment_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  addon_id uuid REFERENCES public.service_addons(id) ON DELETE SET NULL,
  name_snapshot text NOT NULL,
  price_snapshot numeric NOT NULL DEFAULT 0,
  duration_snapshot int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointment_addons TO authenticated;
GRANT ALL ON public.appointment_addons TO service_role;

ALTER TABLE public.appointment_addons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "appointment_addons salon read"
  ON public.appointment_addons FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.id = appointment_id
      AND public.has_salon_access(auth.uid(), a.salon_id)
  ));

CREATE POLICY "appointment_addons salon manage"
  ON public.appointment_addons FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.id = appointment_id
      AND public.has_salon_access(auth.uid(), a.salon_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.id = appointment_id
      AND public.has_salon_access(auth.uid(), a.salon_id)
  ));

CREATE INDEX idx_appointment_addons_appt ON public.appointment_addons(appointment_id);

-- =========================================
-- 3) notifications.branch_id
-- =========================================
ALTER TABLE public.notifications
  ADD COLUMN branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX idx_notifications_branch ON public.notifications(branch_id);

-- Update trigger to include branch_id
CREATE OR REPLACE FUNCTION public.notify_appointment_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _service_name text; _tz text;
BEGIN
  SELECT COALESCE(timezone, 'UTC') INTO _tz FROM salons WHERE id = NEW.salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT name INTO _service_name FROM services WHERE id = NEW.service_id;
    INSERT INTO public.notifications (salon_id, branch_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.branch_id, NEW.id, 'appointment.created',
      'Новая запись от клиента',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI')
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    INSERT INTO public.notifications (salon_id, branch_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.branch_id, NEW.id, 'appointment.cancelled',
      'Клиент отменил запись',
      COALESCE(NEW.client_name,'Клиент') || ' отменил(а) запись'
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- =========================================
-- 4) get_addons_for_service
-- =========================================
CREATE OR REPLACE FUNCTION public.get_addons_for_service(_service_id uuid)
 RETURNS TABLE(id uuid, name text, duration_min int, price numeric)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  SELECT a.id, a.name, a.duration_min, a.price
  FROM public.service_addons a
  JOIN public.services s ON s.salon_id = a.salon_id
  WHERE s.id = _service_id AND a.is_active = true AND s.is_active = true
  ORDER BY a.price ASC, a.name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_addons_for_service(uuid) TO anon, authenticated;

-- =========================================
-- 5) create_appointment with _addon_ids
-- =========================================
CREATE OR REPLACE FUNCTION public.create_appointment(
  _salon_id uuid,
  _master_id uuid,
  _service_id uuid,
  _starts_at timestamptz,
  _client_name text,
  _client_phone text,
  _client_notes text DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _addon_ids uuid[] DEFAULT '{}'::uuid[]
)
 RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _buffer int; _price numeric;
  _addon_duration int := 0; _addon_price numeric := 0;
  _ends_at timestamptz; _block_end timestamptz; _new_id uuid; _mb uuid;
BEGIN
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN RAISE EXCEPTION 'Invalid client name'; END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN RAISE EXCEPTION 'Invalid client phone'; END IF;

  SELECT duration_min, price, COALESCE(buffer_after_min,0)
    INTO _duration, _price, _buffer
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  SELECT branch_id INTO _mb FROM masters WHERE id = _master_id AND salon_id = _salon_id AND is_active = true;
  IF NOT EXISTS (SELECT 1 FROM masters m JOIN master_services ms ON ms.master_id = m.id
                 WHERE m.id = _master_id AND m.salon_id = _salon_id AND m.is_active = true AND ms.service_id = _service_id)
  THEN RAISE EXCEPTION 'Master cannot perform this service'; END IF;
  IF _branch_id IS NOT NULL AND _mb IS NOT NULL AND _mb <> _branch_id THEN
    RAISE EXCEPTION 'Master does not work at this branch';
  END IF;

  -- Sum addons (validated to same salon and active)
  IF _addon_ids IS NOT NULL AND array_length(_addon_ids, 1) > 0 THEN
    SELECT COALESCE(SUM(duration_min),0), COALESCE(SUM(price),0)
      INTO _addon_duration, _addon_price
    FROM service_addons
    WHERE id = ANY(_addon_ids) AND salon_id = _salon_id AND is_active = true;
  END IF;

  _ends_at := _starts_at + ((_duration + _addon_duration) || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;

  IF _starts_at <= now() THEN RAISE EXCEPTION 'Cannot book in the past'; END IF;
  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id AND status = 'confirmed'
             AND starts_at < _block_end AND ends_at > _starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  INSERT INTO appointments(salon_id, master_id, service_id, client_name, client_phone, client_notes, starts_at, ends_at, price, branch_id)
  VALUES (_salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes, _starts_at, _ends_at, _price + _addon_price, COALESCE(_branch_id, _mb))
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

GRANT EXECUTE ON FUNCTION public.create_appointment(uuid, uuid, uuid, timestamptz, text, text, text, uuid, uuid[]) TO anon, authenticated;
