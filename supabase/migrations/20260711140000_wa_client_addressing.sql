-- V4: how regular clients typically address the salon admin (Айка, Эже, Айжан, Админ, Девочки…).
-- Used ONLY to help the assistant understand that such a message is directed at it, so it
-- doesn't reply "к кому вы обращаетесь?". Free text, one term per line or comma-separated.
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS client_addressing text;
