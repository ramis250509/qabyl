
-- Grant super_admin to the existing first user (if no super_admin exists yet).
-- Guarded so it is a no-op on a fresh project where that user hasn't been created yet (avoids a
-- FK violation on user_roles_user_id_fkey). On such a project the trigger below auto-grants
-- super_admin to the very first signup instead.
INSERT INTO public.user_roles (user_id, role)
SELECT '78e4fe08-6847-4a58-a6c6-f917578d62cf'::uuid, 'super_admin'::app_role
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin')
  AND EXISTS (SELECT 1 FROM auth.users WHERE id = '78e4fe08-6847-4a58-a6c6-f917578d62cf'::uuid);

-- Trigger function: auto-assign super_admin to the very first signup
CREATE OR REPLACE FUNCTION public.assign_first_super_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin') THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'super_admin');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_assign_super_admin ON auth.users;
CREATE TRIGGER on_auth_user_created_assign_super_admin
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.assign_first_super_admin();
