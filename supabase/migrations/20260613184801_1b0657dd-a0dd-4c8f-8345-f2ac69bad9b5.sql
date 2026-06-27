
DROP POLICY IF EXISTS "Public reads day overrides" ON public.master_day_overrides;
DROP POLICY IF EXISTS "Public reads time off" ON public.master_time_off;

DROP POLICY IF EXISTS "Salon admin reads secrets" ON public.salon_secrets;
DROP POLICY IF EXISTS "Salon admin inserts secrets" ON public.salon_secrets;
DROP POLICY IF EXISTS "Salon admin updates secrets" ON public.salon_secrets;
DROP POLICY IF EXISTS "Salon admin deletes secrets" ON public.salon_secrets;
DROP POLICY IF EXISTS "Super admin manages secrets" ON public.salon_secrets;

REVOKE ALL ON public.salon_secrets FROM anon, authenticated;
GRANT ALL ON public.salon_secrets TO service_role;
