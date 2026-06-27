-- Helper function: super_admin OR salon_admin of that salon
CREATE OR REPLACE FUNCTION public.has_salon_access(_user_id uuid, _salon_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND (role = 'super_admin' OR (role = 'salon_admin' AND salon_id = _salon_id))
  )
$$;

-- SALONS: salon_admin can read+update own salon
DROP POLICY IF EXISTS "Salon admin reads own salon" ON public.salons;
CREATE POLICY "Salon admin reads own salon" ON public.salons
  FOR SELECT TO authenticated
  USING (has_salon_access(auth.uid(), id));

DROP POLICY IF EXISTS "Salon admin updates own salon" ON public.salons;
CREATE POLICY "Salon admin updates own salon" ON public.salons
  FOR UPDATE TO authenticated
  USING (has_salon_access(auth.uid(), id))
  WITH CHECK (has_salon_access(auth.uid(), id));

-- MASTERS
DROP POLICY IF EXISTS "Salon admin manages masters" ON public.masters;
CREATE POLICY "Salon admin manages masters" ON public.masters
  FOR ALL TO authenticated
  USING (has_salon_access(auth.uid(), salon_id))
  WITH CHECK (has_salon_access(auth.uid(), salon_id));

-- SERVICES
DROP POLICY IF EXISTS "Salon admin manages services" ON public.services;
CREATE POLICY "Salon admin manages services" ON public.services
  FOR ALL TO authenticated
  USING (has_salon_access(auth.uid(), salon_id))
  WITH CHECK (has_salon_access(auth.uid(), salon_id));

-- MASTER_SCHEDULES (no salon_id column, join via master)
DROP POLICY IF EXISTS "Salon admin manages schedules" ON public.master_schedules;
CREATE POLICY "Salon admin manages schedules" ON public.master_schedules
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM masters m WHERE m.id = master_id AND has_salon_access(auth.uid(), m.salon_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM masters m WHERE m.id = master_id AND has_salon_access(auth.uid(), m.salon_id)));

-- MASTER_SERVICES
DROP POLICY IF EXISTS "Salon admin manages master_services" ON public.master_services;
CREATE POLICY "Salon admin manages master_services" ON public.master_services
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM masters m WHERE m.id = master_id AND has_salon_access(auth.uid(), m.salon_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM masters m WHERE m.id = master_id AND has_salon_access(auth.uid(), m.salon_id)));

-- MASTER_TIME_OFF
DROP POLICY IF EXISTS "Salon admin manages time off" ON public.master_time_off;
CREATE POLICY "Salon admin manages time off" ON public.master_time_off
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM masters m WHERE m.id = master_id AND has_salon_access(auth.uid(), m.salon_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM masters m WHERE m.id = master_id AND has_salon_access(auth.uid(), m.salon_id)));

-- APPOINTMENTS
DROP POLICY IF EXISTS "Salon admin reads appointments" ON public.appointments;
CREATE POLICY "Salon admin reads appointments" ON public.appointments
  FOR SELECT TO authenticated
  USING (has_salon_access(auth.uid(), salon_id));

DROP POLICY IF EXISTS "Salon admin updates appointments" ON public.appointments;
CREATE POLICY "Salon admin updates appointments" ON public.appointments
  FOR UPDATE TO authenticated
  USING (has_salon_access(auth.uid(), salon_id))
  WITH CHECK (has_salon_access(auth.uid(), salon_id));

DROP POLICY IF EXISTS "Salon admin deletes appointments" ON public.appointments;
CREATE POLICY "Salon admin deletes appointments" ON public.appointments
  FOR DELETE TO authenticated
  USING (has_salon_access(auth.uid(), salon_id));