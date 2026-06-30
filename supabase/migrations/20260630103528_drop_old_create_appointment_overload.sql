-- Drop the old 9-param overload that lacks _source and _price_override.
-- The new 11-param version (added in 20260626155544) already exists;
-- PostgreSQL can't resolve named-param calls when two overloads match.
DROP FUNCTION IF EXISTS public.create_appointment(
  uuid, uuid, uuid,
  timestamp with time zone,
  text, text, text,
  uuid,
  uuid[]
);
