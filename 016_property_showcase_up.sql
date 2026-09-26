-- =============================================================
-- 016_property_showcase_up.sql — property showcase (Launch Day)
-- Adds a Google-Maps link column to properties, and a property_images table
-- that powers the detail-page gallery/slider.
--
-- Additive ONLY. No existing column/table/enum is altered or dropped. The
-- properties CRUD / soft-delete / approval-gated-delete path is UNTOUCHED —
-- images carry their own soft-delete (deleted_at) so removing a photo never
-- touches a property row.
-- =============================================================

BEGIN;

-- Paste-a-link Google Maps URL (nullable — empty renders "Location not set").
ALTER TABLE private.properties
    ADD COLUMN IF NOT EXISTS google_maps_url text;

CREATE TABLE IF NOT EXISTS private.property_images (
    image_id     uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    -- CASCADE only fires on a HARD delete of a property; properties are
    -- soft-delete only, so in normal operation images persist with their row.
    property_id  uuid NOT NULL REFERENCES private.properties(property_id) ON DELETE CASCADE,
    file_path    text NOT NULL,          -- web path, e.g. /uploads/properties/<id>/<file>
    caption      text,
    sort_order   integer NOT NULL DEFAULT 0,
    uploaded_by  text,                   -- employees.external_id of the uploader
    created_at   timestamptz NOT NULL DEFAULT NOW(),
    deleted_at   timestamptz             -- soft-delete an individual image
);

-- "images for this property, in order" — only live (non-deleted) rows.
CREATE INDEX IF NOT EXISTS idx_property_images_prop
    ON private.property_images (property_id, sort_order) WHERE deleted_at IS NULL;

COMMIT;
