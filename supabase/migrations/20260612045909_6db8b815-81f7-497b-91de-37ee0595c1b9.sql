GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Public-readable tables (anon needs read access for the booking site)
GRANT SELECT ON public.salons, public.branches, public.masters, public.services, public.master_schedules, public.master_services, public.master_time_off, public.salon_reviews TO anon;

-- Authenticated (salon admins / super admins) manage their data; RLS still applies
GRANT SELECT, INSERT, UPDATE, DELETE ON public.salons, public.branches, public.masters, public.services, public.master_schedules, public.master_services, public.master_time_off, public.salon_reviews, public.appointments, public.notifications, public.salon_secrets, public.user_roles TO authenticated;
GRANT SELECT ON public.appointment_archives TO authenticated;

-- Service role full access
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- Functions and sequences
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;