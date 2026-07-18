-- Add the "medical" vertical (general multi-specialty clinic) to the allowed AI-assistant
-- industries. The knowledge book, persona and hard medical boundaries live in code
-- (src/lib/industries.ts + src/lib/wa-industries.server.ts); this only widens the DB CHECK so
-- a salon can be saved with industry='medical'. Without this, saving that vertical in the admin
-- panel fails the salon_ai_assistant_industry_check constraint.

ALTER TABLE public.salon_ai_assistant
  DROP CONSTRAINT IF EXISTS salon_ai_assistant_industry_check;

ALTER TABLE public.salon_ai_assistant
  ADD CONSTRAINT salon_ai_assistant_industry_check
  CHECK (industry IN ('beauty', 'barbershop', 'massage', 'cosmetology', 'epilation', 'dental', 'medical'));
