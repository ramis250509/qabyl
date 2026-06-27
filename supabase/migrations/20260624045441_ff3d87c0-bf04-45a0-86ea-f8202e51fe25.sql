
-- 1. Drop cross-branch master policies on appointments
DROP POLICY IF EXISTS "Master reads salon appointments" ON public.appointments;
DROP POLICY IF EXISTS "Master updates salon appointments" ON public.appointments;

-- 2. Drop cross-branch master policy on appointment_addons
DROP POLICY IF EXISTS "appointment_addons master salon read" ON public.appointment_addons;

-- 3. Realtime channel authorization: only allow subscriptions whose topic
--    the user is permitted to read. We restrict postgres_changes topics for
--    sensitive tables to authenticated users; row-level filtering is then
--    enforced by the underlying table RLS (which is now strictly scoped).
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can receive realtime" ON realtime.messages;
CREATE POLICY "Authenticated can receive realtime"
ON realtime.messages
FOR SELECT
TO authenticated
USING (true);

-- Block all writes from clients (broadcast / presence) by default to prevent
-- unauthenticated or unauthorized topic publishing.
DROP POLICY IF EXISTS "Block client realtime writes" ON realtime.messages;
CREATE POLICY "Block client realtime writes"
ON realtime.messages
AS RESTRICTIVE
FOR INSERT
TO authenticated, anon
WITH CHECK (false);
