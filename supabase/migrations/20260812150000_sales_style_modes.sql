-- ============================================================================
-- Two named sales modes instead of one boolean.
-- ============================================================================
-- salon_ai_assistant.sales_mode was a checkbox: off = answer questions, on =
-- "push harder". Owners could not tell what either end actually did, and the
-- off state had no doctrine of its own — it was simply the absence of the
-- active one.
--
-- New model, two explicit styles:
--   'light'  — консультирует мягко, ведёт к записи только когда это следует
--              из диалога. Default.
--   'active' — диагностирует потребность, работает с состоянием клиента и
--              возражениями, доводит до записи и (если она есть) предоплаты.
--
-- Backfill runs ONCE, guarded on the column not existing yet: sales_mode=true
-- becomes 'active', everything else 'light'. Re-running the migration must not
-- undo an owner who later switched back — hence the guard rather than a plain
-- idempotent UPDATE.
--
-- sales_mode stays in the table and is kept in sync by the admin panel
-- (sales_mode = style = 'active'). Nothing reads it in the app any more, but
-- dropping a column that four release-trains of code touched buys nothing.
-- ============================================================================

DO $$
DECLARE
  col_existed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'salon_ai_assistant'
      AND column_name = 'sales_style'
  ) INTO col_existed;

  IF NOT col_existed THEN
    ALTER TABLE public.salon_ai_assistant
      ADD COLUMN sales_style text NOT NULL DEFAULT 'light';

    UPDATE public.salon_ai_assistant
      SET sales_style = 'active'
      WHERE sales_mode IS TRUE;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE public.salon_ai_assistant
    ADD CONSTRAINT salon_ai_assistant_sales_style_chk
    CHECK (sales_style IN ('light', 'active'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.salon_ai_assistant.sales_style IS
  'Sales behaviour of the assistant: light (soft consulting, default) or
   active (need diagnosis, objection work, drives to booking/prepayment).
   Replaces the legacy sales_mode boolean, which the admin panel keeps in
   sync for backwards compatibility.';
