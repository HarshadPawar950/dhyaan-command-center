-- =============================================================
-- Migration 027 — Property field upgrades + Leads Client Profile
--
-- PART 1 (private.properties): Carpet vs Sellable area split, Address Details,
--   ROI/Rental note, Sell/Rent listing toggle, Parking redesign.
--   Status "Pre-Lease" is code-only (status_of_property is TEXT).
-- PART 2 (private.leads): optional Client Profile fields, wired into the matcher.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS). Non-destructive backfills.
-- =============================================================
BEGIN;

-- ===== PART 1: private.properties =====
ALTER TABLE private.properties
  ADD COLUMN IF NOT EXISTS sellable_area     numeric,           -- 1.2 primary area ("Sellable Area", ex "Unit Area")
  ADD COLUMN IF NOT EXISTS address_details   text,              -- 1.3 full address (Location group)
  ADD COLUMN IF NOT EXISTS roi_rental_note   text,              -- 1.6 mirrors projects.roi_rental_note
  ADD COLUMN IF NOT EXISTS listing_sale      boolean DEFAULT true,   -- 1.5 Sell
  ADD COLUMN IF NOT EXISTS listing_rent      boolean DEFAULT false,  -- 1.5 Rent (both tickable)
  ADD COLUMN IF NOT EXISTS parking_available boolean,           -- 1.7 Yes/No
  ADD COLUMN IF NOT EXISTS parking_type      text,              -- 1.7 covered | open (when Yes)
  ADD COLUMN IF NOT EXISTS parking_count     int;               -- 1.7 count (when Yes)
-- 1.1 Carpet Area reuses the existing carpet_area column (name now matches label).

-- Backfill: existing carpet_area held the one displayed area -> Sellable Area.
-- Non-destructive (carpet_area kept as a starting point; corrected per-row in UI).
UPDATE private.properties
   SET sellable_area = carpet_area
 WHERE sellable_area IS NULL AND carpet_area IS NOT NULL;

-- Backfill parking model from legacy covered/open counts.
UPDATE private.properties
   SET parking_available = true,
       parking_count     = COALESCE(covered_parking,0) + COALESCE(open_parking,0),
       parking_type      = CASE WHEN COALESCE(covered_parking,0) > 0 THEN 'covered' ELSE 'open' END
 WHERE (COALESCE(covered_parking,0) + COALESCE(open_parking,0)) > 0
   AND parking_available IS NULL;

-- ===== PART 2: private.leads — Client Profile (all optional) =====
ALTER TABLE private.leads
  ADD COLUMN IF NOT EXISTS cp_configuration   text[],   -- 2.1 residential/commercial (multi)
  ADD COLUMN IF NOT EXISTS cp_use             text,     -- 2.2 end_user | investor
  ADD COLUMN IF NOT EXISTS cp_possession_pref text[],   -- 2.3 ready_to_move|under_construction|pre_launch (multi)
  ADD COLUMN IF NOT EXISTS cp_funding         text,     -- 2.4 self | loan | cash
  ADD COLUMN IF NOT EXISTS cp_down_payment    numeric,  -- 2.4 down payment amount
  ADD COLUMN IF NOT EXISTS cp_budget_tag      text,     -- 2.5 under_50l|50l_1cr|1_3cr|3_10cr|above_10cr (single)
  ADD COLUMN IF NOT EXISTS cp_amenities       text[],   -- 2.6 amenities wanted (multi from master)
  ADD COLUMN IF NOT EXISTS cp_visit_pref      text,     -- 2.7 weekday | weekend
  ADD COLUMN IF NOT EXISTS cp_urgency_note    text;     -- 2.7 urgency note

COMMIT;
