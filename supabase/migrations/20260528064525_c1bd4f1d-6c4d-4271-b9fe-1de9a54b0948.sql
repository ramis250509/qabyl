
DROP FUNCTION IF EXISTS public.get_salon_by_host(text);

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS site_template text NOT NULL DEFAULT 'minimal',
  ADD COLUMN IF NOT EXISTS site_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS hero_title text,
  ADD COLUMN IF NOT EXISTS hero_subtitle text,
  ADD COLUMN IF NOT EXISTS hero_image_url text,
  ADD COLUMN IF NOT EXISTS about_text text,
  ADD COLUMN IF NOT EXISTS gallery_images text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS instagram_url text,
  ADD COLUMN IF NOT EXISTS tiktok_url text,
  ADD COLUMN IF NOT EXISTS whatsapp_url text,
  ADD COLUMN IF NOT EXISTS telegram_url text,
  ADD COLUMN IF NOT EXISTS lat numeric,
  ADD COLUMN IF NOT EXISTS lng numeric,
  ADD COLUMN IF NOT EXISTS working_hours jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salons_site_template_check') THEN
    ALTER TABLE public.salons ADD CONSTRAINT salons_site_template_check
      CHECK (site_template IN ('minimal','premium','vivid'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.salon_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  salon_id uuid NOT NULL,
  client_name text NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text text,
  is_published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_salon_reviews_salon ON public.salon_reviews(salon_id, is_published, created_at DESC);

GRANT SELECT ON public.salon_reviews TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.salon_reviews TO authenticated;
GRANT ALL ON public.salon_reviews TO service_role;

ALTER TABLE public.salon_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public reads published reviews" ON public.salon_reviews;
CREATE POLICY "Public reads published reviews"
  ON public.salon_reviews FOR SELECT
  USING (is_published = true OR has_salon_access(auth.uid(), salon_id) OR has_role(auth.uid(), 'super_admin'::app_role));

DROP POLICY IF EXISTS "Salon admin manages reviews" ON public.salon_reviews;
CREATE POLICY "Salon admin manages reviews"
  ON public.salon_reviews FOR ALL TO authenticated
  USING (has_salon_access(auth.uid(), salon_id))
  WITH CHECK (has_salon_access(auth.uid(), salon_id));

DROP POLICY IF EXISTS "Super admin manages reviews" ON public.salon_reviews;
CREATE POLICY "Super admin manages reviews"
  ON public.salon_reviews FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'super_admin'::app_role));

CREATE OR REPLACE FUNCTION public.get_salon_by_host(_host text)
 RETURNS TABLE(
   id uuid, slug text, name text, custom_domain text, description text, address text, phone text, timezone text,
   brand_primary text, brand_accent text, logo_url text,
   site_template text, site_enabled boolean,
   hero_title text, hero_subtitle text, hero_image_url text,
   about_text text, gallery_images text[],
   instagram_url text, tiktok_url text, whatsapp_url text, telegram_url text,
   lat numeric, lng numeric, working_hours jsonb
 )
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT id, slug, name, custom_domain, description, address, phone, timezone,
         brand_primary, brand_accent, logo_url,
         site_template, site_enabled,
         hero_title, hero_subtitle, hero_image_url,
         about_text, gallery_images,
         instagram_url, tiktok_url, whatsapp_url, telegram_url,
         lat, lng, working_hours
  FROM salons
  WHERE is_active = true AND (custom_domain = _host OR custom_domain = lower(_host))
  LIMIT 1;
$function$;

INSERT INTO storage.buckets (id, name, public) VALUES ('salon-media', 'salon-media', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public reads salon media" ON storage.objects;
CREATE POLICY "Public reads salon media"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'salon-media');

DROP POLICY IF EXISTS "Salon admin uploads salon media" ON storage.objects;
CREATE POLICY "Salon admin uploads salon media"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'salon-media'
    AND has_salon_access(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Salon admin updates salon media" ON storage.objects;
CREATE POLICY "Salon admin updates salon media"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'salon-media'
    AND has_salon_access(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Salon admin deletes salon media" ON storage.objects;
CREATE POLICY "Salon admin deletes salon media"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'salon-media'
    AND has_salon_access(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );
