-- Master rating + years of experience for the public booking widget's specialist cards.
--
-- Architecture note (forward-compatible with real reviews, per the requirement that adding
-- real per-master reviews later must NOT require reworking this): `salon_reviews` today is
-- salon-wide (no master_id) — a review can't yet be tied to a specific master, so there is no
-- real per-master signal to average. `masters.rating` is the manual value an admin sets now.
-- Adding `salon_reviews.master_id` (nullable) here means the moment a review form starts
-- collecting which master a review is about, the widget's existing "prefer real reviews, else
-- manual rating" logic (implemented client-side in PublicBooking, see rating.ts) starts
-- computing a real average automatically — no schema change needed at that point.
ALTER TABLE public.masters
  ADD COLUMN IF NOT EXISTS rating numeric(2,1),
  ADD COLUMN IF NOT EXISTS experience_years smallint;

ALTER TABLE public.masters DROP CONSTRAINT IF EXISTS masters_rating_ck;
ALTER TABLE public.masters
  ADD CONSTRAINT masters_rating_ck CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5));

ALTER TABLE public.masters DROP CONSTRAINT IF EXISTS masters_experience_years_ck;
ALTER TABLE public.masters
  ADD CONSTRAINT masters_experience_years_ck CHECK (experience_years IS NULL OR (experience_years BETWEEN 0 AND 80));

-- Future-proofing for real per-master reviews (see note above). Nullable + ON DELETE SET NULL:
-- existing reviews are unaffected, and deleting a master never deletes their reviews.
ALTER TABLE public.salon_reviews
  ADD COLUMN IF NOT EXISTS master_id uuid REFERENCES public.masters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_salon_reviews_master ON public.salon_reviews(master_id) WHERE master_id IS NOT NULL;
