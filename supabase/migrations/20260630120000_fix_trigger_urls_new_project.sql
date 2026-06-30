-- Fix hardcoded Supabase project URLs in DB trigger functions.
-- Old project: kcmxbzsjizhrierakvkj → New project: khykprcdojksqvuqyajd
-- Without this, push notifications and WA confirmations silently fail.

CREATE OR REPLACE FUNCTION public.dispatch_push_for_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fn_url TEXT := 'https://khykprcdojksqvuqyajd.supabase.co/functions/v1/send-push';
  secret TEXT;
BEGIN
  SELECT public.internal_get_cron_secret() INTO secret;
  IF secret IS NULL OR length(secret) = 0 THEN
    RAISE WARNING 'dispatch_push_for_notification skipped: cron secret is missing';
    RETURN NEW;
  END IF;
  PERFORM net.http_post(
    url := fn_url,
    body := jsonb_build_object('notification_id', NEW.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'dispatch_push_for_notification failed for notification %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_whatsapp_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fn_url TEXT := 'https://khykprcdojksqvuqyajd.supabase.co/functions/v1/send-whatsapp';
  secret TEXT;
  wa_on BOOLEAN;
BEGIN
  IF NEW.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;
  -- AI assistant already replied to the client in WhatsApp, do not double-send.
  IF NEW.source = 'ai_assistant' THEN
    RETURN NEW;
  END IF;
  SELECT whatsapp_enabled INTO wa_on FROM public.salons WHERE id = NEW.salon_id;
  IF NOT COALESCE(wa_on, false) THEN
    RETURN NEW;
  END IF;
  SELECT public.internal_get_cron_secret() INTO secret;
  IF secret IS NULL OR length(secret) = 0 THEN
    RAISE WARNING 'dispatch_whatsapp_confirmation skipped: cron secret is missing';
    RETURN NEW;
  END IF;
  PERFORM net.http_post(
    url := fn_url,
    body := jsonb_build_object('appointment_id', NEW.id, 'kind', 'confirmation'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'dispatch_whatsapp_confirmation failed for appointment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
