-- Multi-branch AI Admin: let a super-admin pin ONE salon's assistant to a single branch.
--
-- CONTEXT: a salon's WhatsApp assistant today is ONE identity (one Green-API number, one
-- salon_ai_assistant row) that dynamically asks a multi-branch client "which branch?" mid-chat.
-- For a salon like "Аксакал" that wants this number to represent exactly ONE physical location
-- (or wants to eliminate the extra back-and-forth entirely), pinning removes the ambiguity at
-- the source: the assistant is handed exactly one branch from turn zero, so it never has reason
-- to mention another branch's masters, schedule, services availability, slots or appointments.
--
-- This column is the ONLY schema change needed: masters/schedule/slots/appointments are already
-- scoped by branch_id (see masters.branch_id, appointments.branch_id) — pinning just tells the
-- webhook which branch_id to force for the whole conversation instead of asking the client.
-- Nullable + defaults to NULL, so every existing salon keeps today's dynamic multi-branch
-- behavior unchanged until an admin explicitly opts in.
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS assistant_branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_salon_ai_assistant_branch ON public.salon_ai_assistant(assistant_branch_id);
