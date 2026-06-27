ALTER TABLE public.salons ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.guard_salon_whatsapp_enabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.whatsapp_enabled IS DISTINCT FROM OLD.whatsapp_enabled
     AND NOT public.has_role(auth.uid(), 'super_admin') THEN
    RAISE EXCEPTION 'Only super_admin can change whatsapp_enabled';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_salon_whatsapp_enabled ON public.salons;
CREATE TRIGGER guard_salon_whatsapp_enabled
BEFORE UPDATE ON public.salons
FOR EACH ROW EXECUTE FUNCTION public.guard_salon_whatsapp_enabled();