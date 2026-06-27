
DROP TRIGGER IF EXISTS appointments_guard_break ON public.appointments;
DROP TRIGGER IF EXISTS appointments_guard_restore ON public.appointments;
DROP TRIGGER IF EXISTS appointments_notify_event ON public.appointments;
DROP TRIGGER IF EXISTS appointments_dispatch_whatsapp_ins ON public.appointments;
DROP TRIGGER IF EXISTS appointments_dispatch_whatsapp_upd ON public.appointments;
DROP TRIGGER IF EXISTS notifications_dispatch_push ON public.notifications;
DROP TRIGGER IF EXISTS salons_guard_whatsapp_enabled ON public.salons;

CREATE TRIGGER appointments_guard_break
  BEFORE INSERT OR UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.guard_appointment_break();

CREATE TRIGGER appointments_guard_restore
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.guard_appointment_restore();

CREATE TRIGGER appointments_notify_event
  AFTER INSERT OR UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.notify_appointment_event();

CREATE TRIGGER appointments_dispatch_whatsapp_ins
  AFTER INSERT ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_whatsapp_confirmation();

CREATE TRIGGER appointments_dispatch_whatsapp_upd
  AFTER UPDATE OF status, starts_at ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_whatsapp_confirmation();

CREATE TRIGGER notifications_dispatch_push
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_push_for_notification();

CREATE TRIGGER salons_guard_whatsapp_enabled
  BEFORE UPDATE ON public.salons
  FOR EACH ROW EXECUTE FUNCTION public.guard_salon_whatsapp_enabled();
