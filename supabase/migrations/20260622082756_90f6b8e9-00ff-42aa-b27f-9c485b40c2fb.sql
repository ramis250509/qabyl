ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_branch_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_branch_role_check
  CHECK (
    (role::text = 'master' AND salon_id IS NOT NULL)
    OR role::text <> 'master'
  );