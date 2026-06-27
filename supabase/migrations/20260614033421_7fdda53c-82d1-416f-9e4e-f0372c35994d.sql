CREATE OR REPLACE FUNCTION public.guard_appointment_restore()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'cancelled' AND NEW.status = 'confirmed'
     AND NOT (public.has_role(auth.uid(), 'super_admin')
              OR public.has_role(auth.uid(), 'salon_admin')) THEN
    RAISE EXCEPTION 'Only salon_admin or super_admin can restore cancelled appointments';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_appointment_restore ON public.appointments;
CREATE TRIGGER trg_guard_appointment_restore
  BEFORE UPDATE OF status ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.guard_appointment_restore();