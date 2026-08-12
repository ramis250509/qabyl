-- Two independent, tenant-safe additions:
--
--   1. salon_ai_assistant.start_language — the language the virtual administrator OPENS in,
--      per business. Until now the agent hard-defaulted to Russian on the first turn and only
--      switched once the client produced a confident Kyrgyz/English signal, which reads wrong
--      for a Kyrgyz-speaking practice whose whole audience writes in Kyrgyz.
--
--   2. Schedule-import infrastructure — importing a salon's existing paper/Sheets calendar
--      into `appointments` without (a) creating duplicates on a re-run, (b) spamming the
--      client over WhatsApp, (c) flooding the notification bell, and (d) tripping the
--      NOT-NULL-ish phone validator on historical rows that simply have no phone recorded.
--
-- Everything here is additive and defaults to today's behaviour: a salon that never imports
-- and never sets start_language behaves exactly as before.

-- ---------------------------------------------------------------------------
-- 1. Starting language of the virtual administrator
-- ---------------------------------------------------------------------------

ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS start_language text NOT NULL DEFAULT 'ru';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.salon_ai_assistant'::regclass
      AND conname = 'salon_ai_assistant_start_language_check'
  ) THEN
    ALTER TABLE public.salon_ai_assistant
      ADD CONSTRAINT salon_ai_assistant_start_language_check
      CHECK (start_language IN ('ru', 'ky', 'en'));
  END IF;
END $$;

COMMENT ON COLUMN public.salon_ai_assistant.start_language IS
  'Language the assistant opens a NEW conversation in when the client has not yet produced a '
  'confident language signal. After that the agent adapts to the client as before.';

-- ---------------------------------------------------------------------------
-- 2. Import batches — the unit of rollback
-- ---------------------------------------------------------------------------
-- Every commit of an import writes one batch row and stamps every appointment it creates
-- with the batch id. "Rollback" is therefore an exact, bounded operation: delete the rows
-- carrying this batch id and nothing else. No heuristics, no time windows, no risk of
-- catching a row a human created in between.

CREATE TABLE IF NOT EXISTS public.appointment_import_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  source_label text NOT NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS appointment_import_batches_salon_idx
  ON public.appointment_import_batches (salon_id, created_at DESC);

ALTER TABLE public.appointment_import_batches ENABLE ROW LEVEL SECURITY;

-- Read-only visibility for people who already administer the salon; all writes go through
-- server functions running on the service role, so no INSERT/UPDATE/DELETE policy is granted.
DROP POLICY IF EXISTS appointment_import_batches_select ON public.appointment_import_batches;
CREATE POLICY appointment_import_batches_select
  ON public.appointment_import_batches FOR SELECT
  USING (public.has_salon_access(auth.uid(), salon_id));

-- ---------------------------------------------------------------------------
-- 3. Idempotency key on appointments
-- ---------------------------------------------------------------------------
-- import_key is a stable fingerprint of the SOURCE ROW (salon + date + time + normalised
-- client name), computed by the importer. The partial unique index is what makes a re-run
-- idempotent at the DATABASE level rather than at the application level: even two importers
-- racing each other cannot produce a duplicate, because the second INSERT is rejected by the
-- index rather than by a SELECT-then-INSERT check that can interleave.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS import_key text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid
    REFERENCES public.appointment_import_batches(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_salon_import_key_uidx
  ON public.appointments (salon_id, import_key)
  WHERE import_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointments_import_batch_idx
  ON public.appointments (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN public.appointments.import_key IS
  'Stable fingerprint of the imported source row. Unique per salon — re-importing the same '
  'sheet updates or skips instead of duplicating.';

-- ---------------------------------------------------------------------------
-- 4. Phone validation: historical imports have no phone
-- ---------------------------------------------------------------------------
-- The paper/Sheets calendars salons keep before moving to Qabyl record a NAME and a time,
-- not a phone. Rejecting those rows would mean importing nothing at all. So the validator
-- keeps its full strength for every channel that can actually obtain a phone (manual entry,
-- the booking widget, the AI assistant) and allows an EMPTY one only for source='import'.
--
-- A partially-filled phone is still rejected everywhere: "0777" is a typo worth catching,
-- whereas "" is an honest "not recorded".
CREATE OR REPLACE FUNCTION public.validate_appointment_phone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  _digits text;
BEGIN
  _digits := regexp_replace(COALESCE(NEW.client_phone, ''), '[^0-9]', '', 'g');
  IF _digits = '' AND NEW.source = 'import' THEN
    RETURN NEW;
  END IF;
  IF length(_digits) < 10 OR length(_digits) > 15 THEN
    RAISE EXCEPTION 'Некорректный номер телефона'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. An import must be silent
-- ---------------------------------------------------------------------------
-- Importing five weeks of history would otherwise fire one WhatsApp confirmation and one
-- notification-bell entry per row — dozens of messages to real clients about appointments
-- that already happened. Both dispatchers now skip source='import' explicitly.

CREATE OR REPLACE FUNCTION public.dispatch_whatsapp_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  fn_url TEXT := 'https://bfxexnpyfslfuelfkhzr.supabase.co/functions/v1/send-whatsapp';
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
  -- A bulk import of an existing calendar is a data migration, not a new booking. The client
  -- already knows about this appointment — messaging them would be spam.
  IF NEW.source = 'import' THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.notify_appointment_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _service_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending_payment' THEN
      RETURN NEW; -- silent while awaiting prepayment
    END IF;
    -- A bulk import is not "a new booking from a client" — one bell entry per imported row
    -- would bury every real notification the owner has.
    IF NEW.source = 'import' THEN
      RETURN NEW;
    END IF;
    SELECT name INTO _service_name FROM services WHERE id = NEW.service_id;
    INSERT INTO public.notifications (salon_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.id, 'appointment.created',
      'Новая запись от клиента',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE 'UTC', 'DD.MM HH24:MI')
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    INSERT INTO public.notifications (salon_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.id, 'appointment.cancelled',
      'Клиент отменил запись',
      COALESCE(NEW.client_name,'Клиент') || ' отменил(а) запись'
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending_payment' AND NEW.status = 'confirmed' THEN
    SELECT name INTO _service_name FROM services WHERE id = NEW.service_id;
    INSERT INTO public.notifications (salon_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.id, 'appointment.created',
      'Новая запись с оплатой',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE 'UTC', 'DD.MM HH24:MI') || ' (оплачено)'
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Reminders must never target an unreachable number
-- ---------------------------------------------------------------------------
-- Independent of the import, this was a latent bug: the reminder cron selected purely on
-- status/time and handed whatever was in client_phone to the WhatsApp sender. With imported
-- rows now legitimately carrying an empty phone, the guard becomes load-bearing.
CREATE OR REPLACE FUNCTION public.get_due_reminders()
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT a.id
  FROM appointments a
  LEFT JOIN salon_ai_assistant aa ON aa.salon_id = a.salon_id
  WHERE a.status = 'confirmed'
    AND a.reminder_sent = false
    AND length(regexp_replace(COALESCE(a.client_phone, ''), '[^0-9]', '', 'g')) >= 10
    AND a.starts_at >= now() + ((COALESCE(aa.reminder_lead_hours, 2) * 60 - 15) * interval '1 minute')
    AND a.starts_at <= now() + ((COALESCE(aa.reminder_lead_hours, 2) * 60 + 15) * interval '1 minute')
  ORDER BY a.starts_at
  LIMIT 200;
$function$;
