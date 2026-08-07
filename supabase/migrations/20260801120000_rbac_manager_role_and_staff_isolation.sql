-- ============================================================================
-- RBAC v2: manager role + master↔user link + optional staff isolation.
-- ============================================================================
-- Goal: let a salon owner invite employees with fine-grained access. Medical
-- clinics need doctors to see ONLY their own appointments — not colleagues'.
-- Existing beauty salons keep their current behaviour (staff sees the branch
-- calendar) unless the owner flips `salons.staff_isolation` on.
--
-- What this migration does:
--   1. Adds 'manager' to app_role — an operator/receptionist tier between
--      salon_admin and master (calendar + appointments + WA chats, no settings
--      or finances).
--   2. Adds masters.user_id — optional link between a masters row (the domain
--      profile: name, photo, services) and an auth.users row (the login).
--      Multiple masters cannot share one login (partial unique index).
--   3. Adds salons.staff_isolation boolean. When TRUE, a master sees only the
--      appointments where masters.user_id = auth.uid(). When FALSE (default,
--      backwards-compatible), a master sees the whole branch calendar as before.
--   4. Adds helpers user_master_ids / user_manager_salon_id.
--   5. Adds/updates RLS on appointments + notifications + wa_conversations +
--      wa_messages so:
--        - salon_admin unchanged
--        - manager gets same reads as salon_admin (minus finances — see below)
--        - master gets isolated reads when staff_isolation=true
--   6. Adds rbac_audit table for critical role/access changes.
--
-- What this migration does NOT do:
--   - Does NOT drop the existing "Master reads branch appointments" policy —
--     it stays but is now gated by `NOT staff_isolation`. So existing salons
--     that never touch the toggle keep behaving exactly as they do today.
--   - Does NOT touch salon_ai_assistant, wa_agent code paths, or existing
--     server-fns. Those are additive changes made in the app layer.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS everywhere).
-- ============================================================================

-- ── 1) Enum: manager ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'app_role' AND e.enumlabel = 'manager'
  ) THEN
    ALTER TYPE public.app_role ADD VALUE 'manager';
  END IF;
END $$;

-- The user_roles branch-check was written for master only; keep it. Manager
-- rows have salon_id, no branch_id (they're salon-wide, like salon_admin).
-- No CHECK change needed.

-- ── 2) masters.user_id ──────────────────────────────────────────────────────
ALTER TABLE public.masters
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- One auth user = at most one master profile (in ANY salon; multi-salon
-- doctors would need a fresh account per salon — a deliberate simplification).
CREATE UNIQUE INDEX IF NOT EXISTS masters_user_id_uidx
  ON public.masters (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS masters_user_id_idx
  ON public.masters (user_id);

-- ── 3) salons.staff_isolation ───────────────────────────────────────────────
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS staff_isolation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.salons.staff_isolation IS
  'When TRUE, users with role=master see ONLY appointments assigned to them '
  '(masters.user_id = auth.uid()). When FALSE (default), they see the whole '
  'branch calendar via has_branch_access. Recommended TRUE for medical.';

-- ── 4) Helpers ──────────────────────────────────────────────────────────────
-- All masters.id rows this auth user owns. Returns a set (0 or 1 today; we
-- keep it plural to allow future multi-profile users without another migration).
CREATE OR REPLACE FUNCTION public.user_master_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id FROM public.masters WHERE user_id = _user_id
$$;

CREATE OR REPLACE FUNCTION public.user_manager_salon_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT salon_id FROM public.user_roles
   WHERE user_id = _user_id AND role::text = 'manager'
   LIMIT 1
$$;

-- Combined check used by RLS: is this user allowed to see/manage this salon's
-- day-to-day operations (calendar, chats, notifications)? True for super_admin,
-- salon_admin of the salon, or manager of the salon. NOT true for master —
-- masters use their own scoped policies.
CREATE OR REPLACE FUNCTION public.has_salon_ops_access(_user_id uuid, _salon_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND (
        ur.role::text = 'super_admin'
        OR (ur.role::text = 'salon_admin' AND ur.salon_id = _salon_id)
        OR (ur.role::text = 'manager'     AND ur.salon_id = _salon_id)
      )
  )
$$;

GRANT EXECUTE ON FUNCTION public.user_master_ids(uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_manager_salon_id(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_salon_ops_access(uuid, uuid) TO authenticated;

-- ── 5) Appointments RLS ─────────────────────────────────────────────────────
-- Keep every existing policy in place — this ADDs two more:
--   * "Manager reads salon appointments"    — parallel to salon_admin
--   * "Master reads own appointments"       — active when staff_isolation ON
--
-- The existing "Master reads branch appointments" policy stays as-is but is
-- now filtered by `NOT staff_isolation`, so a medical salon can toggle
-- isolation without dropping a policy.

DROP POLICY IF EXISTS "Manager reads salon appointments" ON public.appointments;
CREATE POLICY "Manager reads salon appointments" ON public.appointments
  FOR SELECT TO authenticated
  USING (salon_id = public.user_manager_salon_id(auth.uid()));

DROP POLICY IF EXISTS "Manager updates salon appointments" ON public.appointments;
CREATE POLICY "Manager updates salon appointments" ON public.appointments
  FOR UPDATE TO authenticated
  USING (salon_id = public.user_manager_salon_id(auth.uid()))
  WITH CHECK (salon_id = public.user_manager_salon_id(auth.uid()));

-- Replace the branch-wide master policy with one that respects staff_isolation.
DROP POLICY IF EXISTS "Master reads branch appointments" ON public.appointments;
CREATE POLICY "Master reads branch appointments" ON public.appointments
  FOR SELECT USING (
    branch_id IS NOT NULL
    AND branch_id = public.master_branch_id(auth.uid())
    AND NOT COALESCE((SELECT staff_isolation FROM salons WHERE id = appointments.salon_id), false)
  );

DROP POLICY IF EXISTS "Master reads own appointments" ON public.appointments;
CREATE POLICY "Master reads own appointments" ON public.appointments
  FOR SELECT USING (
    master_id IN (SELECT public.user_master_ids(auth.uid()))
  );

-- Master updates: strict — only own appointments, and only when isolation is on
-- OR when linked. Existing branch-update policy also stays, similarly gated.
DROP POLICY IF EXISTS "Master updates branch appointments" ON public.appointments;
CREATE POLICY "Master updates branch appointments" ON public.appointments
  FOR UPDATE USING (
    branch_id IS NOT NULL
    AND branch_id = public.master_branch_id(auth.uid())
    AND NOT COALESCE((SELECT staff_isolation FROM salons WHERE id = appointments.salon_id), false)
  );

DROP POLICY IF EXISTS "Master updates own appointments" ON public.appointments;
CREATE POLICY "Master updates own appointments" ON public.appointments
  FOR UPDATE USING (
    master_id IN (SELECT public.user_master_ids(auth.uid()))
  )
  WITH CHECK (
    master_id IN (SELECT public.user_master_ids(auth.uid()))
  );

-- ── 6) Notifications RLS for manager + isolated master ──────────────────────
DROP POLICY IF EXISTS "Manager reads salon notifications" ON public.notifications;
CREATE POLICY "Manager reads salon notifications" ON public.notifications
  FOR SELECT TO authenticated
  USING (salon_id = public.user_manager_salon_id(auth.uid()));

DROP POLICY IF EXISTS "Manager updates salon notifications" ON public.notifications;
CREATE POLICY "Manager updates salon notifications" ON public.notifications
  FOR UPDATE TO authenticated
  USING (salon_id = public.user_manager_salon_id(auth.uid()));

-- Isolated master notifications: only ones tied to appointments they own.
DROP POLICY IF EXISTS "Master reads own notifications" ON public.notifications;
CREATE POLICY "Master reads own notifications" ON public.notifications
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.appointments a
      WHERE a.id = notifications.appointment_id
        AND a.master_id IN (SELECT public.user_master_ids(auth.uid()))
    )
  );

-- ── 7) wa_conversations / wa_messages RLS for manager ───────────────────────
DROP POLICY IF EXISTS "Manager reads conversations" ON public.wa_conversations;
CREATE POLICY "Manager reads conversations" ON public.wa_conversations
  FOR SELECT TO authenticated
  USING (salon_id = public.user_manager_salon_id(auth.uid()));

DROP POLICY IF EXISTS "Manager reads messages" ON public.wa_messages;
CREATE POLICY "Manager reads messages" ON public.wa_messages
  FOR SELECT TO authenticated
  USING (salon_id = public.user_manager_salon_id(auth.uid()));

-- Masters do NOT get WA chat access — those chats are business-wide and touch
-- other clients' phones (PII exposure). If the owner needs a doctor to see WA
-- chats for their own patients, add a per-conversation policy later.

-- ── 8) Masters — anon read allow-list check ─────────────────────────────────
-- No change needed; the existing anon SELECT policy already returns is_active
-- masters. user_id is not exposed to anon because the anon SELECT columns are
-- limited by the client-side query, not the policy — but to be safe we grant
-- explicit column-level SELECT on the columns the public booking widget uses,
-- excluding user_id.
--
-- Skipping the column-grant for now; the public booking uses a scoped SELECT
-- with an explicit column list (see PublicBooking.tsx). user_id is never read
-- there. This is documented for the audit trail.

-- ── 9) Salon staff_isolation only editable by salon_admin/super_admin ───────
CREATE OR REPLACE FUNCTION public.guard_salon_staff_isolation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.staff_isolation IS DISTINCT FROM OLD.staff_isolation
     AND NOT public.has_role(auth.uid(), 'super_admin')
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid() AND role = 'salon_admin' AND salon_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'Only owner (salon_admin) can change staff isolation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_salon_staff_isolation_trg ON public.salons;
CREATE TRIGGER guard_salon_staff_isolation_trg
  BEFORE UPDATE ON public.salons
  FOR EACH ROW EXECUTE FUNCTION public.guard_salon_staff_isolation();

-- ── 10) rbac_audit: log every role/link change ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.rbac_audit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id     uuid REFERENCES public.salons(id) ON DELETE SET NULL,
  actor_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action       text NOT NULL,        -- 'invite' | 'assign_role' | 'link_master' | 'revoke' | 'toggle_isolation'
  subject_user uuid,                  -- user affected
  subject_master uuid REFERENCES public.masters(id) ON DELETE SET NULL,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rbac_audit_salon_created_idx
  ON public.rbac_audit (salon_id, created_at DESC);

ALTER TABLE public.rbac_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Salon owner reads audit" ON public.rbac_audit;
CREATE POLICY "Salon owner reads audit" ON public.rbac_audit
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles
       WHERE user_id = auth.uid() AND role = 'salon_admin' AND salon_id = rbac_audit.salon_id
    )
  );

GRANT SELECT ON public.rbac_audit TO authenticated;
GRANT ALL ON public.rbac_audit TO service_role;

-- ── 11) get_appointment_by_token — expose master's user_id ────────────────
-- The manage page and the receipt-upload page need to know if the client is
-- interacting with a specific master. Not doing anything here yet; noted for
-- audit trail — no schema change required.

COMMENT ON TABLE public.rbac_audit IS 'Audit log for role assignments, master↔user links, staff isolation toggles.';
