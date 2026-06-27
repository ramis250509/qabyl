UPDATE public.push_subscriptions ps
SET salon_id = ur.salon_id
FROM public.user_roles ur
WHERE ps.user_id = ur.user_id
  AND ps.salon_id IS NULL
  AND ur.salon_id IS NOT NULL;