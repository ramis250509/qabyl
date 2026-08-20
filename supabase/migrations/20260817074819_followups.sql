-- One follow-up message to a lead who went quiet.
--
-- WHAT IS AND IS NOT POSSIBLE HERE, because the limit is a platform rule and not a choice:
--
--   Instagram Direct — a business may message a person freely for 24 HOURS after that person's
--   last message. After that the only way through is Meta's HUMAN_AGENT tag, which needs the
--   `human_agent` permission granted through App Review AND is explicitly for a human agent who
--   needs more time — not for automated sales follow-ups. So: inside 24 h, yes; outside, no.
--
--   WhatsApp Cloud API — the same 24-hour customer-service window, after which only a
--   pre-approved template may be sent.
--
--   WhatsApp via Green-API — an unofficial transport with no window enforced, but messaging
--   someone days later from a real account is exactly what gets that account banned.
--
-- So this feature deliberately lives INSIDE the window on every channel. A follow-up that cannot
-- be sent is skipped, never queued for later: a nudge that arrives two days after the question
-- is worse than none.
--
-- The text is written by the OWNER and sent verbatim. No model runs here — an unattended
-- generated message to someone who already stopped replying is the worst possible place to let
-- an assistant improvise.

ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS followup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS followup_delay_hours integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS followup_text text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.salon_ai_assistant'::regclass
      AND conname = 'salon_ai_assistant_followup_delay_check'
  ) THEN
    -- Under an hour is nagging; over twenty is outside the 24-hour window by the time it fires.
    ALTER TABLE public.salon_ai_assistant
      ADD CONSTRAINT salon_ai_assistant_followup_delay_check
      CHECK (followup_delay_hours BETWEEN 1 AND 20);
  END IF;
END $$;

COMMENT ON COLUMN public.salon_ai_assistant.followup_enabled IS
  'Send one follow-up to a lead who stopped replying. Off by default.';
COMMENT ON COLUMN public.salon_ai_assistant.followup_text IS
  'Owner-written follow-up, sent verbatim. Empty = nothing is sent, even when enabled.';

-- Stamped when the follow-up goes out. Its presence is the "already nudged" guard, so a salon
-- can never send a second one to the same conversation — the column IS the once-only rule.
ALTER TABLE public.wa_conversations
  ADD COLUMN IF NOT EXISTS followup_sent_at timestamptz;

-- Partial index: the cron asks "conversations never followed up, touched recently", and this
-- keeps that from scanning the whole table every fifteen minutes.
CREATE INDEX IF NOT EXISTS wa_conversations_followup_pending_idx
  ON public.wa_conversations (salon_id, last_message_at DESC)
  WHERE followup_sent_at IS NULL;
