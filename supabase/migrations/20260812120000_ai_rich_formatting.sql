-- ============================================================================
-- Per-salon switch: allow the assistant to format replies with lists/emoji.
-- ============================================================================
-- The V4 prompt hard-forbids lists, bullets and markdown ("ФОРМАТ (СТРОГО):
-- только сплошной связный текст"), and humanizeReply() collapses any list the
-- model produces back into a paragraph. That is the right default for a chat
-- that should read like a human admin typing.
--
-- But some owners genuinely want structured, "prettified" messages, and until
-- now writing that into ai_rules did nothing: the generic rule out-shouted the
-- owner rule in the prompt, and the post-processor removed whatever survived.
-- The setting had no way to win, which reads as "the assistant ignores my
-- rules".
--
-- rich_formatting = true swaps the prompt's FORMAT/emoji lines for permissive
-- ones and stops humanizeReply from flattening lists. Markdown (** __ ` #) is
-- still stripped in both modes — neither WhatsApp nor Instagram renders it, so
-- it would reach the client as literal asterisks.
--
-- Default false: existing salons keep today's behaviour exactly.
-- Idempotent.
-- ============================================================================

ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS rich_formatting boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.salon_ai_assistant.rich_formatting IS
  'When true, the assistant may use bullet lists, line breaks and several
   emoji per message, and humanizeReply() keeps that structure intact.
   When false (default) replies are forced into plain flowing prose.';
