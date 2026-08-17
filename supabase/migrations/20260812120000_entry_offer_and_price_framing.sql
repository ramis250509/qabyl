-- Two-step selling for high-ticket services.
--
-- THE PROBLEM THIS SOLVES
-- -----------------------
-- A clinic sells a 20 000 som three-month programme. A lead asks "how much?", the assistant
-- answers "20 000", and the lead disappears. The number is not the problem — quoting it as the
-- thing to buy RIGHT NOW is. Nobody commits twenty thousand som to a stranger in a DM before
-- anyone has looked at them.
--
-- The fix is the oldest one in high-ticket selling: sell the small first step, let the
-- specialist sell the big thing in person. Both columns here exist so that behaviour is
-- CONFIGURED per business rather than hardcoded, because it is exactly wrong for a barbershop
-- where the service asked about IS the service booked.
--
-- entry_service_id  — the service the assistant routes to. NULL (default) = today's behaviour:
--                     book whatever the client asked about.
-- sales_price_framing — the owner's own words for explaining what a big number covers. Free
--                     text, injected verbatim, so the assistant never does the arithmetic (or
--                     invents an instalment plan) on its own.

ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS entry_service_id uuid
    REFERENCES public.services(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sales_price_framing text;

COMMENT ON COLUMN public.salon_ai_assistant.entry_service_id IS
  'The cheap first step the assistant sells (a consultation), instead of pitching the expensive back-end service in chat. NULL = book whatever the client asked about.';

COMMENT ON COLUMN public.salon_ai_assistant.sales_price_framing IS
  'Owner-written explanation of what a large price covers, injected verbatim when price is on the table. Never generated, so the assistant cannot invent a discount or a payment plan.';
