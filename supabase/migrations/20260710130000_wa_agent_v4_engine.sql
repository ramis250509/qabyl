-- WA assistant V4 (LLM tool-calling agent) rollout controls.
-- 1) engine: per-salon switch between the legacy state-machine agent ('v3', default —
--    all existing salons keep current behavior) and the new conversational agent ('v4').
--    Rollback = flip the flag back, no deploy needed.
-- 2) knowledge_base: free-text salon facts (parking, payment methods, promos, brands)
--    injected into the V4 system prompt so the assistant can answer arbitrary questions.
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'v3'
    CHECK (engine IN ('v3', 'v4')),
  ADD COLUMN IF NOT EXISTS knowledge_base text;
