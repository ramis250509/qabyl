
CREATE POLICY "Salon admins read wa-media"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'wa-media'
    AND public.has_salon_access(
      auth.uid(),
      NULLIF((storage.foldername(name))[1], '')::uuid
    )
  );
