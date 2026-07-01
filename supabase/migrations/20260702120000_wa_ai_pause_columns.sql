-- Human-handoff detection: when a salon admin sends a WhatsApp message manually
-- (Green-API's outgoingMessageReceived, as opposed to our own outgoingAPIMessageReceived
-- sends), the AI assistant pauses for that conversation instead of replying alongside
-- a human. ai_paused_at drives an auto-resume timer in the webhook handler.
ALTER TABLE public.wa_conversations
  ADD COLUMN IF NOT EXISTS ai_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_paused_at timestamptz;
