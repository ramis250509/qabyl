-- 1) Drop the old create_appointment overload (without _branch_id)
DROP FUNCTION IF EXISTS public.create_appointment(uuid, uuid, uuid, timestamptz, text, text, text);

-- 2) Notifications table for admin events
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Salon staff can read notifications"
  ON public.notifications FOR SELECT
  TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

CREATE POLICY "Salon staff can update notifications"
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

CREATE POLICY "Service role inserts notifications"
  ON public.notifications FOR INSERT
  TO authenticated
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

CREATE INDEX IF NOT EXISTS notifications_salon_created_idx
  ON public.notifications (salon_id, created_at DESC);

-- 3) Trigger: create a notification on new / cancelled appointments
CREATE OR REPLACE FUNCTION public.notify_appointment_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _service_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT name INTO _service_name FROM services WHERE id = NEW.service_id;
    INSERT INTO public.notifications (salon_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.id, 'appointment.created',
      'Новая запись от клиента',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE 'UTC', 'DD.MM HH24:MI')
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    INSERT INTO public.notifications (salon_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.id, 'appointment.cancelled',
      'Клиент отменил запись',
      COALESCE(NEW.client_name,'Клиент') || ' отменил(а) запись'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_appointment_event_trg ON public.appointments;
CREATE TRIGGER notify_appointment_event_trg
  AFTER INSERT OR UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.notify_appointment_event();

-- 4) Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;