-- Alerting: detect "silent" salons — where the WhatsApp assistant has stopped answering clients —
-- and notify BEFORE an angry client tells the owner. This is the cheapest big lift in launch
-- reliability: today a dead GreenAPI instance, an exhausted Gemini quota, or a stuck webhook is
-- invisible until someone complains.
--
-- Signal (data we already have, no external calls): a conversation whose LAST message is an
-- inbound client message left unanswered for > 15 minutes. The assistant replies to essentially
-- every message within seconds, so an unanswered inbound past the grace window means the reply
-- path is broken. We only look at salons that actually have WhatsApp on + credentials, skip
-- conversations a human deliberately paused (ai_paused) or that are closed, and ignore system
-- messages.
--
-- Delivery reuses the existing notifications → push pipeline: an INSERT into `notifications`
-- fires dispatch_push_for_notification (web push) and shows up in the admin panel. Because
-- has_salon_access() is true for super_admin on every salon, the row reaches BOTH the salon's
-- own staff ("ваш ассистент молчит") AND the platform operator (super-admin) — no dependency on
-- the salon's own (possibly broken) GreenAPI to raise the alarm.
--
-- Dedupe: at most one 'wa.silent' alert per salon per 3 hours, so a lingering outage doesn't spam.

CREATE OR REPLACE FUNCTION public.alert_silent_salons()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH last_msg AS (
      -- Latest message per recently-active conversation.
      SELECT DISTINCT ON (m.conversation_id)
        m.conversation_id, m.salon_id, m.direction, m.created_at, m.kind
      FROM wa_messages m
      WHERE m.created_at > now() - interval '2 hours'
      ORDER BY m.conversation_id, m.created_at DESC
    )
    SELECT lm.salon_id, count(*) AS hanging
    FROM last_msg lm
    JOIN wa_conversations c ON c.id = lm.conversation_id
    JOIN salons s ON s.id = lm.salon_id
    LEFT JOIN salon_secrets sec ON sec.salon_id = lm.salon_id
    WHERE lm.direction = 'in'
      AND lm.kind <> 'system'
      AND lm.created_at < now() - interval '15 minutes'   -- grace: reply should have happened
      AND c.status = 'active'
      AND COALESCE(c.ai_paused, false) = false             -- human took over on purpose → not a fault
      AND COALESCE(s.whatsapp_enabled, false) = true
      AND COALESCE(sec.greenapi_instance, '') <> ''
      AND COALESCE(sec.greenapi_token, '') <> ''
    GROUP BY lm.salon_id
  LOOP
    -- One alert per salon per 3h.
    IF EXISTS (
      SELECT 1 FROM notifications
      WHERE salon_id = r.salon_id
        AND type = 'wa.silent'
        AND created_at > now() - interval '3 hours'
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO notifications (salon_id, type, title, body)
    VALUES (
      r.salon_id,
      'wa.silent',
      'Ассистент не отвечает клиентам',
      r.hanging || ' диалог(ов) без ответа более 15 минут. Проверьте подключение WhatsApp (GreenAPI: авторизован ли инстанс) и баланс/квоту ИИ.'
    );
  END LOOP;
END;
$$;

-- Internal only — the cron scheduler (postgres) is the sole caller.
REVOKE ALL ON FUNCTION public.alert_silent_salons() FROM PUBLIC, anon, authenticated;

-- Run every 15 minutes. Re-schedule idempotently.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alert-silent-salons') THEN
    PERFORM cron.unschedule('alert-silent-salons');
  END IF;
END $$;

SELECT cron.schedule(
  'alert-silent-salons',
  '*/15 * * * *',
  $$ SELECT public.alert_silent_salons(); $$
);
