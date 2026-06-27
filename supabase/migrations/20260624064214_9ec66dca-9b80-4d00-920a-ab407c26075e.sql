
DROP POLICY IF EXISTS "Public reads master_services" ON public.master_services;
CREATE POLICY "Public reads master_services" ON public.master_services
  FOR SELECT TO anon, authenticated
  USING (EXISTS (
    SELECT 1 FROM public.masters m
    JOIN public.salons s ON s.id = m.salon_id
    WHERE m.id = master_services.master_id
      AND m.is_active = true
      AND s.is_active = true
  ));

DROP POLICY IF EXISTS "Public reads schedules" ON public.master_schedules;
CREATE POLICY "Public reads schedules" ON public.master_schedules
  FOR SELECT TO anon, authenticated
  USING (EXISTS (
    SELECT 1 FROM public.masters m
    JOIN public.salons s ON s.id = m.salon_id
    WHERE m.id = master_schedules.master_id
      AND m.is_active = true
      AND s.is_active = true
  ));
