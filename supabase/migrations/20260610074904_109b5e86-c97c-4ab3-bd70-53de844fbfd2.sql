
-- 1. Price range on services
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS price_max numeric(10,2),
  ADD COLUMN IF NOT EXISTS price_type text NOT NULL DEFAULT 'fixed';
ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_price_type_check;
ALTER TABLE public.services ADD CONSTRAINT services_price_type_check CHECK (price_type IN ('fixed','range'));

-- 2. Branches table
CREATE TABLE IF NOT EXISTS public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text,
  phone text,
  working_hours jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.branches TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.branches TO authenticated;
GRANT ALL ON public.branches TO service_role;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public reads active branches" ON public.branches;
CREATE POLICY "Public reads active branches" ON public.branches FOR SELECT
  TO anon, authenticated
  USING (is_active = true OR public.has_role(auth.uid(), 'super_admin'));
DROP POLICY IF EXISTS "Salon admin manages branches" ON public.branches;
CREATE POLICY "Salon admin manages branches" ON public.branches FOR ALL
  TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id))
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));
DROP POLICY IF EXISTS "Super admin manages branches" ON public.branches;
CREATE POLICY "Super admin manages branches" ON public.branches FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

DROP TRIGGER IF EXISTS trg_branches_updated ON public.branches;
CREATE TRIGGER trg_branches_updated BEFORE UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. branch_id on masters and appointments
ALTER TABLE public.masters ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_masters_branch ON public.masters(branch_id);
CREATE INDEX IF NOT EXISTS idx_appointments_branch ON public.appointments(branch_id);

-- 4. Backfill: create one "Основной" branch per salon, link existing masters & appointments
DO $$
DECLARE _s record; _bid uuid;
BEGIN
  FOR _s IN SELECT id, address, phone FROM public.salons LOOP
    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE salon_id = _s.id) THEN
      INSERT INTO public.branches(salon_id, name, address, phone, sort_order)
      VALUES (_s.id, 'Основной филиал', _s.address, _s.phone, 0)
      RETURNING id INTO _bid;
      UPDATE public.masters SET branch_id = _bid WHERE salon_id = _s.id AND branch_id IS NULL;
      UPDATE public.appointments SET branch_id = _bid WHERE salon_id = _s.id AND branch_id IS NULL;
    END IF;
  END LOOP;
END $$;

-- 5. Update create_appointment to accept branch_id
CREATE OR REPLACE FUNCTION public.create_appointment(
  _salon_id uuid, _master_id uuid, _service_id uuid, _starts_at timestamptz,
  _client_name text, _client_phone text, _client_notes text DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _duration int; _buffer int; _price numeric; _ends_at timestamptz; _block_end timestamptz; _new_id uuid; _mb uuid;
BEGIN
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN RAISE EXCEPTION 'Invalid client name'; END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN RAISE EXCEPTION 'Invalid client phone'; END IF;
  SELECT duration_min, price, COALESCE(buffer_after_min,0) INTO _duration, _price, _buffer FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;
  SELECT branch_id INTO _mb FROM masters WHERE id = _master_id AND salon_id = _salon_id AND is_active = true;
  IF NOT EXISTS (SELECT 1 FROM masters m JOIN master_services ms ON ms.master_id = m.id WHERE m.id = _master_id AND m.salon_id = _salon_id AND m.is_active = true AND ms.service_id = _service_id)
  THEN RAISE EXCEPTION 'Master cannot perform this service'; END IF;
  IF _branch_id IS NOT NULL AND _mb IS NOT NULL AND _mb <> _branch_id THEN
    RAISE EXCEPTION 'Master does not work at this branch';
  END IF;
  _ends_at := _starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;
  IF _starts_at <= now() THEN RAISE EXCEPTION 'Cannot book in the past'; END IF;
  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id AND status = 'confirmed' AND starts_at < _block_end AND ends_at > _starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;
  INSERT INTO appointments(salon_id, master_id, service_id, client_name, client_phone, client_notes, starts_at, ends_at, price, branch_id)
  VALUES (_salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes, _starts_at, _ends_at, _price, COALESCE(_branch_id, _mb))
  RETURNING id INTO _new_id;
  RETURN _new_id;
END;
$$;
