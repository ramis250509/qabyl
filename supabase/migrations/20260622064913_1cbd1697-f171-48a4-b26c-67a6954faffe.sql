DO $$
DECLARE
  appointment_id uuid;
  secret text;
BEGIN
  SELECT a.id INTO appointment_id
  FROM public.appointments a
  JOIN public.salons s ON s.id = a.salon_id
  WHERE s.name = 'Эркеайым'
    AND a.status = 'confirmed'
  ORDER BY a.created_at DESC
  LIMIT 1;

  SELECT public.internal_get_cron_secret() INTO secret;

  IF appointment_id IS NULL THEN
    RAISE NOTICE 'No confirmed Эркеайым appointment found for WhatsApp test';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kcmxbzsjizhrierakvkj.supabase.co/functions/v1/send-whatsapp',
    body := jsonb_build_object('appointment_id', appointment_id, 'kind', 'confirmation'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );
END $$;