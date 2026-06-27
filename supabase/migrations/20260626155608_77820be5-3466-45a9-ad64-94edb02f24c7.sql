
REVOKE EXECUTE ON FUNCTION public.wa_try_acquire_lock(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.wa_release_lock(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_try_acquire_lock(uuid, uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_release_lock(uuid, uuid) TO service_role;
