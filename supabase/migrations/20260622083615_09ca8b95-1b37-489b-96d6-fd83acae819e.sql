
-- Allow salon-level masters (branch_id IS NULL) to read/update appointments in their salon.
CREATE POLICY "Master reads salon appointments"
ON public.appointments FOR SELECT
TO authenticated
USING (salon_id = public.master_salon_id(auth.uid()));

CREATE POLICY "Master updates salon appointments"
ON public.appointments FOR UPDATE
TO authenticated
USING (salon_id = public.master_salon_id(auth.uid()))
WITH CHECK (salon_id = public.master_salon_id(auth.uid()));

CREATE POLICY "appointment_addons master salon read"
ON public.appointment_addons FOR SELECT
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.appointments a
  WHERE a.id = appointment_addons.appointment_id
    AND a.salon_id = public.master_salon_id(auth.uid())
));
