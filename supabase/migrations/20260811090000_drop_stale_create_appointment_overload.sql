-- ============================================================================
-- Remove the stale 12-argument create_appointment overload.
--
-- WHAT BROKE: creating an appointment from the admin calendar failed with
--   Could not choose the best candidate function between:
--     public.create_appointment(… _duration_override_min => integer),
--     public.create_appointment(… _duration_override_min => integer,
--                               _hold_minutes => integer)
--
-- ROOT CAUSE: 20260807120000 added the _hold_minutes parameter using
-- CREATE OR REPLACE FUNCTION. In Postgres a function's signature includes its
-- argument list, so adding a parameter does NOT replace the old function — it
-- creates a SECOND overload alongside it. That migration dropped the old
-- create_appointment_with_prepayment (line 179) but never dropped the old
-- create_appointment, so both have existed side by side ever since.
--
-- Two overloads are only a problem for a NAMED-argument caller. PostgREST calls
-- RPCs by name, and a call passing the 11 columns the admin calendar sends
-- matches both candidates equally: the 12-arg one exactly, and the 13-arg one
-- with _hold_minutes defaulted. Postgres refuses to guess. Callers that pass
-- arguments POSITIONALLY (create_appointment_with_prepayment, which passes all
-- 13) were never ambiguous, which is why the prepayment path kept working and
-- hid the problem.
--
-- WHY IT SURFACED ONLY NOW: PostgREST answers from a cached copy of the schema.
-- The ambiguity entered the database when 20260807120000 was applied, but the
-- running PostgREST kept serving an older cache that knew a single overload.
-- Migration 20260810120000 ended with NOTIFY pgrst, 'reload schema' — a routine
-- step so new tables become visible — and that reload is what made PostgREST
-- see both overloads and start refusing the call.
--
-- THE FIX: drop the 12-argument version. The 13-argument one is a strict
-- superset — _hold_minutes defaults to NULL, which is the no-hold behaviour the
-- old function had — so every existing caller keeps working unchanged:
--   * PostgREST/named callers resolve to the single remaining overload;
--   * create_appointment_with_prepayment passes 13 positional args as before.
--
-- Verified before dropping: create_appointment_with_prepayment is the only
-- routine in the database whose body references create_appointment.
--
-- Idempotent.
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_appointment(
  uuid, uuid, uuid, timestamptz, text, text, text, uuid, uuid[], text, numeric, int
);

-- The surviving overload must stay callable by the booking widget (anon) and by
-- the admin panel (authenticated). Re-granting is harmless if already granted,
-- and protects against the case where the drop above removed the only version a
-- previous GRANT had targeted.
GRANT EXECUTE ON FUNCTION public.create_appointment(
  uuid, uuid, uuid, timestamptz, text, text, text, uuid, uuid[], text, numeric, int, int
) TO anon, authenticated;

-- Make PostgREST forget the ambiguous pair immediately instead of at its next
-- scheduled reload.
NOTIFY pgrst, 'reload schema';
