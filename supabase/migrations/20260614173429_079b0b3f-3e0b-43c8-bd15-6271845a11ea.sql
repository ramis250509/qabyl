CREATE POLICY "appointment_addons master read" ON public.appointment_addons
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.appointments a
  WHERE a.id = appointment_addons.appointment_id
    AND public.has_branch_access(auth.uid(), a.branch_id)
));