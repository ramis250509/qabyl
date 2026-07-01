-- Daily cleanup of old WhatsApp client photos (wa-media bucket). Photos were being kept
-- forever with no retention policy — pure unbounded storage cost with no product reason.
-- The cleanup-wa-media edge function deletes photos older than 30 days and nulls out
-- wa_messages.media_path so they don't get reprocessed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-wa-media') THEN
    PERFORM cron.unschedule('cleanup-wa-media');
  END IF;
END $$;

SELECT cron.schedule(
  'cleanup-wa-media',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://khykprcdojksqvuqyajd.supabase.co/functions/v1/cleanup-wa-media',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT public.internal_get_cron_secret())
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) AS request_id;
  $$
);
