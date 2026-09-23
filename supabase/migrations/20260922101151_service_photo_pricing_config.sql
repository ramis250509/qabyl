-- Prices derived from photos used to be authored by a vision model without salon-specific
-- criteria. Store per-service structured rules so the model classifies only visible attributes
-- and the server calculates the price; NULL keeps existing service data untouched.
alter table public.services
  add column if not exists photo_pricing_config jsonb;

comment on column public.services.photo_pricing_config is
  'Optional per-service photo criteria and prices. NULL/disabled means no photo quote.';
