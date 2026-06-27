REVOKE EXECUTE ON FUNCTION public.archive_old_appointments() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.archive_old_appointments() FROM anon;
REVOKE EXECUTE ON FUNCTION public.archive_old_appointments() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.archive_old_appointments() TO service_role;