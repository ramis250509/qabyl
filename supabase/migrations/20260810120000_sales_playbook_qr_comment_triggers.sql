-- ============================================================================
-- Four additions, all owner-configurable, none of them changing existing behaviour:
--
--   1) salon_ai_assistant sales playbook  — the owner's USP, their own objection
--      answers, their promos, and how eagerly the assistant may hand out the
--      online-booking link. Structured JSONB rather than more free text, because
--      the agent injects ONLY the objection that actually fired into the prompt
--      (see src/lib/sales-playbook.server.ts) — that selection is impossible over
--      a blob of prose.
--
--   2) prepayment_settings QR            — per-salon payment QR image, sent to the
--      client at the moment a slot is held. Lives in its own PUBLIC bucket: both
--      Green-API and Meta fetch the image server-side from a plain URL, and a
--      signed URL would expire out from under a retry. A payment QR is meant to be
--      shown to clients — it is not a secret — and the path is uuid-based.
--
--   3) instagram_comment_triggers        — keyword under a post → automatic DM, via
--      Meta's Private Replies. Per salon, optionally scoped to one post.
--
--   4) instagram_comment_events          — dedup ledger. Meta redelivers a webhook
--      batch on any non-200 and allows exactly ONE private reply per comment, so a
--      redelivery must not produce a second (rejected, and log-noisy) attempt.
--
-- Idempotent.
-- ============================================================================

-- ── 1) Sales playbook on salon_ai_assistant ─────────────────────────────────
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS sales_usp          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sales_objections   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sales_promos       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS booking_link_mode  text  NOT NULL DEFAULT 'auto';

COMMENT ON COLUMN public.salon_ai_assistant.sales_usp IS
  'JSON array of strings: why a client should pick THIS business. Quoted by the assistant when a trust/competitor objection fires. Never invented — an empty array means the assistant answers honestly without claiming advantages.';
COMMENT ON COLUMN public.salon_ai_assistant.sales_objections IS
  'JSON array of {"trigger":"дорого","answer":"..."}: the owner''s own wording for the objections they hear most. Matched by substring against the client message and injected verbatim, outranking the generic play for that objection type.';
COMMENT ON COLUMN public.salon_ai_assistant.sales_promos IS
  'JSON array of {"title":"...","details":"...","until":"YYYY-MM-DD"}: real, current offers. The assistant may only mention a promo listed here, and never past its `until` date.';
COMMENT ON COLUMN public.salon_ai_assistant.booking_link_mode IS
  'off = never send the online-booking link; auto = only when the client asks or the in-chat flow is genuinely stuck; eager = also offer it proactively once the service is chosen.';

ALTER TABLE public.salon_ai_assistant
  DROP CONSTRAINT IF EXISTS salon_ai_assistant_booking_link_mode_chk;
ALTER TABLE public.salon_ai_assistant
  ADD CONSTRAINT salon_ai_assistant_booking_link_mode_chk
  CHECK (booking_link_mode IN ('off', 'auto', 'eager'));

-- Shape guards. The admin UI writes arrays; a hand-written object here would make the
-- agent's renderer silently drop the whole block, which is the worst failure mode
-- (owner configured something, assistant ignores it, nobody sees an error).
ALTER TABLE public.salon_ai_assistant
  DROP CONSTRAINT IF EXISTS salon_ai_assistant_sales_shapes_chk;
ALTER TABLE public.salon_ai_assistant
  ADD CONSTRAINT salon_ai_assistant_sales_shapes_chk
  CHECK (
    jsonb_typeof(sales_usp) = 'array'
    AND jsonb_typeof(sales_objections) = 'array'
    AND jsonb_typeof(sales_promos) = 'array'
  );

-- ── 2) Payment QR on prepayment_settings ────────────────────────────────────
ALTER TABLE public.prepayment_settings
  ADD COLUMN IF NOT EXISTS qr_path text,
  ADD COLUMN IF NOT EXISTS qr_url  text;

COMMENT ON COLUMN public.prepayment_settings.qr_path IS
  'Storage path inside the payment-qr bucket: <salon_id>/<uuid>.<ext>. Kept so a replacement can delete the old object.';
COMMENT ON COLUMN public.prepayment_settings.qr_url IS
  'Public URL of the QR image, sent to the client when a slot is held. Denormalised so the send path needs no bucket knowledge and no extra round-trip.';

-- Public on purpose: Green-API and Meta both fetch this URL from their own servers,
-- where a 5-minute signed URL would expire mid-retry. The object is a payment QR the
-- salon hands out to clients anyway, and the path carries a uuid.
INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-qr', 'payment-qr', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Writes are done by the browser with the owner's own session (an image upload is
-- not worth a server-fn round-trip through base64), so the write policies must be
-- real and salon-scoped: the first path segment IS the salon id.
DROP POLICY IF EXISTS "Salon admin writes own payment QR" ON storage.objects;
CREATE POLICY "Salon admin writes own payment QR" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'payment-qr'
    AND (storage.foldername(name))[1] IS NOT NULL
    AND (
      public.has_role(auth.uid(), 'super_admin')
      OR public.has_salon_access(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );

DROP POLICY IF EXISTS "Salon admin replaces own payment QR" ON storage.objects;
CREATE POLICY "Salon admin replaces own payment QR" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'payment-qr'
    AND (storage.foldername(name))[1] IS NOT NULL
    AND (
      public.has_role(auth.uid(), 'super_admin')
      OR public.has_salon_access(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );

DROP POLICY IF EXISTS "Salon admin deletes own payment QR" ON storage.objects;
CREATE POLICY "Salon admin deletes own payment QR" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'payment-qr'
    AND (storage.foldername(name))[1] IS NOT NULL
    AND (
      public.has_role(auth.uid(), 'super_admin')
      OR public.has_salon_access(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );

-- ── 3) Instagram comment → DM triggers ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.instagram_comment_triggers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  -- Stored lower-cased and trimmed; matching is done on a lower-cased comment.
  keyword     text NOT NULL CHECK (length(btrim(keyword)) BETWEEN 2 AND 60),
  -- exact    = the whole comment is the keyword (modulo punctuation/emoji)
  -- contains = the keyword appears anywhere in the comment
  match_mode  text NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('exact', 'contains')),
  -- NULL = any post/reel of this account. Otherwise the Instagram media id.
  media_id    text,
  -- The single message Meta lets us send. Must invite a DM reply: until the person
  -- answers, we are not allowed to send anything else.
  reply_text  text NOT NULL CHECK (length(btrim(reply_text)) BETWEEN 1 AND 900),
  -- Optional public comment reply ("ответила вам в директ 💌") so other readers see
  -- the account is alive. Empty = stay silent under the post.
  public_reply text,
  enabled     boolean NOT NULL DEFAULT true,
  -- Free-text note handed to the assistant as the client's entry context, e.g.
  -- "пришёл с поста про кератин по слову ЦЕНА".
  ai_context  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One keyword per post scope. COALESCE because NULL media_id ("any post") must still
-- collide with itself, and NULL never equals NULL in a plain unique index.
CREATE UNIQUE INDEX IF NOT EXISTS instagram_comment_triggers_uidx
  ON public.instagram_comment_triggers (salon_id, keyword, COALESCE(media_id, ''));

CREATE INDEX IF NOT EXISTS instagram_comment_triggers_salon_idx
  ON public.instagram_comment_triggers (salon_id) WHERE enabled;

ALTER TABLE public.instagram_comment_triggers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ig_comment_triggers_super_all ON public.instagram_comment_triggers;
CREATE POLICY ig_comment_triggers_super_all ON public.instagram_comment_triggers
  FOR ALL
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

DROP POLICY IF EXISTS ig_comment_triggers_salon_admin_all ON public.instagram_comment_triggers;
CREATE POLICY ig_comment_triggers_salon_admin_all ON public.instagram_comment_triggers
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'salon_admin'
        AND ur.salon_id = instagram_comment_triggers.salon_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'salon_admin'
        AND ur.salon_id = instagram_comment_triggers.salon_id
    )
  );

CREATE OR REPLACE FUNCTION public.touch_instagram_comment_triggers_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS instagram_comment_triggers_touch ON public.instagram_comment_triggers;
CREATE TRIGGER instagram_comment_triggers_touch
  BEFORE UPDATE ON public.instagram_comment_triggers
  FOR EACH ROW EXECUTE FUNCTION public.touch_instagram_comment_triggers_updated_at();

-- ── 4) Private-reply dedup ledger ───────────────────────────────────────────
-- Meta allows exactly one private reply per comment and redelivers a webhook batch
-- for up to 36 h on any non-200. Without this ledger a redelivery would fire a second
-- private reply, which Meta rejects — turning a normal retry into an error every time.
CREATE TABLE IF NOT EXISTS public.instagram_comment_events (
  comment_id  text PRIMARY KEY,
  salon_id    uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  trigger_id  uuid REFERENCES public.instagram_comment_triggers(id) ON DELETE SET NULL,
  commenter_id text,
  media_id    text,
  -- processing (claimed, mid-flight) | sent | failed | skipped_* (no_match, no_sender,
  -- too_old, excluded, awaiting_reply). Intentionally not a CHECK constraint: a new skip
  -- reason should never be able to break the webhook that is trying to record it.
  outcome     text NOT NULL,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_comment_events_salon_idx
  ON public.instagram_comment_events (salon_id, created_at DESC);

-- Backs the "have we already DMed this person and are still waiting for their reply?" probe.
-- Meta's one-message rule is per PERSON, not per comment, so this lookup runs on every
-- matched comment.
CREATE INDEX IF NOT EXISTS instagram_comment_events_commenter_idx
  ON public.instagram_comment_events (salon_id, commenter_id, created_at DESC)
  WHERE commenter_id IS NOT NULL;

ALTER TABLE public.instagram_comment_events ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner (the Instagram tab shows "сработало N раз"); the webhook
-- writes with the service role, which bypasses RLS.
DROP POLICY IF EXISTS ig_comment_events_read ON public.instagram_comment_events;
CREATE POLICY ig_comment_events_read ON public.instagram_comment_events
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'salon_admin'
        AND ur.salon_id = instagram_comment_events.salon_id
    )
  );
