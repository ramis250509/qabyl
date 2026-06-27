
-- Tighten master update policies with WITH CHECK and restrict role scope to authenticated

-- 1. Appointments: master update needs WITH CHECK
DROP POLICY IF EXISTS "Master updates branch appointments" ON public.appointments;
CREATE POLICY "Master updates branch appointments"
ON public.appointments
FOR UPDATE
TO authenticated
USING (branch_id IS NOT NULL AND branch_id = public.master_branch_id(auth.uid()))
WITH CHECK (branch_id IS NOT NULL AND branch_id = public.master_branch_id(auth.uid()));

-- 2. Notifications: master update needs WITH CHECK
DROP POLICY IF EXISTS "Master updates branch notifications" ON public.notifications;
CREATE POLICY "Master updates branch notifications"
ON public.notifications
FOR UPDATE
TO authenticated
USING (
  branch_id IS NOT NULL AND branch_id = public.master_branch_id(auth.uid())
)
WITH CHECK (
  branch_id IS NOT NULL AND branch_id = public.master_branch_id(auth.uid())
);

-- 3. Tighten role scope on policies using has_salon_access — keep them functionally identical but TO authenticated
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, roles
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('appointment_addons','service_addons','notifications','appointments','services','masters','master_services','branches','salon_faqs','salons','user_roles','master_day_overrides','master_time_off','master_schedules','appointment_archives')
      AND 'public' = ANY(roles)
  LOOP
    -- Skip explicit public-read policies for booking widget (anon needs SELECT)
    IF r.policyname ILIKE '%Public%' OR r.policyname ILIKE '%anon%' OR r.policyname ILIKE '%public reads%' THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated', r.policyname, r.tablename);
  END LOOP;
END $$;
