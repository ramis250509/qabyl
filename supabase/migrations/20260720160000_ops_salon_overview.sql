-- Ops Dashboard: a single super-admin view of the health of EVERY connected salon. Doing this
-- from the browser would be an N+1 storm (one query per salon per metric) that degrades as the
-- platform grows to hundreds/thousands of salons. Instead one server-side aggregate RPC returns
-- the whole table in a single round trip, with all counting pushed into Postgres.
--
-- Access: super-admin only. The function is SECURITY DEFINER (so it can read across all salons,
-- bypassing per-salon RLS) but self-guards with has_role(super_admin) as the first statement —
-- a salon_admin calling it gets 'Forbidden', never another salon's data.

CREATE OR REPLACE FUNCTION public.ops_salon_overview()
RETURNS TABLE(
  salon_id uuid,
  salon_name text,
  whatsapp_enabled boolean,
  ai_enabled boolean,
  engine text,
  has_credentials boolean,
  bookings_7d integer,
  ai_bookings_7d integer,
  no_show_30d integer,
  conversations_7d integer,
  last_activity timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.name,
    COALESCE(s.whatsapp_enabled, false),
    COALESCE(aa.enabled, false),
    COALESCE(aa.engine, 'v3'),
    (sec.greenapi_instance IS NOT NULL AND length(COALESCE(sec.greenapi_instance,'')) > 0
     AND sec.greenapi_token IS NOT NULL AND length(COALESCE(sec.greenapi_token,'')) > 0),
    COALESCE(b.cnt, 0)::int,
    COALESCE(b.ai_cnt, 0)::int,
    COALESCE(ns.cnt, 0)::int,
    COALESCE(conv.cnt7, 0)::int,
    conv.last_at
  FROM salons s
  LEFT JOIN salon_ai_assistant aa ON aa.salon_id = s.id
  LEFT JOIN salon_secrets sec ON sec.salon_id = s.id
  LEFT JOIN LATERAL (
    SELECT count(*) AS cnt,
           count(*) FILTER (WHERE a.source = 'ai_assistant') AS ai_cnt
    FROM appointments a
    WHERE a.salon_id = s.id
      AND a.created_at >= now() - interval '7 days'
      AND a.status <> 'cancelled'
  ) b ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS cnt
    FROM appointments a
    WHERE a.salon_id = s.id
      AND a.status = 'no_show'
      AND a.starts_at >= now() - interval '30 days'
  ) ns ON true
  LEFT JOIN LATERAL (
    SELECT max(c.last_message_at) AS last_at,
           count(*) FILTER (WHERE c.created_at >= now() - interval '7 days') AS cnt7
    FROM wa_conversations c
    WHERE c.salon_id = s.id
  ) conv ON true
  ORDER BY COALESCE(b.cnt, 0) DESC, conv.last_at DESC NULLS LAST, s.name;
END;
$$;

REVOKE ALL ON FUNCTION public.ops_salon_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_salon_overview() TO authenticated;
