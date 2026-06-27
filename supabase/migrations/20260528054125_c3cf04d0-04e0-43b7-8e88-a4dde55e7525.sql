
-- Recreate view with security_invoker so it respects caller's permissions
DROP VIEW IF EXISTS public.salons_public;
CREATE VIEW public.salons_public WITH (security_invoker = true) AS
SELECT id, slug, name, custom_domain, description, address, phone, timezone,
       brand_primary, brand_accent, logo_url, is_active
FROM public.salons
WHERE is_active = true;
GRANT SELECT ON public.salons_public TO anon, authenticated;

-- Allow anon to read base salon info needed for public booking (without credentials column access)
-- We'll keep RLS but allow public to read non-sensitive columns via separate policy.
-- Simpler: allow anon SELECT on salons but restrict columns via column-level grants.
REVOKE ALL ON public.salons FROM anon;
GRANT SELECT (id, slug, name, custom_domain, description, address, phone, timezone, brand_primary, brand_accent, logo_url, is_active) ON public.salons TO anon;

-- Add policy so anon can actually SELECT (RLS still blocks otherwise)
CREATE POLICY "Public reads active salons" ON public.salons FOR SELECT TO anon, authenticated
  USING (is_active = true);
