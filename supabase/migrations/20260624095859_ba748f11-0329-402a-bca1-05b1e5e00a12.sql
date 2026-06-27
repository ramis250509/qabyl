
-- 1) appointments: tighten master read — require explicit branch match
DROP POLICY IF EXISTS "Master reads salon appointments" ON public.appointments;

CREATE POLICY "Master reads branch appointments"
ON public.appointments
FOR SELECT
TO authenticated
USING (
  master_branch_id(auth.uid()) IS NOT NULL
  AND salon_id = master_salon_id(auth.uid())
  AND branch_id = master_branch_id(auth.uid())
);

-- 2) master_day_overrides: public read for booking widget (mirrors master_schedules)
CREATE POLICY "Public reads day overrides"
ON public.master_day_overrides
FOR SELECT
TO anon, authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.masters m
    JOIN public.salons s ON s.id = m.salon_id
    WHERE m.id = master_day_overrides.master_id
      AND m.is_active = true
      AND s.is_active = true
  )
);
