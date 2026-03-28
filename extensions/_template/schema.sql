-- Replace "my_items" with your table name.
-- All statements must use IF NOT EXISTS so this file is safe to run on every server restart.

CREATE TABLE IF NOT EXISTS my_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_my_items_name ON my_items (name);

-- To add a column later, add a line like this and it will run safely on next restart:
-- ALTER TABLE my_items ADD COLUMN IF NOT EXISTS category TEXT;
