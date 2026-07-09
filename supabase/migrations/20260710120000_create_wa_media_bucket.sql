-- Create the private `wa-media` storage bucket used for WhatsApp client photos (Gemini Vision
-- pricing). It was created manually in the original Lovable Supabase project but never recreated
-- after the migration to the new Cloudflare-hosted project (khykprcdojksqvuqyajd), so every photo
-- upload silently failed and the assistant kept replying "Фото не получили". Idempotent.
INSERT INTO storage.buckets (id, name, public)
VALUES ('wa-media', 'wa-media', false)
ON CONFLICT (id) DO NOTHING;

-- The salon-admin read policy already exists (20260625191013). Server-side uploads use the
-- service role and bypass RLS, so no additional INSERT policy is required for the assistant.
