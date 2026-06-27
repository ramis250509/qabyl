
-- 1. Drop the old buggy master policies (no salon scoping)
DROP POLICY IF EXISTS "Master reads branch notifications" ON public.notifications;
DROP POLICY IF EXISTS "Master updates branch notifications" ON public.notifications;

-- 2. Master SELECT: strictly scoped to master's salon AND branch
CREATE POLICY "Master reads salon notifications"
ON public.notifications
FOR SELECT
TO authenticated
USING (
  salon_id = public.master_salon_id(auth.uid())
  AND (
    public.master_branch_id(auth.uid()) IS NULL  -- salon-level master sees all branches of their salon
    OR notifications.branch_id IS NULL            -- salon-wide notifications
    OR notifications.branch_id = public.master_branch_id(auth.uid())
  )
);

-- 3. Master UPDATE (mark read): same scope
CREATE POLICY "Master updates salon notifications"
ON public.notifications
FOR UPDATE
TO authenticated
USING (
  salon_id = public.master_salon_id(auth.uid())
  AND (
    public.master_branch_id(auth.uid()) IS NULL
    OR notifications.branch_id IS NULL
    OR notifications.branch_id = public.master_branch_id(auth.uid())
  )
)
WITH CHECK (
  salon_id = public.master_salon_id(auth.uid())
  AND (
    public.master_branch_id(auth.uid()) IS NULL
    OR notifications.branch_id IS NULL
    OR notifications.branch_id = public.master_branch_id(auth.uid())
  )
);

-- 4. RESTRICTIVE policy: if a notification targets a specific branch,
--    even salon_admin must belong to that salon (which has_salon_access already enforces),
--    and branch-scoped masters can only see their own branch.
--    This guarantees no permissive policy can ever leak cross-branch data to branch-bound masters.
CREATE POLICY "Branch-scoped notifications stay in branch (masters)"
ON public.notifications
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (
  -- If user is a branch-bound master, the notification's branch_id (if any) must match
  public.master_branch_id(auth.uid()) IS NULL
  OR notifications.branch_id IS NULL
  OR notifications.branch_id = public.master_branch_id(auth.uid())
)
WITH CHECK (
  public.master_branch_id(auth.uid()) IS NULL
  OR notifications.branch_id IS NULL
  OR notifications.branch_id = public.master_branch_id(auth.uid())
);

-- 5. RESTRICTIVE policy: master must belong to the salon
CREATE POLICY "Masters cannot cross salons"
ON public.notifications
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (
  public.master_salon_id(auth.uid()) IS NULL  -- not a master, skip
  OR salon_id = public.master_salon_id(auth.uid())
)
WITH CHECK (
  public.master_salon_id(auth.uid()) IS NULL
  OR salon_id = public.master_salon_id(auth.uid())
);
