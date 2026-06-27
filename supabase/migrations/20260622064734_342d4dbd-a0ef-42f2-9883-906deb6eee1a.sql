DROP TRIGGER IF EXISTS dispatch_whatsapp_on_appointment_insert ON public.appointments;
DROP TRIGGER IF EXISTS notify_appointment_event_trg ON public.appointments;
DROP TRIGGER IF EXISTS trg_appointment_break_guard ON public.appointments;
DROP TRIGGER IF EXISTS trg_guard_appointment_restore ON public.appointments;
DROP TRIGGER IF EXISTS guard_salon_whatsapp_enabled ON public.salons;