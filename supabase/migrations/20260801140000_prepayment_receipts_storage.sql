-- ============================================================================
-- Private storage bucket for prepayment receipts.
-- Path layout:
--   <salon_id>/<appointment_id>/<uuid>.<ext>
-- Server-fn uploads only (service role), so no anon INSERT policy is needed.
-- Signed URLs are minted server-side with a 5-min TTL for the admin viewer.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('prepayment-receipts', 'prepayment-receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Salon admins can read files that live under their own salon prefix.
-- The bucket is private; this policy governs storage.objects (Supabase's
-- built-in table).
DROP POLICY IF EXISTS "Salon admin reads own prepayment receipts" ON storage.objects;
CREATE POLICY "Salon admin reads own prepayment receipts" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'prepayment-receipts'
    AND (
      public.has_role(auth.uid(), 'super_admin')
      OR (
        (storage.foldername(name))[1] IS NOT NULL
        AND public.has_salon_access(
          auth.uid(),
          ((storage.foldername(name))[1])::uuid
        )
      )
    )
  );

-- Managers get read access too (they may need to view a receipt while helping
-- a client during a call).
DROP POLICY IF EXISTS "Manager reads own prepayment receipts" ON storage.objects;
CREATE POLICY "Manager reads own prepayment receipts" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'prepayment-receipts'
    AND (storage.foldername(name))[1] IS NOT NULL
    AND ((storage.foldername(name))[1])::uuid = public.user_manager_salon_id(auth.uid())
  );
