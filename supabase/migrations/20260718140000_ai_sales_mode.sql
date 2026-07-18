-- "Salesperson mode" for the AI assistant. When enabled, the V4 ("живой диалог") agent
-- proactively drives the conversation toward a booking — assumptive close, objection handling,
-- honest urgency — instead of only answering questions. Off by default so existing salons keep
-- their current, softer behaviour. Consumed in src/lib/wa-agent-v4.server.ts (buildSystemPromptV4).
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS sales_mode boolean NOT NULL DEFAULT false;
