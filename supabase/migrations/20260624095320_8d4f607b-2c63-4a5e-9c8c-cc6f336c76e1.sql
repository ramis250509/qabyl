
DROP POLICY IF EXISTS "Master reads branch appointments" ON public.appointments;
DROP POLICY IF EXISTS "Master updates branch appointments" ON public.appointments;

CREATE POLICY "Master reads salon appointments"
ON public.appointments
FOR SELECT
TO authenticated
USING (
  salon_id = public.master_salon_id(auth.uid())
  AND (
    branch_id IS NULL
    OR branch_id = public.master_branch_id(auth.uid())
  )
);

CREATE POLICY "Master updates salon appointments"
ON public.appointments
FOR UPDATE
TO authenticated
USING (
  salon_id = public.master_salon_id(auth.uid())
  AND (
    branch_id IS NULL
    OR branch_id = public.master_branch_id(auth.uid())
  )
)
WITH CHECK (
  salon_id = public.master_salon_id(auth.uid())
  AND (
    branch_id IS NULL
    OR branch_id = public.master_branch_id(auth.uid())
  )
);
