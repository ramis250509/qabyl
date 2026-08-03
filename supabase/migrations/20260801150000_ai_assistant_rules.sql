-- ============================================================================
-- Split the salon KB into "hard rules" and "facts".
-- ============================================================================
-- Historically salon_ai_assistant.knowledge_base was a single free-text field
-- into which owners dumped both facts ("работаем без выходных") and
-- imperative rules ("ты должен сразу присылать прайс"). In the system prompt
-- both were labelled "additional facts about the business", so the model
-- treated the rules as reference material — and generic assistant rules
-- placed later in the prompt easily over-rode them.
--
-- New model:
--   * knowledge_base — FACTS ONLY (context the assistant can quote from)
--   * ai_rules       — IMPERATIVE RULES (behaviour overrides that WIN over
--                      any generic assistant rule in the prompt)
--
-- Backfill policy (Variant 2): old content stays in knowledge_base verbatim.
-- The salon owner opens the tab, sees the new "Правила для Ассистента" field
-- empty, and manually moves any imperative lines into it. No auto-migration,
-- no regex guessing — clean separation.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS ai_rules text;

COMMENT ON COLUMN public.salon_ai_assistant.ai_rules IS
  'Hard behavioural rules for the WhatsApp assistant — imperative statements
   like "always list prices first", "never ask for a day before pricing is
   settled", etc. Injected into the system prompt in a HIGHEST-PRIORITY
   section that explicitly outranks generic assistant rules. Facts and
   reference context go in knowledge_base instead.';
