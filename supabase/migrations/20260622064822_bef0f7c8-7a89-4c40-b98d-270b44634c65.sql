REVOKE ALL ON FUNCTION public.internal_get_cron_secret() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.internal_get_cron_secret() FROM anon;
REVOKE ALL ON FUNCTION public.internal_get_cron_secret() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.internal_get_cron_secret() TO service_role;