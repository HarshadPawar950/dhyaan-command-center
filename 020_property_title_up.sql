-- =============================================================
-- 020_property_title_up.sql — additive: a display title for a property (unit).
-- The 99acres listing has a title (e.g. "3 BHK in Marvel Grande"); properties
-- previously had only `config`. Nullable, additive, no data movement, reversible.
-- Model unchanged (Builder → Projects → Properties).
-- =============================================================
BEGIN;
ALTER TABLE private.properties ADD COLUMN IF NOT EXISTS title text;
COMMIT;
