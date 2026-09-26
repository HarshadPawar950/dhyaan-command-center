-- =============================================================
-- 013_site_visit_booked_up.sql — add 'booked' to site_visit_status
-- Lets a conducted visit that results in a booking be marked as its own
-- outcome, feeding the PRIMARY conversion metric (booked / (completed+booked)).
-- ADD VALUE IF NOT EXISTS is idempotent. In PG12+ ADD VALUE is transactional but
-- the new value is not USABLE in the same transaction (only after commit) — so
-- this migration is a single statement (no dependent DML here).
-- Additive ONLY. No table/column/existing enum value altered or dropped.
-- =============================================================

ALTER TYPE private.site_visit_status ADD VALUE IF NOT EXISTS 'booked';
