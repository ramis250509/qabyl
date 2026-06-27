DROP FUNCTION IF EXISTS public.get_salon_by_host(text);
CREATE FUNCTION public.get_salon_by_host(_host text)
 RETURNS TABLE(id uuid, slug text, name text, custom_domain text, description text, address text, phone text, timezone text, brand_primary text, brand_accent text, logo_url text, site_template text, site_enabled boolean, hero_title text, hero_subtitle text, hero_image_url text, about_text text, gallery_images text[], instagram_url text, tiktok_url text, whatsapp_url text, telegram_url text, lat numeric, lng numeric, working_hours jsonb, custom_html text, multilang_enabled boolean, whatsapp_enabled boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id, slug, name, custom_domain, description, address, phone, timezone,
         brand_primary, brand_accent, logo_url, site_template, site_enabled,
         hero_title, hero_subtitle, hero_image_url, about_text, gallery_images,
         instagram_url, tiktok_url, whatsapp_url, telegram_url, lat, lng, working_hours, custom_html,
         multilang_enabled, whatsapp_enabled
  FROM salons WHERE is_active = true AND (custom_domain = _host OR custom_domain = lower(_host)) LIMIT 1;
$function$;