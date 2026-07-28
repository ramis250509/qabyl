-- Three things this migration ships:
--   1) excluded_contacts     — per-salon list of phone numbers the AI must ignore entirely
--                              (personal chats, staff, delivery guys, etc.). Checked at the very
--                              start of the WA webhook so no Gemini/Green-API is spent on them.
--   2) wa_appointment_dedup  — short-window idempotency key so a duplicate confirmation from the
--                              client (or a webhook redelivery) cannot create two identical bookings.
--   3) wa_reconcile_paused   — pg_cron-driven reconciliation for AI conversations whose 5-minute
--                              pause has expired and still have an unprocessed client message.
--                              Fires a synthetic "__reconcile__" webhook so the normal agent path
--                              runs — including per-conversation lock, debounce, drain, and agent
--                              call — without any duplicate reply risk.

-- ── 1) excluded_contacts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.excluded_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id     uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  -- Phone stored normalized (digits only, no leading '+'). See normalizeChatIdToPhone in
  -- src/lib/wa-agent.server.ts — the webhook normalizes incoming chatId the same way before lookup.
  phone        text NOT NULL CHECK (phone ~ '^[0-9]+$'),
  label        text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, phone)
);

CREATE INDEX IF NOT EXISTS excluded_contacts_salon_phone_idx
  ON public.excluded_contacts (salon_id, phone);

ALTER TABLE public.excluded_contacts ENABLE ROW LEVEL SECURITY;

-- Super admin sees everything.
DROP POLICY IF EXISTS excluded_contacts_super_all ON public.excluded_contacts;
CREATE POLICY excluded_contacts_super_all ON public.excluded_contacts
  FOR ALL
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Salon admin sees only their own salon's list (matches the existing pattern used elsewhere
-- for salon_ai_assistant etc. — see has_role + user_roles.salon_id join).
DROP POLICY IF EXISTS excluded_contacts_salon_admin_all ON public.excluded_contacts;
CREATE POLICY excluded_contacts_salon_admin_all ON public.excluded_contacts
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'salon_admin'
        AND ur.salon_id = excluded_contacts.salon_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'salon_admin'
        AND ur.salon_id = excluded_contacts.salon_id
    )
  );

CREATE OR REPLACE FUNCTION public.touch_excluded_contacts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS excluded_contacts_touch ON public.excluded_contacts;
CREATE TRIGGER excluded_contacts_touch
BEFORE UPDATE ON public.excluded_contacts
FOR EACH ROW EXECUTE FUNCTION public.touch_excluded_contacts_updated_at();

-- ── 2) short-window booking idempotency ─────────────────────────────────────────────
-- Prevents double-create when the client sends "да да" or a Green-API webhook is redelivered.
-- The unique index covers (salon, phone, service, master, starts_at) for CONFIRMED rows only,
-- so a second attempt for the exact same booking within seconds hits the constraint and the
-- V4 executor turns that into an "already_booked" reason instead of a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_active_dedup_uidx
  ON public.appointments (salon_id, client_phone, service_id, master_id, starts_at)
  WHERE status = 'confirmed';

-- ── 3) reconciliation cron ──────────────────────────────────────────────────────────
-- Requirements:
--   - pg_cron scheduled every minute
--   - pg_net available (Supabase enables it by default; guarded below)
-- Behaviour:
--   For every conversation whose 5-minute AI pause has expired AND that has at least one
--   unprocessed inbound message from the client AFTER the pause started AND the contact is NOT
--   excluded AND the salon still has WA credentials → clear the pause and POST a synthetic
--   "__reconcile__" webhook. The webhook code detects idMessage starting with 'reconcile-' and
--   skips inserting a new inbound row while still draining the real pending messages through
--   the standard agent path (per-conversation lock, debounce, drain, Gemini).

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.wa_run_reconciliation()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  fired integer := 0;
  base_url text := 'https://qabyl.com/api/public/wa/';
BEGIN
  FOR r IN
    SELECT
      c.id                              AS conv_id,
      c.salon_id                        AS salon_id,
      c.client_phone                    AS phone,
      ss.greenapi_webhook_token         AS token
    FROM public.wa_conversations c
    JOIN public.salon_secrets ss ON ss.salon_id = c.salon_id
    WHERE c.ai_paused = true
      AND c.ai_paused_at IS NOT NULL
      AND c.ai_paused_at < now() - interval '5 minutes'
      AND ss.greenapi_webhook_token IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.wa_messages m
        WHERE m.conversation_id = c.id
          AND m.direction = 'in'
          AND m.processed_at IS NULL
          AND m.created_at > c.ai_paused_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.excluded_contacts ec
        WHERE ec.salon_id = c.salon_id AND ec.phone = c.client_phone
      )
    LIMIT 100        -- safety cap per tick
  LOOP
    -- Clear the pause first. If a concurrent manual admin reply lands between this UPDATE and
    -- the POST, the webhook will just re-pause on the outgoing event — nothing breaks.
    UPDATE public.wa_conversations
       SET ai_paused = false, ai_paused_at = NULL
     WHERE id = r.conv_id AND ai_paused = true;

    -- Fire-and-forget POST via pg_net (returns a request id, never blocks).
    PERFORM net.http_post(
      url := base_url || r.salon_id::text || '?token=' || r.token,
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := jsonb_build_object(
        'typeWebhook', 'incomingMessageReceived',
        'idMessage', 'reconcile-' || r.conv_id::text || '-' || extract(epoch from now())::text,
        'senderData', jsonb_build_object(
          'chatId', r.phone || '@c.us',
          'senderName', 'reconcile'
        ),
        'messageData', jsonb_build_object(
          'typeMessage', 'textMessage',
          'textMessageData', jsonb_build_object('textMessage', '__reconcile__')
        )
      )
    );
    fired := fired + 1;
  END LOOP;
  RETURN fired;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'wa_reconcile_paused_every_minute';
    PERFORM cron.schedule(
      'wa_reconcile_paused_every_minute',
      '* * * * *',
      $cron$ SELECT public.wa_run_reconciliation(); $cron$
    );
  END IF;
END $$;
