
-- 1. ai_assistant_enabled flag on salons (super_admin only)
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS ai_assistant_enabled boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.guard_salon_ai_assistant_enabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ai_assistant_enabled IS DISTINCT FROM OLD.ai_assistant_enabled
     AND NOT public.has_role(auth.uid(), 'super_admin') THEN
    RAISE EXCEPTION 'Only super_admin can change ai_assistant_enabled';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_salon_ai_assistant_enabled_trg ON public.salons;
CREATE TRIGGER guard_salon_ai_assistant_enabled_trg
  BEFORE UPDATE ON public.salons
  FOR EACH ROW EXECUTE FUNCTION public.guard_salon_ai_assistant_enabled();

-- 2. Webhook token in salon_secrets
ALTER TABLE public.salon_secrets
  ADD COLUMN IF NOT EXISTS greenapi_webhook_token text;

-- 3. salon_ai_assistant
CREATE TABLE IF NOT EXISTS public.salon_ai_assistant (
  salon_id uuid PRIMARY KEY REFERENCES public.salons(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  whatsapp_phone text,
  greeting text,
  tone_instructions text,
  pricing_rules text,
  languages text[] NOT NULL DEFAULT ARRAY['ru','ky']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.salon_ai_assistant TO authenticated;
GRANT ALL ON public.salon_ai_assistant TO service_role;

ALTER TABLE public.salon_ai_assistant ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Salon admins read assistant"
  ON public.salon_ai_assistant FOR SELECT TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

CREATE POLICY "Salon admins insert assistant"
  ON public.salon_ai_assistant FOR INSERT TO authenticated
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

CREATE POLICY "Salon admins update assistant"
  ON public.salon_ai_assistant FOR UPDATE TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id))
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

CREATE POLICY "Salon admins delete assistant"
  ON public.salon_ai_assistant FOR DELETE TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

CREATE TRIGGER salon_ai_assistant_touch
  BEFORE UPDATE ON public.salon_ai_assistant
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4. wa_conversations
CREATE TABLE IF NOT EXISTS public.wa_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  client_phone text NOT NULL,
  client_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','booked','closed')),
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_message_preview text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, client_phone)
);

CREATE INDEX IF NOT EXISTS wa_conversations_salon_last_idx
  ON public.wa_conversations (salon_id, last_message_at DESC);

GRANT SELECT ON public.wa_conversations TO authenticated;
GRANT ALL ON public.wa_conversations TO service_role;

ALTER TABLE public.wa_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Salon admins read conversations"
  ON public.wa_conversations FOR SELECT TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

CREATE TRIGGER wa_conversations_touch
  BEFORE UPDATE ON public.wa_conversations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 5. wa_messages
CREATE TABLE IF NOT EXISTS public.wa_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.wa_conversations(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','system')),
  text_body text,
  media_path text,
  green_api_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_messages_conversation_idx
  ON public.wa_messages (conversation_id, created_at);

GRANT SELECT ON public.wa_messages TO authenticated;
GRANT ALL ON public.wa_messages TO service_role;

ALTER TABLE public.wa_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Salon admins read messages"
  ON public.wa_messages FOR SELECT TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.wa_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.wa_conversations;
