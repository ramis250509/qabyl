-- V5: multi-industry AI administrator.
-- Adds the business vertical and the structured "knowledge book" answers to the
-- per-salon assistant config. Both are consumed only by the V4 engine
-- (see src/lib/wa-industries.server.ts / src/lib/industries.ts).

ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT 'beauty';

ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS knowledge_answers jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Guard against typos / unknown verticals at the DB layer.
ALTER TABLE public.salon_ai_assistant
  DROP CONSTRAINT IF EXISTS salon_ai_assistant_industry_check;
ALTER TABLE public.salon_ai_assistant
  ADD CONSTRAINT salon_ai_assistant_industry_check
  CHECK (industry IN ('beauty', 'barbershop', 'massage', 'cosmetology', 'epilation', 'dental'));
