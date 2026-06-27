
-- 1) collapsed categories list on salons
ALTER TABLE public.salons ADD COLUMN IF NOT EXISTS collapsed_categories text[] NOT NULL DEFAULT '{}';

-- 2) Ensure slug is unique
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='salons_slug_unique_idx'
  ) THEN
    CREATE UNIQUE INDEX salons_slug_unique_idx ON public.salons (slug);
  END IF;
END $$;

-- 3) FAQ table
CREATE TABLE IF NOT EXISTS public.salon_faqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.salon_faqs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.salon_faqs TO authenticated;
GRANT ALL ON public.salon_faqs TO service_role;

ALTER TABLE public.salon_faqs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "FAQs are public" ON public.salon_faqs FOR SELECT USING (true);
CREATE POLICY "Salon staff manage FAQs" ON public.salon_faqs
  FOR ALL TO authenticated
  USING (public.has_salon_access(auth.uid(), salon_id))
  WITH CHECK (public.has_salon_access(auth.uid(), salon_id));

CREATE TRIGGER salon_faqs_touch BEFORE UPDATE ON public.salon_faqs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS salon_faqs_salon_idx ON public.salon_faqs(salon_id, sort_order);
