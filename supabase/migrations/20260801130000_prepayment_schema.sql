-- ============================================================================
-- Prepayment system: schema, hold semantics, TTL, receipt dedup.
-- ============================================================================
-- Design summary (from the audit conversation):
--   * Prepayment is opt-in per salon (prepayment_settings.enabled).
--   * When enabled, `create_appointment` writes status='pending_payment' with
--     hold_expires_at = now() + settings.hold_minutes. The slot is BLOCKED
--     from that first moment (get_available_slots and the appointment-conflict
--     check both count pending_payment as busy).
--   * If the receipt is verified before hold_expires_at → status flips to
--     'confirmed'. If not → status flips to 'payment_expired' by a 1-min
--     pg_cron job; the slot becomes free again.
--   * Every receipt has a sha256 (raw file) AND a txn_id (from the parsed
--     receipt). Reusing either across appointments = rejected.
--   * A public token flow (reuses appointments.manage_token) lets an anon
--     upload a receipt without logging in.
--
-- What this migration does NOT do:
--   * Does NOT change existing rows (all get status='confirmed' as they were).
--   * Does NOT change appointments columns except through additive changes to
--     the status enum + create_appointment RPC.
--   * Does NOT touch salon_ai_assistant, wa_agent tables, or notifications.
--
-- Idempotent.
-- ============================================================================

-- ── 1) Extend appointment_status enum ───────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'appointment_status' AND e.enumlabel = 'pending_payment'
  ) THEN
    ALTER TYPE public.appointment_status ADD VALUE 'pending_payment';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'appointment_status' AND e.enumlabel = 'payment_expired'
  ) THEN
    ALTER TYPE public.appointment_status ADD VALUE 'payment_expired';
  END IF;
END $$;

-- ── 2) appointments.hold_expires_at ─────────────────────────────────────────
-- Where the TTL job looks. NULL for anything that isn't held for prepayment.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS appointments_hold_expires_idx
  ON public.appointments (hold_expires_at)
  WHERE status = 'pending_payment';

-- ── 3) prepayment_settings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prepayment_settings (
  salon_id             uuid PRIMARY KEY REFERENCES public.salons(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  -- 'fixed' → amount is the flat KGS to charge; 'percent' → amount is 1..100 of service.price
  amount_type          text    NOT NULL DEFAULT 'fixed' CHECK (amount_type IN ('fixed','percent')),
  amount_value         numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount_value >= 0),
  min_amount           numeric(10,2),
  max_amount           numeric(10,2),
  currency             text    NOT NULL DEFAULT 'KGS' CHECK (currency IN ('KGS','USD','RUB','KZT','EUR')),
  hold_minutes         int     NOT NULL DEFAULT 30 CHECK (hold_minutes BETWEEN 5 AND 720),
  -- 'auto' → verified receipt auto-confirms; 'auto_under_amount' → auto only up to auto_max_amount;
  -- 'manual_after_verify' → always requires manual admin OK; 'manual_always' → never auto-verify.
  verify_mode          text    NOT NULL DEFAULT 'auto' CHECK (verify_mode IN ('auto','auto_under_amount','manual_after_verify','manual_always')),
  auto_max_amount      numeric(10,2),
  recipient_name       text,
  -- Free-form JSON: {"phone":"+996...", "card":"...", "bank":"MBANK"}. Server-fn shapes it.
  recipient_details    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  instruction_ru       text,
  instruction_ky       text,
  instruction_en       text,
  -- Room for future per-service / per-master overrides without a new migration.
  overrides            jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.prepayment_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Salon owner reads prepayment settings" ON public.prepayment_settings;
CREATE POLICY "Salon owner reads prepayment settings" ON public.prepayment_settings
  FOR SELECT TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

DROP POLICY IF EXISTS "Salon owner writes prepayment settings" ON public.prepayment_settings;
CREATE POLICY "Salon owner writes prepayment settings" ON public.prepayment_settings
  FOR ALL TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id))
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.prepayment_settings TO authenticated;
GRANT ALL ON public.prepayment_settings TO service_role;

DROP TRIGGER IF EXISTS trg_prepayment_settings_touch ON public.prepayment_settings;
CREATE TRIGGER trg_prepayment_settings_touch
  BEFORE UPDATE ON public.prepayment_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 4) appointment_prepayments — 1:1 with the appointment ───────────────────
CREATE TABLE IF NOT EXISTS public.appointment_prepayments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id     uuid NOT NULL UNIQUE REFERENCES public.appointments(id) ON DELETE CASCADE,
  salon_id           uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  expected_amount    numeric(10,2) NOT NULL,
  currency           text NOT NULL DEFAULT 'KGS',
  hold_expires_at    timestamptz NOT NULL,
  -- Lifecycle:
  --   waiting_upload → chek not received yet
  --   uploaded       → chek in storage, awaiting parse
  --   processing     → verify pipeline running
  --   verified       → passed all checks
  --   manual_review  → needs a human (some field missed / low confidence)
  --   rejected       → hard fail (wrong recipient, duplicate, etc.)
  --   expired        → hold ran out, no receipt in time
  status             text NOT NULL DEFAULT 'waiting_upload' CHECK (status IN
    ('waiting_upload','uploaded','processing','verified','manual_review','rejected','expired')),
  -- Storage path (private bucket "prepayment-receipts"). Never a signed URL.
  receipt_path       text,
  receipt_mime       text,
  receipt_bytes      int,
  -- What the parser extracted. Fields depend on bank; kept as jsonb.
  extracted          jsonb,
  -- Which bank adapter parsed it. NULL if not detected.
  bank               text,
  confidence         numeric(4,3),                 -- 0..1
  verdict            text CHECK (verdict IN ('verified','manual_review','rejected')),
  verdict_reasons    text[],
  -- If a human decided, who + when + what
  reviewed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at        timestamptz,
  review_note        text,
  -- Anti-fraud markers
  file_sha256        text,
  file_phash         text,                          -- perceptual hash (images only)
  txn_id             text,
  -- Refund flag when a confirmed prepayment is cancelled. Refund is manual.
  refund_status      text CHECK (refund_status IN ('none','requested','done')) DEFAULT 'none',
  refund_note        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_prepayments_salon_status_idx
  ON public.appointment_prepayments (salon_id, status);

CREATE INDEX IF NOT EXISTS appointment_prepayments_hold_exp_idx
  ON public.appointment_prepayments (hold_expires_at)
  WHERE status IN ('waiting_upload','uploaded','processing','manual_review');

ALTER TABLE public.appointment_prepayments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops reads prepayments" ON public.appointment_prepayments;
CREATE POLICY "Ops reads prepayments" ON public.appointment_prepayments
  FOR SELECT TO authenticated
  USING (
    public.has_salon_access(auth.uid(), salon_id)
    OR salon_id = public.user_manager_salon_id(auth.uid())
  );

DROP POLICY IF EXISTS "Salon admin manages prepayments" ON public.appointment_prepayments;
CREATE POLICY "Salon admin manages prepayments" ON public.appointment_prepayments
  FOR ALL TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id))
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

GRANT SELECT ON public.appointment_prepayments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointment_prepayments TO authenticated;
GRANT ALL ON public.appointment_prepayments TO service_role;

DROP TRIGGER IF EXISTS trg_appointment_prepayments_touch ON public.appointment_prepayments;
CREATE TRIGGER trg_appointment_prepayments_touch
  BEFORE UPDATE ON public.appointment_prepayments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 5) prepayment_receipt_hashes — global anti-reuse (per salon) ────────────
-- A file OR a txn_id may not be used twice for the same salon. Cross-salon
-- reuse is allowed intentionally: a customer paying two different businesses
-- from the same card will legitimately have different txns anyway.
CREATE TABLE IF NOT EXISTS public.prepayment_receipt_hashes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id       uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  file_sha256    text,
  file_phash     text,
  txn_id         text,
  bank           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS receipt_hashes_salon_sha_uidx
  ON public.prepayment_receipt_hashes (salon_id, file_sha256)
  WHERE file_sha256 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS receipt_hashes_salon_txn_uidx
  ON public.prepayment_receipt_hashes (salon_id, txn_id)
  WHERE txn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS receipt_hashes_phash_idx
  ON public.prepayment_receipt_hashes (salon_id, file_phash);

ALTER TABLE public.prepayment_receipt_hashes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Salon admin reads hashes" ON public.prepayment_receipt_hashes;
CREATE POLICY "Salon admin reads hashes" ON public.prepayment_receipt_hashes
  FOR SELECT TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));
-- Writes are service_role only (server-fn during verify).

GRANT SELECT ON public.prepayment_receipt_hashes TO authenticated;
GRANT ALL ON public.prepayment_receipt_hashes TO service_role;

-- ── 6) prepayment_audit — every state change ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prepayment_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE CASCADE,
  salon_id       uuid REFERENCES public.salons(id) ON DELETE SET NULL,
  actor_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_kind     text NOT NULL CHECK (actor_kind IN ('system','admin','manager','client_via_token','wa_agent')),
  action         text NOT NULL,       -- 'created','uploaded','verified','manual_review','rejected','expired','confirmed','refund_requested'
  detail         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prepayment_audit_appt_idx
  ON public.prepayment_audit (appointment_id, created_at DESC);

ALTER TABLE public.prepayment_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Salon admin reads prepayment audit" ON public.prepayment_audit;
CREATE POLICY "Salon admin reads prepayment audit" ON public.prepayment_audit
  FOR SELECT TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

GRANT SELECT ON public.prepayment_audit TO authenticated;
GRANT ALL ON public.prepayment_audit TO service_role;

-- ── 7) Update get_available_slots and create_appointment — hold counts as busy
-- get_available_slots's conflict check runs on `status = 'confirmed'`. That
-- would let two people book the same slot while one is holding it. Widen the
-- check to include pending_payment.
CREATE OR REPLACE FUNCTION public.get_available_slots(
  _master_id uuid,
  _service_id uuid,
  _date date
)
RETURNS TABLE(slot_start timestamptz, slot_end timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _duration int;
  _tz text;
  _wd smallint;
  _sched record;
  _slot_start timestamptz;
  _slot_end timestamptz;
  _step interval := interval '15 minutes';
BEGIN
  SELECT duration_min INTO _duration FROM services WHERE id = _service_id AND is_active = true;
  IF _duration IS NULL THEN RETURN; END IF;

  SELECT s.timezone INTO _tz FROM masters m JOIN salons s ON s.id = m.salon_id WHERE m.id = _master_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;

  _wd := EXTRACT(DOW FROM _date)::smallint;

  FOR _sched IN
    SELECT start_time, end_time FROM master_schedules
    WHERE master_id = _master_id AND weekday = _wd
    ORDER BY start_time
  LOOP
    _slot_start := ((_date::text || ' ' || _sched.start_time::text)::timestamp AT TIME ZONE _tz);
    LOOP
      _slot_end := _slot_start + (_duration || ' minutes')::interval;
      EXIT WHEN _slot_end > ((_date::text || ' ' || _sched.end_time::text)::timestamp AT TIME ZONE _tz);

      IF _slot_start <= now() THEN
        _slot_start := _slot_start + _step;
        CONTINUE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.master_id = _master_id
          AND a.status IN ('confirmed', 'pending_payment')  -- NEW: hold counts as busy
          AND a.starts_at < _slot_end
          AND a.ends_at > _slot_start
      )
      AND NOT EXISTS (
        SELECT 1 FROM master_time_off t
        WHERE t.master_id = _master_id
          AND t.starts_at < _slot_end
          AND t.ends_at > _slot_start
      )
      THEN
        slot_start := _slot_start;
        slot_end := _slot_end;
        RETURN NEXT;
      END IF;

      _slot_start := _slot_start + _step;
    END LOOP;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_available_slots(uuid, uuid, date) TO anon, authenticated;

-- ── 8) create_appointment_with_prepayment — new RPC ─────────────────────────
-- The existing create_appointment stays untouched — anyone booking without
-- prepayment continues to hit it. When the site/WA agent knows prepayment is
-- required, it calls the new RPC below, which:
--   1. Validates as before (master/service/salon match, slot free).
--   2. Rejects if prepayment_settings.enabled=false (caller confusion guard).
--   3. Computes expected_amount from settings + service.price.
--   4. Writes the appointment as status='pending_payment' with hold_expires_at.
--   5. Writes the paired appointment_prepayments row.
--   6. Returns { appointment_id, prepayment_id, amount, currency, hold_expires_at, token }.
CREATE OR REPLACE FUNCTION public.create_appointment_with_prepayment(
  _salon_id     uuid,
  _master_id    uuid,
  _service_id   uuid,
  _starts_at    timestamptz,
  _client_name  text,
  _client_phone text,
  _client_notes text DEFAULT NULL,
  _branch_id    uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _duration int; _buffer int; _svc_price numeric; _ends_at timestamptz; _block_end timestamptz;
  _new_id uuid; _mb uuid;
  _cfg record;
  _amount numeric;
  _hold_until timestamptz;
  _prepay_id uuid;
  _token uuid;
BEGIN
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN
    RAISE EXCEPTION 'Invalid client name';
  END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN
    RAISE EXCEPTION 'Invalid client phone';
  END IF;

  SELECT duration_min, COALESCE(buffer_after_min,0), price
    INTO _duration, _buffer, _svc_price
   FROM services
   WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  SELECT branch_id INTO _mb FROM masters WHERE id = _master_id AND salon_id = _salon_id AND is_active = true;
  IF NOT EXISTS (
    SELECT 1 FROM masters m
    JOIN master_services ms ON ms.master_id = m.id
    WHERE m.id = _master_id AND m.salon_id = _salon_id AND m.is_active = true
      AND ms.service_id = _service_id
  ) THEN RAISE EXCEPTION 'Master cannot perform this service'; END IF;
  IF _branch_id IS NOT NULL AND _mb IS NOT NULL AND _mb <> _branch_id THEN
    RAISE EXCEPTION 'Master does not work at this branch';
  END IF;

  _ends_at   := _starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at   + (_buffer   || ' minutes')::interval;

  IF _starts_at <= now() THEN RAISE EXCEPTION 'Cannot book in the past'; END IF;

  -- Slot conflict — INCLUDING pending_payment holds
  IF EXISTS (
    SELECT 1 FROM appointments
    WHERE master_id = _master_id
      AND status IN ('confirmed','pending_payment')
      AND starts_at < _block_end AND ends_at > _starts_at
  ) THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  -- Prepayment must be configured
  SELECT * INTO _cfg FROM prepayment_settings WHERE salon_id = _salon_id;
  IF _cfg.salon_id IS NULL OR NOT _cfg.enabled THEN
    RAISE EXCEPTION 'Prepayment is not enabled for this salon';
  END IF;

  -- Compute expected amount
  IF _cfg.amount_type = 'fixed' THEN
    _amount := _cfg.amount_value;
  ELSE
    _amount := ROUND(_svc_price * _cfg.amount_value / 100.0, 2);
  END IF;
  IF _cfg.min_amount IS NOT NULL AND _amount < _cfg.min_amount THEN _amount := _cfg.min_amount; END IF;
  IF _cfg.max_amount IS NOT NULL AND _amount > _cfg.max_amount THEN _amount := _cfg.max_amount; END IF;
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Prepayment amount misconfigured (got %)', _amount;
  END IF;

  _hold_until := now() + (_cfg.hold_minutes || ' minutes')::interval;

  INSERT INTO appointments(
    salon_id, master_id, service_id, client_name, client_phone, client_notes,
    starts_at, ends_at, price, branch_id, status, hold_expires_at
  ) VALUES (
    _salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes,
    _starts_at, _ends_at, _svc_price, COALESCE(_branch_id, _mb),
    'pending_payment', _hold_until
  )
  RETURNING id, manage_token INTO _new_id, _token;

  INSERT INTO appointment_prepayments(
    appointment_id, salon_id, expected_amount, currency, hold_expires_at
  ) VALUES (
    _new_id, _salon_id, _amount, _cfg.currency, _hold_until
  )
  RETURNING id INTO _prepay_id;

  INSERT INTO prepayment_audit(appointment_id, salon_id, actor_kind, action, detail)
  VALUES (_new_id, _salon_id, 'system', 'created',
          jsonb_build_object('amount', _amount, 'currency', _cfg.currency, 'hold_until', _hold_until));

  RETURN jsonb_build_object(
    'appointment_id', _new_id,
    'prepayment_id',  _prepay_id,
    'amount',         _amount,
    'currency',       _cfg.currency,
    'hold_expires_at',_hold_until,
    'manage_token',   _token
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_appointment_with_prepayment(uuid,uuid,uuid,timestamptz,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_appointment_with_prepayment(uuid,uuid,uuid,timestamptz,text,text,text,uuid) TO anon, authenticated;

-- ── 9) Public token → prepayment status snapshot ────────────────────────────
-- The public booking page and the WA client-manage link both call this to
-- render "waiting for payment" / "verified" / "rejected". No auth needed.
CREATE OR REPLACE FUNCTION public.get_prepayment_by_token(_token uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  SELECT
    ap.id             AS appointment_id,
    ap.salon_id,
    ap.starts_at,
    ap.status         AS appt_status,
    p.id              AS prepayment_id,
    p.expected_amount,
    p.currency,
    p.status          AS pp_status,
    p.verdict,
    p.verdict_reasons,
    p.hold_expires_at,
    s.name            AS salon_name,
    ps.recipient_name,
    ps.recipient_details,
    ps.instruction_ru,
    ps.instruction_ky,
    ps.instruction_en,
    ps.hold_minutes,
    sv.name           AS service_name,
    m.name            AS master_name
  INTO r
  FROM appointments ap
  JOIN salons s   ON s.id  = ap.salon_id
  JOIN services sv ON sv.id = ap.service_id
  JOIN masters m  ON m.id  = ap.master_id
  LEFT JOIN appointment_prepayments p ON p.appointment_id = ap.id
  LEFT JOIN prepayment_settings ps    ON ps.salon_id = ap.salon_id
  WHERE ap.manage_token = _token;

  IF r.appointment_id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'appointment_id',   r.appointment_id,
    'salon_id',         r.salon_id,
    'salon_name',       r.salon_name,
    'starts_at',        r.starts_at,
    'appt_status',      r.appt_status,
    'service_name',     r.service_name,
    'master_name',      r.master_name,
    'amount',           r.expected_amount,
    'currency',         r.currency,
    'status',           r.pp_status,
    'verdict',          r.verdict,
    'verdict_reasons',  r.verdict_reasons,
    'hold_expires_at',  r.hold_expires_at,
    'recipient_name',   r.recipient_name,
    'recipient_details',r.recipient_details,
    'instruction_ru',   r.instruction_ru,
    'instruction_ky',   r.instruction_ky,
    'instruction_en',   r.instruction_en,
    'hold_minutes',     r.hold_minutes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_prepayment_by_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_prepayment_by_token(uuid) TO anon, authenticated;

-- ── 10) TTL expirer — every minute ──────────────────────────────────────────
-- Anything with status='pending_payment' whose hold_expires_at is in the past
-- becomes 'payment_expired' (frees the slot). The paired prepayment goes to
-- 'expired' too. Audit entry for each.
CREATE OR REPLACE FUNCTION public.prepayment_expire_holds()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE r RECORD; cnt integer := 0;
BEGIN
  FOR r IN
    SELECT id, salon_id FROM appointments
     WHERE status = 'pending_payment'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at < now()
     LIMIT 200
  LOOP
    UPDATE appointments SET status = 'payment_expired' WHERE id = r.id;
    UPDATE appointment_prepayments
       SET status = 'expired'
     WHERE appointment_id = r.id
       AND status IN ('waiting_upload','uploaded','processing','manual_review');
    INSERT INTO prepayment_audit(appointment_id, salon_id, actor_kind, action)
    VALUES (r.id, r.salon_id, 'system', 'expired');
    cnt := cnt + 1;
  END LOOP;
  RETURN cnt;
END;
$$;

-- pg_cron schedule (only if the extension is present — it is on Frankfurt).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'prepayment_expire_holds';
    PERFORM cron.schedule(
      'prepayment_expire_holds',
      '* * * * *',
      $cron$ SELECT public.prepayment_expire_holds(); $cron$
    );
  END IF;
END $$;

-- ── 11) confirm_prepayment RPC (called by the verify pipeline on 'verified')
-- Flips the appointment to confirmed. Meant to be called by service-role only.
CREATE OR REPLACE FUNCTION public.confirm_prepayment(_appointment_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _st appointment_status; _salon uuid;
BEGIN
  SELECT status, salon_id INTO _st, _salon FROM appointments WHERE id = _appointment_id;
  IF _st IS NULL THEN RAISE EXCEPTION 'Appointment not found'; END IF;
  IF _st = 'confirmed' THEN RETURN; END IF;
  IF _st NOT IN ('pending_payment') THEN
    RAISE EXCEPTION 'Cannot confirm from status %', _st;
  END IF;
  UPDATE appointments
     SET status = 'confirmed', hold_expires_at = NULL
   WHERE id = _appointment_id AND status = 'pending_payment';
  INSERT INTO prepayment_audit(appointment_id, salon_id, actor_kind, action)
  VALUES (_appointment_id, _salon, 'system', 'confirmed');
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_prepayment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_prepayment(uuid) TO authenticated;

-- ── 12) Notify trigger tolerance ────────────────────────────────────────────
-- The existing notify_appointment_event trigger inserts a "Новая запись"
-- notification on INSERT. For pending_payment, that would notify the salon
-- about a booking that might expire. Skip it — the "payment verified" flow
-- will insert its own notification when confirmed.
CREATE OR REPLACE FUNCTION public.notify_appointment_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _service_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending_payment' THEN
      RETURN NEW; -- silent while awaiting prepayment
    END IF;
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
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending_payment' AND NEW.status = 'confirmed' THEN
    SELECT name INTO _service_name FROM services WHERE id = NEW.service_id;
    INSERT INTO public.notifications (salon_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.id, 'appointment.created',
      'Новая запись с оплатой',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE 'UTC', 'DD.MM HH24:MI') || ' (оплачено)'
    );
  END IF;
  RETURN NEW;
END;
$$;

-- ── 13) Booking dedup index — extend to include pending_payment ────────────
-- The existing appointments_active_dedup_uidx (from 20260728) only covers
-- 'confirmed'. Extend it so a client cannot spam-create two prepayment holds
-- for the same slot with the same phone.
DROP INDEX IF EXISTS public.appointments_active_prepay_dedup_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS appointments_active_prepay_dedup_uidx
  ON public.appointments (salon_id, client_phone, service_id, master_id, starts_at)
  WHERE status IN ('confirmed','pending_payment');
