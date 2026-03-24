-- Migration 001: Add memory_objects table (Tier 2 synthesized knowledge)
-- Apply to an existing production database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/migrations/001_memory_objects.sql

CREATE TABLE IF NOT EXISTS memory_objects (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type       TEXT        NOT NULL CHECK (object_type IN ('synthesis', 'profile', 'principle')),
  domain            TEXT        NOT NULL CHECK (domain IN ('work', 'personal', 'general')),
  title             TEXT        NOT NULL,
  content           TEXT        NOT NULL,
  source_thought_ids UUID[],
  supersedes_ids    UUID[],
  valid_as_of       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding         VECTOR(1536),
  metadata          JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS memory_objects_embedding_hnsw_idx
  ON memory_objects USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS memory_objects_object_type_idx ON memory_objects (object_type);

CREATE INDEX IF NOT EXISTS memory_objects_domain_idx ON memory_objects (domain);
