
-- 1) Restrict master_day_overrides SELECT policy to authenticated role only
DROP POLICY IF EXISTS "Master reads branch day overrides" ON public.master_day_overrides;
CREATE POLICY "Master reads branch day overrides"
  ON public.master_day_overrides FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.masters m
    WHERE m.id = master_day_overrides.master_id
      AND m.branch_id = public.master_branch_id(auth.uid())
  ));

-- 2) Restrict master_time_off SELECT policy to authenticated role only
DROP POLICY IF EXISTS "Master reads branch time off" ON public.master_time_off;
CREATE POLICY "Master reads branch time off"
  ON public.master_time_off FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.masters m
    WHERE m.id = master_time_off.master_id
      AND m.branch_id = public.master_branch_id(auth.uid())
  ));

-- 3) Tighten push_subscriptions: forbid null user_id and require user_id = auth.uid()
DROP POLICY IF EXISTS "push_subs_self_manage" ON public.push_subscriptions;
CREATE POLICY "push_subs_self_manage"
  ON public.push_subscriptions FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Clean up any pre-existing rows with null user_id created under the old permissive policy
DELETE FROM public.push_subscriptions WHERE user_id IS NULL;
