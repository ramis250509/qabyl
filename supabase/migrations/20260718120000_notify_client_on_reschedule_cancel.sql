-- Notify the client over WhatsApp when a salon admin CHANGES an existing booking in the
-- calendar (cancels it, or moves its time and/or master). Until now only appointment
-- CREATION was announced (dispatch_whatsapp_confirmation on INSERT) — a manual reschedule
-- or cancel left the client with no message at all, so they showed up to a slot that no
-- longer existed. This closes that gap with a single AFTER UPDATE trigger, which fires for
-- every source of change (calendar drag, cancel button, and any future admin action) at one
-- choke point.
--
-- Guard against double-messaging: only changes made by a logged-in human (auth.uid() present)
-- notify the client. Changes performed by the WhatsApp AI agent run under service_role with
-- no auth.uid() — the agent already confirmed the change to the client in the chat, so a second
-- automated message would be a confusing duplicate. Cron/internal writes (e.g. reminder_sent)
-- also have no uid and are skipped.
--
-- NOTE for a future refactor: if calendar edits are moved to a server function that runs under
-- service_role (see the "route calendar mutations through an RPC" recommendation), auth.uid()
-- there will be NULL and this trigger will stop notifying. That RPC must then trigger the
-- notification itself (call send-whatsapp directly, or re-signal admin intent), otherwise this
-- safety net silently disappears.

CREATE OR REPLACE FUNCTION public.dispatch_whatsapp_appointment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fn_url TEXT := 'https://khykprcdojksqvuqyajd.supabase.co/functions/v1/send-whatsapp';
  secret TEXT;
  wa_on BOOLEAN;
  _kind TEXT;
BEGIN
  -- Only interactive, salon-side changes reach the client. WhatsApp AI agent changes
  -- (service_role, no uid) are skipped — the agent already told the client in chat.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Classify the change. Only a manual cancel of an active booking, or a move of an active
  -- booking (time and/or master), is worth a message. Price/notes/reminder-flag edits and
  -- "restore" (cancelled -> confirmed) are intentionally ignored.
  IF OLD.status = 'confirmed' AND NEW.status = 'cancelled' THEN
    _kind := 'cancellation';
  ELSIF OLD.status = 'confirmed' AND NEW.status = 'confirmed'
        AND (NEW.starts_at IS DISTINCT FROM OLD.starts_at
             OR NEW.master_id IS DISTINCT FROM OLD.master_id) THEN
    _kind := 'reschedule';
  ELSE
    RETURN NEW;
  END IF;

  -- Don't message about a slot that is already in the past (admin tidying up history):
  -- for a reschedule NEW.starts_at is the new time, for a cancel it is the cancelled slot.
  IF NEW.starts_at <= now() THEN
    RETURN NEW;
  END IF;

  -- Respect the salon's WhatsApp toggle, consistent with the confirmation trigger.
  SELECT whatsapp_enabled INTO wa_on FROM public.salons WHERE id = NEW.salon_id;
  IF NOT COALESCE(wa_on, false) THEN
    RETURN NEW;
  END IF;

  SELECT public.internal_get_cron_secret() INTO secret;
  IF secret IS NULL OR length(secret) = 0 THEN
    RAISE WARNING 'dispatch_whatsapp_appointment_change skipped: cron secret is missing';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := fn_url,
    body := jsonb_build_object('appointment_id', NEW.id, 'kind', _kind),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure roll back the admin's calendar change.
  RAISE WARNING 'dispatch_whatsapp_appointment_change failed for appointment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- The WHEN clause keeps the function off the hot path for unrelated column edits; the function
-- itself still re-checks the exact transition before sending anything.
DROP TRIGGER IF EXISTS dispatch_whatsapp_on_appointment_change ON public.appointments;
CREATE TRIGGER dispatch_whatsapp_on_appointment_change
  AFTER UPDATE ON public.appointments
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.starts_at IS DISTINCT FROM NEW.starts_at
    OR OLD.master_id IS DISTINCT FROM NEW.master_id
  )
  EXECUTE FUNCTION public.dispatch_whatsapp_appointment_change();
