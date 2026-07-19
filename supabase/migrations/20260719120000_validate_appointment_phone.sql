-- Server-side, bypass-proof phone validation on appointment creation. The public booking widget
-- enforces a strict KG format on the frontend, but a direct call to create_appointment (via
-- DevTools or a scripted request) previously only had to pass a length 5–20 check — junk like
-- "abc" or a 3-digit number got through. This BEFORE INSERT trigger rejects any appointment whose
-- phone, once stripped to digits, isn't a plausible international number (10–15 digits).
--
-- It is intentionally LENIENT: WhatsApp bookings store digits without a leading "+", and can be
-- from any country (KZ 7701…, RU 79…), so a KG-strict rule here would break them. The strict
-- "+996 + 9 digits" rule lives on the public site widget instead. This trigger only exists to
-- stop gross garbage from any insert path (site widget, admin dialog, WhatsApp agent).
CREATE OR REPLACE FUNCTION public.validate_appointment_phone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _digits text;
BEGIN
  _digits := regexp_replace(COALESCE(NEW.client_phone, ''), '[^0-9]', '', 'g');
  IF length(_digits) < 10 OR length(_digits) > 15 THEN
    RAISE EXCEPTION 'Некорректный номер телефона'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_appointment_phone_trg ON public.appointments;
CREATE TRIGGER validate_appointment_phone_trg
  BEFORE INSERT ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.validate_appointment_phone();
