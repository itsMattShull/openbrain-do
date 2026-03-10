-- OpenBrain PostgreSQL schema
-- Run once on a fresh database: psql -U openbrain -d openbrain -f schema.sql

-- pgvector extension (must be installed on the server first: apt install postgresql-16-pgvector)
CREATE EXTENSION IF NOT EXISTS vector;

-- Main thoughts table
CREATE TABLE IF NOT EXISTS thoughts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content    TEXT        NOT NULL,
  embedding  VECTOR(1536) NOT NULL,
  metadata   JSONB       NOT NULL DEFAULT '{}'
);

-- HNSW index on the embedding column (inner product ops — fast for normalized vectors)
CREATE INDEX IF NOT EXISTS thoughts_embedding_hnsw_idx
  ON thoughts USING hnsw (embedding vector_ip_ops);

-- Index on created_at for time-based queries
CREATE INDEX IF NOT EXISTS thoughts_created_at_idx ON thoughts (created_at DESC);

-- GIN index on metadata for jsonb containment queries (@>, ?)
CREATE INDEX IF NOT EXISTS thoughts_metadata_gin_idx ON thoughts USING gin (metadata);

-- match_thoughts: vector similarity search RPC
-- Returns thoughts ordered by inner product similarity (highest = most similar)
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding VECTOR(1536),
  match_threshold FLOAT,
  match_count     INT,
  filter          JSONB DEFAULT '{}'
)
RETURNS TABLE (
  id         UUID,
  content    TEXT,
  metadata   JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    content,
    metadata,
    (embedding <#> query_embedding) * -1 AS similarity,
    created_at
  FROM thoughts
  WHERE (embedding <#> query_embedding) * -1 > match_threshold
  ORDER BY embedding <#> query_embedding  -- ascending = most similar first
  LIMIT match_count;
$$;
