
-- Roles
CREATE TYPE public.app_role AS ENUM ('super_admin', 'salon_admin');

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  salon_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, salon_id)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE POLICY "Users view own roles" ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'super_admin'));
CREATE POLICY "Super admin manages roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Salons
CREATE TABLE public.salons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  custom_domain TEXT UNIQUE,
  description TEXT,
  address TEXT,
  phone TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  brand_primary TEXT DEFAULT '#0ea5e9',
  brand_accent TEXT DEFAULT '#f59e0b',
  logo_url TEXT,
  -- GreenAPI credentials (NEVER expose publicly)
  greenapi_instance TEXT,
  greenapi_token TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.salons TO authenticated;
GRANT ALL ON public.salons TO service_role;
-- Anon can read non-sensitive salon info via a view (created below)
ALTER TABLE public.salons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admin manages salons" ON public.salons FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Public view of salons (no credentials)
CREATE OR REPLACE VIEW public.salons_public AS
SELECT id, slug, name, custom_domain, description, address, phone, timezone,
       brand_primary, brand_accent, logo_url, is_active
FROM public.salons
WHERE is_active = true;
GRANT SELECT ON public.salons_public TO anon, authenticated;

-- Masters
CREATE TABLE public.masters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  specialization TEXT,
  photo_url TEXT,
  bio TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.masters TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.masters TO authenticated;
GRANT ALL ON public.masters TO service_role;
ALTER TABLE public.masters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public reads active masters" ON public.masters FOR SELECT TO anon, authenticated
  USING (is_active = true OR public.has_role(auth.uid(), 'super_admin'));
CREATE POLICY "Super admin manages masters" ON public.masters FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Master schedules (weekly working hours)
CREATE TABLE public.master_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id UUID NOT NULL REFERENCES public.masters(id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL, -- 0=Sunday .. 6=Saturday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  UNIQUE (master_id, weekday, start_time)
);
GRANT SELECT ON public.master_schedules TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.master_schedules TO authenticated;
GRANT ALL ON public.master_schedules TO service_role;
ALTER TABLE public.master_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public reads schedules" ON public.master_schedules FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Super admin manages schedules" ON public.master_schedules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Master time off
CREATE TABLE public.master_time_off (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id UUID NOT NULL REFERENCES public.masters(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT
);
GRANT SELECT ON public.master_time_off TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.master_time_off TO authenticated;
GRANT ALL ON public.master_time_off TO service_role;
ALTER TABLE public.master_time_off ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public reads time off" ON public.master_time_off FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Super admin manages time off" ON public.master_time_off FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Services
CREATE TABLE public.services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  duration_min INT NOT NULL CHECK (duration_min > 0),
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  color TEXT DEFAULT '#0ea5e9',
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.services TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.services TO authenticated;
GRANT ALL ON public.services TO service_role;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public reads active services" ON public.services FOR SELECT TO anon, authenticated
  USING (is_active = true OR public.has_role(auth.uid(), 'super_admin'));
CREATE POLICY "Super admin manages services" ON public.services FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Master <-> Service link
CREATE TABLE public.master_services (
  master_id UUID NOT NULL REFERENCES public.masters(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
);
GRANT SELECT ON public.master_services TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.master_services TO authenticated;
GRANT ALL ON public.master_services TO service_role;
ALTER TABLE public.master_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public reads master_services" ON public.master_services FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Super admin manages master_services" ON public.master_services FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Appointments
CREATE TYPE public.appointment_status AS ENUM ('confirmed', 'cancelled', 'completed', 'no_show');

CREATE TABLE public.appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  master_id UUID NOT NULL REFERENCES public.masters(id) ON DELETE RESTRICT,
  service_id UUID NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  client_notes TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  status appointment_status NOT NULL DEFAULT 'confirmed',
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointments_master_time ON public.appointments(master_id, starts_at);
CREATE INDEX idx_appointments_salon_time ON public.appointments(salon_id, starts_at);

GRANT INSERT ON public.appointments TO anon, authenticated;
GRANT SELECT, UPDATE, DELETE ON public.appointments TO authenticated;
GRANT ALL ON public.appointments TO service_role;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

-- Anyone can create an appointment (public booking)
CREATE POLICY "Anyone creates appointment" ON public.appointments FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'confirmed');
-- Only super admin can read/edit appointments (client phones must stay private)
CREATE POLICY "Super admin reads appointments" ON public.appointments FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'));
CREATE POLICY "Super admin updates appointments" ON public.appointments FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));
CREATE POLICY "Super admin deletes appointments" ON public.appointments FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'));

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER trg_salons_updated BEFORE UPDATE ON public.salons FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_appointments_updated BEFORE UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Function: get available slots for a master on a date for a service duration
CREATE OR REPLACE FUNCTION public.get_available_slots(
  _master_id uuid,
  _service_id uuid,
  _date date
)
RETURNS TABLE(slot_start timestamptz, slot_end timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _duration int;
  _tz text;
  _wd smallint;
  _sched record;
  _slot_start timestamptz;
  _slot_end timestamptz;
  _step interval := interval '15 minutes';
BEGIN
  SELECT duration_min INTO _duration FROM services WHERE id = _service_id AND is_active = true;
  IF _duration IS NULL THEN RETURN; END IF;

  SELECT s.timezone INTO _tz FROM masters m JOIN salons s ON s.id = m.salon_id WHERE m.id = _master_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;

  _wd := EXTRACT(DOW FROM _date)::smallint;

  FOR _sched IN
    SELECT start_time, end_time FROM master_schedules
    WHERE master_id = _master_id AND weekday = _wd
    ORDER BY start_time
  LOOP
    _slot_start := ((_date::text || ' ' || _sched.start_time::text)::timestamp AT TIME ZONE _tz);
    LOOP
      _slot_end := _slot_start + (_duration || ' minutes')::interval;
      EXIT WHEN _slot_end > ((_date::text || ' ' || _sched.end_time::text)::timestamp AT TIME ZONE _tz);

      -- skip if in the past
      IF _slot_start <= now() THEN
        _slot_start := _slot_start + _step;
        CONTINUE;
      END IF;

      -- check conflicts with existing appointments
      IF NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.master_id = _master_id
          AND a.status = 'confirmed'
          AND a.starts_at < _slot_end
          AND a.ends_at > _slot_start
      )
      -- check time off
      AND NOT EXISTS (
        SELECT 1 FROM master_time_off t
        WHERE t.master_id = _master_id
          AND t.starts_at < _slot_end
          AND t.ends_at > _slot_start
      )
      THEN
        slot_start := _slot_start;
        slot_end := _slot_end;
        RETURN NEXT;
      END IF;

      _slot_start := _slot_start + _step;
    END LOOP;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_available_slots(uuid, uuid, date) TO anon, authenticated;

-- Function: safe appointment creation (validates slot availability)
CREATE OR REPLACE FUNCTION public.create_appointment(
  _salon_id uuid,
  _master_id uuid,
  _service_id uuid,
  _starts_at timestamptz,
  _client_name text,
  _client_phone text,
  _client_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _duration int;
  _price numeric;
  _ends_at timestamptz;
  _new_id uuid;
BEGIN
  -- Validate inputs
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN
    RAISE EXCEPTION 'Invalid client name';
  END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN
    RAISE EXCEPTION 'Invalid client phone';
  END IF;

  SELECT duration_min, price INTO _duration, _price
    FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  -- Verify master belongs to salon and offers service
  IF NOT EXISTS (
    SELECT 1 FROM masters m
    JOIN master_services ms ON ms.master_id = m.id
    WHERE m.id = _master_id AND m.salon_id = _salon_id AND m.is_active = true
      AND ms.service_id = _service_id
  ) THEN RAISE EXCEPTION 'Master cannot perform this service'; END IF;

  _ends_at := _starts_at + (_duration || ' minutes')::interval;

  IF _starts_at <= now() THEN RAISE EXCEPTION 'Cannot book in the past'; END IF;

  -- Conflict check
  IF EXISTS (
    SELECT 1 FROM appointments
    WHERE master_id = _master_id AND status = 'confirmed'
      AND starts_at < _ends_at AND ends_at > _starts_at
  ) THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  INSERT INTO appointments(salon_id, master_id, service_id, client_name, client_phone, client_notes, starts_at, ends_at, price)
  VALUES (_salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes, _starts_at, _ends_at, _price)
  RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_appointment(uuid, uuid, uuid, timestamptz, text, text, text) TO anon, authenticated;

-- Function to find salon by hostname (public)
CREATE OR REPLACE FUNCTION public.get_salon_by_host(_host text)
RETURNS TABLE(id uuid, slug text, name text, custom_domain text, description text, address text, phone text,
              timezone text, brand_primary text, brand_accent text, logo_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id, slug, name, custom_domain, description, address, phone, timezone,
         brand_primary, brand_accent, logo_url
  FROM salons
  WHERE is_active = true AND (custom_domain = _host OR custom_domain = lower(_host))
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_salon_by_host(text) TO anon, authenticated;
