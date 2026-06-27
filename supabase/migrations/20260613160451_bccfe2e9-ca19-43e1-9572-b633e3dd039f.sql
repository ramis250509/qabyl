
-- Phase 3: Master role with shared per-branch login

-- 1. Add 'master' to app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'master';

-- 2. Add branch_id to user_roles
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE;

-- Master must have a branch_id; super/salon admins must not
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_branch_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_branch_role_check
  CHECK (
    (role::text = 'master' AND branch_id IS NOT NULL AND salon_id IS NOT NULL)
    OR (role::text <> 'master')
  );

CREATE INDEX IF NOT EXISTS user_roles_branch_id_idx ON public.user_roles(branch_id);

-- 3. Branch-access helper (super, salon admin for that salon, or master for that branch)
CREATE OR REPLACE FUNCTION public.has_branch_access(_user_id uuid, _branch_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    LEFT JOIN public.branches b ON b.id = _branch_id
    WHERE ur.user_id = _user_id
      AND (
        ur.role::text = 'super_admin'
        OR (ur.role::text = 'salon_admin' AND ur.salon_id = b.salon_id)
        OR (ur.role::text = 'master' AND ur.branch_id = _branch_id)
      )
  )
$$;

-- Helper: is the user a master (used to scope reads to their salon)
CREATE OR REPLACE FUNCTION public.master_salon_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT salon_id FROM public.user_roles
   WHERE user_id = _user_id AND role::text = 'master'
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.master_branch_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT branch_id FROM public.user_roles
   WHERE user_id = _user_id AND role::text = 'master'
   LIMIT 1
$$;

-- 4. RLS policies for master role

-- appointments: scoped to own branch
DROP POLICY IF EXISTS "Master reads branch appointments" ON public.appointments;
CREATE POLICY "Master reads branch appointments" ON public.appointments
  FOR SELECT USING (branch_id IS NOT NULL AND branch_id = public.master_branch_id(auth.uid()));

DROP POLICY IF EXISTS "Master updates branch appointments" ON public.appointments;
CREATE POLICY "Master updates branch appointments" ON public.appointments
  FOR UPDATE USING (branch_id IS NOT NULL AND branch_id = public.master_branch_id(auth.uid()));

-- notifications: scoped via the linked appointment's branch
DROP POLICY IF EXISTS "Master reads branch notifications" ON public.notifications;
CREATE POLICY "Master reads branch notifications" ON public.notifications
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.appointments a
      WHERE a.id = notifications.appointment_id
        AND a.branch_id = public.master_branch_id(auth.uid())
    )
  );

DROP POLICY IF EXISTS "Master updates branch notifications" ON public.notifications;
CREATE POLICY "Master updates branch notifications" ON public.notifications
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.appointments a
      WHERE a.id = notifications.appointment_id
        AND a.branch_id = public.master_branch_id(auth.uid())
    )
  );

-- branches: master sees own branch
DROP POLICY IF EXISTS "Master reads own branch" ON public.branches;
CREATE POLICY "Master reads own branch" ON public.branches
  FOR SELECT USING (id = public.master_branch_id(auth.uid()));

-- masters: master sees colleagues in same branch (for filter dropdown)
DROP POLICY IF EXISTS "Master reads branch masters" ON public.masters;
CREATE POLICY "Master reads branch masters" ON public.masters
  FOR SELECT USING (branch_id = public.master_branch_id(auth.uid()));

-- services: master reads salon services (needed for appointment cards)
DROP POLICY IF EXISTS "Master reads salon services" ON public.services;
CREATE POLICY "Master reads salon services" ON public.services
  FOR SELECT USING (salon_id = public.master_salon_id(auth.uid()));

-- salons: master reads own salon (for timezone/branding)
DROP POLICY IF EXISTS "Master reads own salon" ON public.salons;
CREATE POLICY "Master reads own salon" ON public.salons
  FOR SELECT USING (id = public.master_salon_id(auth.uid()));

-- master_schedules / services / day_overrides / time_off: read for branch masters
DROP POLICY IF EXISTS "Master reads branch schedules" ON public.master_schedules;
CREATE POLICY "Master reads branch schedules" ON public.master_schedules
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.masters m
    WHERE m.id = master_schedules.master_id
      AND m.branch_id = public.master_branch_id(auth.uid())
  ));

DROP POLICY IF EXISTS "Master reads branch master_services" ON public.master_services;
CREATE POLICY "Master reads branch master_services" ON public.master_services
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.masters m
    WHERE m.id = master_services.master_id
      AND m.branch_id = public.master_branch_id(auth.uid())
  ));

DROP POLICY IF EXISTS "Master reads branch day overrides" ON public.master_day_overrides;
CREATE POLICY "Master reads branch day overrides" ON public.master_day_overrides
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.masters m
    WHERE m.id = master_day_overrides.master_id
      AND m.branch_id = public.master_branch_id(auth.uid())
  ));

DROP POLICY IF EXISTS "Master reads branch time off" ON public.master_time_off;
CREATE POLICY "Master reads branch time off" ON public.master_time_off
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.masters m
    WHERE m.id = master_time_off.master_id
      AND m.branch_id = public.master_branch_id(auth.uid())
  ));
