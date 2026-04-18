-- Migration 002: Add retirement columns to memory_objects
-- Apply to an existing production database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/migrations/002_retirement.sql
--
-- Existing rows get retired_at = NULL (i.e. still active) and retirement_reason = NULL.

ALTER TABLE memory_objects
  ADD COLUMN IF NOT EXISTS retired_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retirement_reason  TEXT;

-- Partial index for the common "active objects only" filter.
CREATE INDEX IF NOT EXISTS memory_objects_active_idx
  ON memory_objects (updated_at DESC)
  WHERE retired_at IS NULL;
