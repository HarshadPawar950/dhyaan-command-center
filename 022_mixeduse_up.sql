-- =============================================================
-- 022_mixeduse_up.sql — MIXED-USE projects (Residential + Commercial together)
-- + per-category (res_/com_) sheet detailing.
-- ADDITIVE. Two boolean flags replace the single project category enum as the
-- source of truth (old `category` enum KEPT, deprecated, for rollback).
-- Per-category Configuration + Pricing-rate fields get res_/com_ variants so a
-- MIXED project stores both sheets at once. All new cols nullable/defaulted →
-- the 1 real project row (uncategorized) survives untouched.
--   • CHECK is NOT VALID: enforced on NEW writes only; existing rows not forced.
--   • properties.category enum is UNCHANGED (a unit is strictly one category).
-- =============================================================
BEGIN;

-- ---------- Mixed-use flags (new source of truth) ----------
ALTER TABLE private.projects
  ADD COLUMN IF NOT EXISTS has_residential boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_commercial  boolean NOT NULL DEFAULT false;

-- ---------- Per-category Configuration + Pricing-rate columns ----------
ALTER TABLE private.projects
  -- Configuration (per sheet)
  ADD COLUMN IF NOT EXISTS res_smallest_unit_area numeric,
  ADD COLUMN IF NOT EXISTS com_smallest_unit_area numeric,
  ADD COLUMN IF NOT EXISTS res_largest_unit_area  numeric,
  ADD COLUMN IF NOT EXISTS com_largest_unit_area  numeric,
  ADD COLUMN IF NOT EXISTS res_unit_condition     text,
  ADD COLUMN IF NOT EXISTS com_unit_condition     text,
  ADD COLUMN IF NOT EXISTS res_config             text,   -- residential BHK / unit mix
  ADD COLUMN IF NOT EXISTS com_config             text,   -- commercial office/shop config (replaces office_configuration)
  ADD COLUMN IF NOT EXISTS res_vastu              text,   -- residential-only per gate ruling
  -- Pricing rates (per sheet — rates differ res vs comm)
  ADD COLUMN IF NOT EXISTS res_psf_rate           numeric,
  ADD COLUMN IF NOT EXISTS com_psf_rate           numeric,
  ADD COLUMN IF NOT EXISTS res_floor_rise_price   numeric,
  ADD COLUMN IF NOT EXISTS com_floor_rise_price   numeric,
  ADD COLUMN IF NOT EXISTS res_market_rate_psf    numeric,
  ADD COLUMN IF NOT EXISTS com_market_rate_psf    numeric,
  ADD COLUMN IF NOT EXISTS res_roi_rental_note    text,
  ADD COLUMN IF NOT EXISTS com_roi_rental_note    text;

-- ---------- Backfill flags from the deprecated single enum ----------
UPDATE private.projects
   SET has_residential = (category = 'residential'),
       has_commercial  = (category = 'commercial')
 WHERE category IS NOT NULL;

-- ---------- Backfill per-category values into the matching side (rollback fidelity) ----------
UPDATE private.projects SET
    res_smallest_unit_area = CASE WHEN category='residential' THEN smallest_unit_area   END,
    com_smallest_unit_area = CASE WHEN category='commercial'  THEN smallest_unit_area   END,
    res_largest_unit_area  = CASE WHEN category='residential' THEN largest_unit_area    END,
    com_largest_unit_area  = CASE WHEN category='commercial'  THEN largest_unit_area    END,
    res_unit_condition     = CASE WHEN category='residential' THEN unit_condition       END,
    com_unit_condition     = CASE WHEN category='commercial'  THEN unit_condition       END,
    com_config             = CASE WHEN category='commercial'  THEN office_configuration END,
    res_vastu              = CASE WHEN category='residential' THEN vastu                END,
    res_psf_rate           = CASE WHEN category='residential' THEN psf_rate             END,
    com_psf_rate           = CASE WHEN category='commercial'  THEN psf_rate             END,
    res_floor_rise_price   = CASE WHEN category='residential' THEN floor_rise_price     END,
    com_floor_rise_price   = CASE WHEN category='commercial'  THEN floor_rise_price     END,
    res_market_rate_psf    = CASE WHEN category='residential' THEN market_rate_psf      END,
    com_market_rate_psf    = CASE WHEN category='commercial'  THEN market_rate_psf      END,
    res_roi_rental_note    = CASE WHEN category='residential' THEN roi_rental_note      END,
    com_roi_rental_note    = CASE WHEN category='commercial'  THEN roi_rental_note      END
 WHERE category IS NOT NULL;

-- ---------- "At least one category" — enforced on NEW writes only ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_has_one_category') THEN
    ALTER TABLE private.projects
      ADD CONSTRAINT projects_has_one_category
      CHECK (has_residential OR has_commercial) NOT VALID;
  END IF;
END $$;

COMMIT;
