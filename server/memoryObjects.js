'use strict';

const { formatVector } = require('./db');

// UUID v1–v5 shape check. Strict enough to catch typos, loose enough not to
// depend on a specific version.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(id, label = 'id') {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`Invalid ${label}: ${id}`);
  }
}

// Hard-delete a memory object. Returns { id } of the deleted row.
// Errors if no row was deleted (unknown id).
async function deleteMemoryObject(pool, { id }) {
  assertUuid(id, 'memory_object_id');
  const { rows } = await pool.query(
    'DELETE FROM memory_objects WHERE id = $1 RETURNING id',
    [id]
  );
  if (!rows.length) {
    throw new Error(`Memory object ${id} does not exist or was not deleted`);
  }
  return { id: rows[0].id };
}

// Mark a memory object retired. Sets retired_at and retirement_reason. Errors
// if the object does not exist or is already retired.
async function retireMemoryObject(pool, { id, reason }) {
  assertUuid(id, 'memory_object_id');
  const existing = await pool.query(
    'SELECT id, retired_at FROM memory_objects WHERE id = $1',
    [id]
  );
  if (!existing.rows.length) {
    throw new Error(`Memory object ${id} does not exist`);
  }
  if (existing.rows[0].retired_at) {
    throw new Error(`Memory object ${id} is already retired`);
  }

  const { rows } = await pool.query(
    `UPDATE memory_objects
        SET retired_at = NOW(),
            retirement_reason = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, title, retired_at, retirement_reason`,
    [id, reason || null]
  );
  return rows[0];
}

// Partial update of a memory object. Only fields present in `fields` are
// changed; all others (including supersedes_ids) are left alone. `updated_at`
// is bumped. Does NOT create a new row.
//
// If title or content change, the caller is responsible for recomputing the
// embedding and passing it in via opts.embedding (1536-float array) — we
// don't silently leave a stale embedding behind.
async function updateMemoryObject(pool, { id, fields }, opts = {}) {
  assertUuid(id, 'memory_object_id');

  const allowed = ['title', 'content', 'domain', 'valid_as_of'];
  const setClauses = [];
  const params = [id];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      setClauses.push(`${key} = $${params.length}`);
    }
  }

  if (opts.embedding) {
    params.push(formatVector(opts.embedding));
    setClauses.push(`embedding = $${params.length}::vector`);
  }

  if (!setClauses.length) {
    throw new Error('update_memory_object called with no fields to update');
  }

  setClauses.push('updated_at = NOW()');

  const { rows } = await pool.query(
    `UPDATE memory_objects
        SET ${setClauses.join(', ')}
      WHERE id = $1
      RETURNING id, object_type, domain, title, content, source_thought_ids,
                supersedes_ids, valid_as_of, created_at, updated_at,
                retired_at, retirement_reason, metadata`,
    params
  );
  if (!rows.length) {
    throw new Error(`Memory object ${id} does not exist`);
  }
  return rows[0];
}

// Atomic merge: create a new consolidated memory object and retire every source
// in one transaction. If anything fails, the whole thing rolls back — no new
// object, no retirements applied.
//
// deps: { getEmbedding, extractMetadata } — injected so tests can stub them.
async function mergeMemoryObjects(pool, input, deps) {
  const {
    object_type,
    domain,
    title,
    content,
    source_object_ids,
    valid_as_of,
    source_thought_ids,
    retirement_reason,
  } = input;

  if (!Array.isArray(source_object_ids) || !source_object_ids.length) {
    throw new Error('merge_memory_objects requires at least one source_object_id');
  }
  for (const sid of source_object_ids) assertUuid(sid, 'source_object_id');

  const textForEmbedding = `${title} ${content}`;
  const [embedding, metadata] = await Promise.all([
    deps.getEmbedding(textForEmbedding),
    deps.extractMetadata(content),
  ]);

  const validAsOf = valid_as_of ? new Date(valid_as_of) : new Date();
  const sourceThoughtIds = source_thought_ids || [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify every source exists and is not already retired BEFORE creating
    // the new object. Doing this first gives a clean error on bad input
    // without leaving junk behind (the ROLLBACK would clean up anyway, but
    // this gives a better error message than a cryptic update-zero-rows).
    const check = await client.query(
      `SELECT id, retired_at FROM memory_objects WHERE id = ANY($1::uuid[])`,
      [source_object_ids]
    );
    const found = new Map(check.rows.map((r) => [r.id, r]));
    for (const sid of source_object_ids) {
      const row = found.get(sid);
      if (!row) throw new Error(`Source memory object ${sid} does not exist`);
      if (row.retired_at) throw new Error(`Source memory object ${sid} is already retired`);
    }

    const insert = await client.query(
      `INSERT INTO memory_objects
         (object_type, domain, title, content, source_thought_ids,
          supersedes_ids, valid_as_of, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7, $8::vector, $9)
       RETURNING id, object_type, domain, title, content, source_thought_ids,
                 supersedes_ids, valid_as_of, created_at, updated_at`,
      [
        object_type,
        domain,
        title,
        content,
        sourceThoughtIds,
        source_object_ids,
        validAsOf.toISOString(),
        formatVector(embedding),
        JSON.stringify(metadata),
      ]
    );
    const newObject = insert.rows[0];

    const reason = retirement_reason || `merged into ${newObject.id}`;

    const retire = await client.query(
      `UPDATE memory_objects
          SET retired_at = NOW(),
              retirement_reason = $2,
              updated_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND retired_at IS NULL
        RETURNING id`,
      [source_object_ids, reason]
    );
    if (retire.rowCount !== source_object_ids.length) {
      // Race: a source got retired between the check above and this update.
      throw new Error(
        `Expected to retire ${source_object_ids.length} source(s) but updated ${retire.rowCount}`
      );
    }

    await client.query('COMMIT');
    return {
      new_object_id: newObject.id,
      retired_ids: retire.rows.map((r) => r.id),
      new_object: newObject,
      retirement_reason: reason,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// List memory objects with optional filters. Centralized so the MCP handler
// and tests agree on how `include_retired` is applied.
async function listMemoryObjects(
  pool,
  { object_type, domain, days, limit = 10, include_retired = false, title_like } = {}
) {
  const conditions = [];
  const params = [];

  if (!include_retired) conditions.push('retired_at IS NULL');
  if (object_type) {
    params.push(object_type);
    conditions.push(`object_type = $${params.length}`);
  }
  if (domain) {
    params.push(domain);
    conditions.push(`domain = $${params.length}`);
  }
  if (days) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    params.push(since.toISOString());
    conditions.push(`updated_at >= $${params.length}`);
  }
  if (title_like) {
    params.push(title_like);
    conditions.push(`title LIKE $${params.length}`);
  }

  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT id, object_type, domain, title, content, metadata, valid_as_of,
                      created_at, updated_at, retired_at, retirement_reason
                 FROM memory_objects ${where}
                 ORDER BY updated_at DESC
                 LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = {
  deleteMemoryObject,
  retireMemoryObject,
  updateMemoryObject,
  mergeMemoryObjects,
  listMemoryObjects,
};
