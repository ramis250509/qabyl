ALTER TABLE public.appointments REPLICA IDENTITY FULL;
ALTER TABLE public.appointment_addons REPLICA IDENTITY FULL;
DO $$ BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.appointments; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.appointment_addons; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;