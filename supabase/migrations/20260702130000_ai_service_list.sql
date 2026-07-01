-- Custom service list for the WhatsApp AI assistant: category order/visibility lives on
-- salon_ai_assistant (mirrors salons.category_order / collapsed_categories, which drive the
-- public booking widget instead), per-service order/enable lives in ai_service_overrides.
-- Absence of an override row means "use the Услуги defaults" — admins only write a row when
-- they actually customize something.
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS ai_category_order text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_hidden_categories text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.ai_service_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  is_enabled boolean NOT NULL DEFAULT true,
  sort_order integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, service_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_service_overrides TO authenticated;
GRANT ALL ON public.ai_service_overrides TO service_role;

ALTER TABLE public.ai_service_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Salon admins read ai service overrides"
  ON public.ai_service_overrides FOR SELECT TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

CREATE POLICY "Salon admins insert ai service overrides"
  ON public.ai_service_overrides FOR INSERT TO authenticated
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

CREATE POLICY "Salon admins update ai service overrides"
  ON public.ai_service_overrides FOR UPDATE TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id))
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

CREATE POLICY "Salon admins delete ai service overrides"
  ON public.ai_service_overrides FOR DELETE TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id));

CREATE TRIGGER ai_service_overrides_touch
  BEFORE UPDATE ON public.ai_service_overrides
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
