-- Service-role-only accessor for the cron secret, so edge functions can verify
-- the trigger-issued x-cron-secret without querying vault.decrypted_secrets
-- via PostgREST (which is blocked).
CREATE OR REPLACE FUNCTION public.internal_get_cron_secret()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.internal_get_cron_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_get_cron_secret() TO service_role;
