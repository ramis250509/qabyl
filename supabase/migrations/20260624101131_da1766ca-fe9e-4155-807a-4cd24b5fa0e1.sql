DROP POLICY IF EXISTS "Master reads branch appointments" ON public.appointments;
DROP POLICY IF EXISTS "Master reads scoped appointments" ON public.appointments;

CREATE POLICY "Master reads scoped appointments"
ON public.appointments
FOR SELECT
TO authenticated
USING (
  salon_id = public.master_salon_id(auth.uid())
  AND (
    (
      public.master_branch_id(auth.uid()) IS NOT NULL
      AND branch_id = public.master_branch_id(auth.uid())
    )
    OR (
      public.master_branch_id(auth.uid()) IS NULL
      AND branch_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.branches b
        WHERE b.salon_id = appointments.salon_id
          AND b.is_active = true
      )
    )
  )
);