-- Add salon_admin role
ALTER TYPE app_role ADD VALUE IF NOT EXISTS 'salon_admin';

-- Add owner notification phone
ALTER TABLE public.salons ADD COLUMN IF NOT EXISTS owner_notify_phone text;