DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname, conrelid::regclass AS tbl
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'public.masters'::regclass
      AND conrelid IN (
        'public.appointments'::regclass,
        'public.master_schedules'::regclass,
        'public.master_services'::regclass,
        'public.master_day_overrides'::regclass,
        'public.master_time_off'::regclass
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_master_id_fkey FOREIGN KEY (master_id) REFERENCES public.masters(id) ON DELETE CASCADE;
ALTER TABLE public.master_schedules
  ADD CONSTRAINT master_schedules_master_id_fkey FOREIGN KEY (master_id) REFERENCES public.masters(id) ON DELETE CASCADE;
ALTER TABLE public.master_services
  ADD CONSTRAINT master_services_master_id_fkey FOREIGN KEY (master_id) REFERENCES public.masters(id) ON DELETE CASCADE;
ALTER TABLE public.master_day_overrides
  ADD CONSTRAINT master_day_overrides_master_id_fkey FOREIGN KEY (master_id) REFERENCES public.masters(id) ON DELETE CASCADE;
ALTER TABLE public.master_time_off
  ADD CONSTRAINT master_time_off_master_id_fkey FOREIGN KEY (master_id) REFERENCES public.masters(id) ON DELETE CASCADE;