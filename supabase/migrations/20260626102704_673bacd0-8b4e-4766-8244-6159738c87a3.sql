ALTER TABLE public.wa_conversations
  ADD COLUMN IF NOT EXISTS session_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_appointment_at timestamptz;

CREATE INDEX IF NOT EXISTS wa_conversations_session_idx
  ON public.wa_conversations(salon_id, client_phone, session_started_at DESC);