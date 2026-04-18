'use strict';

// Integration tests for the Tier 2 memory-object cleanup tools.
//
// Requires DATABASE_URL pointing at a Postgres database with the OpenBrain
// schema applied, including migration 002_retirement.sql. Tests skip cleanly
// if DATABASE_URL is not set.
//
// Run with: npm test
//
// Tests seed rows with a unique title prefix so they can run against a shared
// dev database without touching real data, and clean up after themselves.

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const HAS_DB = !!process.env.DATABASE_URL;

if (!HAS_DB) {
  test('memoryObjects — DATABASE_URL not set, skipping integration tests', { skip: true }, () => {});
  return;
}

const { pool, formatVector } = require('../server/db');
const {
  retireMemoryObject,
  updateMemoryObject,
  mergeMemoryObjects,
  listMemoryObjects,
  deleteMemoryObject,
} = require('../server/memoryObjects');

const PREFIX = `MEMORY_CLEANUP_TEST_${process.pid}_${Date.now()}__`;
const ZEROS = new Array(1536).fill(0);

const stubDeps = {
  getEmbedding: async () => ZEROS.slice(),
  extractMetadata: async () => ({ topics: ['test'], type: 'synthesis', people: [], action_items: [] }),
};

async function seed({ title, object_type = 'synthesis', domain = 'general', content = 'body' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO memory_objects (object_type, domain, title, content, embedding, metadata)
     VALUES ($1, $2, $3, $4, $5::vector, $6)
     RETURNING id, title, updated_at, retired_at`,
    [object_type, domain, PREFIX + title, content, formatVector(ZEROS), JSON.stringify({ topics: ['test'] })]
  );
  return rows[0];
}

async function cleanup() {
  await pool.query('DELETE FROM memory_objects WHERE title LIKE $1', [PREFIX + '%']);
}

before(async () => {
  // Sanity: is the migration applied?
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'memory_objects'
        AND column_name IN ('retired_at', 'retirement_reason')`
  );
  if (res.rowCount !== 2) {
    throw new Error(
      'memory_objects.retired_at / retirement_reason columns missing — apply sql/migrations/002_retirement.sql'
    );
  }
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

describe('retire_memory_object', () => {
  test('retiring a normal object hides it from list_memory_objects by default', async () => {
    const obj = await seed({ title: 'retire_hide' });

    // Visible before retirement
    let rows = await listMemoryObjects(pool, { title_like: PREFIX + 'retire_hide', limit: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, obj.id);

    // Retire it
    const result = await retireMemoryObject(pool, { id: obj.id, reason: 'unit test' });
    assert.equal(result.id, obj.id);
    assert.ok(result.retired_at, 'retired_at should be set');
    assert.equal(result.retirement_reason, 'unit test');

    // Hidden by default
    rows = await listMemoryObjects(pool, { title_like: PREFIX + 'retire_hide', limit: 5 });
    assert.equal(rows.length, 0, 'retired object should not appear without include_retired');

    // Visible with include_retired: true
    rows = await listMemoryObjects(pool, {
      title_like: PREFIX + 'retire_hide',
      limit: 5,
      include_retired: true,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, obj.id);
    assert.ok(rows[0].retired_at);
    assert.equal(rows[0].retirement_reason, 'unit test');
  });

  test('retiring an already-retired object throws a clear error', async () => {
    const obj = await seed({ title: 'retire_twice' });
    await retireMemoryObject(pool, { id: obj.id, reason: 'first' });

    await assert.rejects(
      () => retireMemoryObject(pool, { id: obj.id, reason: 'second' }),
      (err) => {
        assert.match(err.message, /already retired/i);
        return true;
      }
    );
  });

  test('retiring a non-existent id throws a clear error', async () => {
    await assert.rejects(
      () => retireMemoryObject(pool, { id: '00000000-0000-4000-8000-000000000000' }),
      (err) => {
        assert.match(err.message, /does not exist/i);
        return true;
      }
    );
  });
});

describe('update_memory_object', () => {
  test('updates only the provided field in place and bumps updated_at', async () => {
    const obj = await seed({ title: 'update_in_place', content: 'original body' });

    // Small sleep so updated_at definitely moves forward at ms resolution.
    await new Promise((r) => setTimeout(r, 20));

    const updated = await updateMemoryObject(pool, {
      id: obj.id,
      fields: { title: PREFIX + 'update_in_place_edited' },
    });

    assert.equal(updated.id, obj.id, 'same id — no new row created');
    assert.equal(updated.title, PREFIX + 'update_in_place_edited');
    assert.equal(updated.content, 'original body', 'content was not touched');
    assert.ok(
      new Date(updated.updated_at).getTime() > new Date(obj.updated_at).getTime(),
      'updated_at moved forward'
    );
    // supersedes_ids wasn't provided on seed, so it's either null or []. Either way,
    // the update must not have populated it.
    assert.ok(
      updated.supersedes_ids === null || updated.supersedes_ids.length === 0,
      'supersedes_ids not touched'
    );

    // Confirm only one row with this id exists (no new object created).
    const { rows: all } = await pool.query(
      'SELECT COUNT(*)::int AS c FROM memory_objects WHERE id = $1',
      [obj.id]
    );
    assert.equal(all[0].c, 1);

    // Confirm total count with our prefix is still 1 (no new row inserted).
    const { rows: byPrefix } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM memory_objects
        WHERE title LIKE $1 OR title LIKE $2`,
      [PREFIX + 'update_in_place%', PREFIX + 'update_in_place_edited%']
    );
    assert.equal(byPrefix[0].c, 1, 'only one row should exist for this test object');
  });
});

describe('merge_memory_objects', () => {
  test('merges three syntheses atomically: new object with supersedes_ids, all sources retired', async () => {
    const a = await seed({ title: 'merge_ok_A' });
    const b = await seed({ title: 'merge_ok_B' });
    const c = await seed({ title: 'merge_ok_C' });

    const result = await mergeMemoryObjects(
      pool,
      {
        object_type: 'synthesis',
        domain: 'general',
        title: PREFIX + 'merge_ok_consolidated',
        content: 'consolidated body',
        source_object_ids: [a.id, b.id, c.id],
      },
      stubDeps
    );

    assert.ok(result.new_object_id);
    assert.equal(result.retired_ids.length, 3);
    assert.deepEqual(new Set(result.retired_ids), new Set([a.id, b.id, c.id]));

    // Exactly one new object with correct supersedes_ids
    const { rows: newRows } = await pool.query(
      'SELECT id, supersedes_ids, retired_at FROM memory_objects WHERE id = $1',
      [result.new_object_id]
    );
    assert.equal(newRows.length, 1);
    assert.deepEqual(
      new Set(newRows[0].supersedes_ids),
      new Set([a.id, b.id, c.id]),
      'new object supersedes_ids matches source set'
    );
    assert.equal(newRows[0].retired_at, null, 'new object is active');

    // All three sources retired with the default merge reason
    const { rows: sources } = await pool.query(
      'SELECT id, retired_at, retirement_reason FROM memory_objects WHERE id = ANY($1::uuid[])',
      [[a.id, b.id, c.id]]
    );
    assert.equal(sources.length, 3);
    for (const s of sources) {
      assert.ok(s.retired_at, `source ${s.id} should be retired`);
      assert.equal(
        s.retirement_reason,
        `merged into ${result.new_object_id}`,
        'default retirement reason mentions new object id'
      );
    }
  });

  test('rolls back cleanly if a source is already retired — no new object, other sources untouched', async () => {
    const a = await seed({ title: 'merge_rollback_A' });
    const b = await seed({ title: 'merge_rollback_B' });
    const c = await seed({ title: 'merge_rollback_C' });

    // Pre-retire A with a distinctive reason so we can detect a partial write.
    await retireMemoryObject(pool, { id: a.id, reason: 'pre-existing retirement' });

    const mergedTitle = PREFIX + 'merge_rollback_should_not_persist';

    await assert.rejects(
      () =>
        mergeMemoryObjects(
          pool,
          {
            object_type: 'synthesis',
            domain: 'general',
            title: mergedTitle,
            content: 'should never persist',
            source_object_ids: [a.id, b.id, c.id],
          },
          stubDeps
        ),
      (err) => {
        assert.match(err.message, /already retired/i);
        return true;
      }
    );

    // No new object was persisted with the merged title.
    const { rows: shouldBeEmpty } = await pool.query(
      'SELECT id FROM memory_objects WHERE title = $1',
      [mergedTitle]
    );
    assert.equal(shouldBeEmpty.length, 0, 'merge rollback left no new object behind');

    // A still has its original retirement reason (merge did not overwrite it).
    const { rows: aRows } = await pool.query(
      'SELECT retired_at, retirement_reason FROM memory_objects WHERE id = $1',
      [a.id]
    );
    assert.equal(aRows[0].retirement_reason, 'pre-existing retirement');

    // B and C remain active.
    const { rows: bcRows } = await pool.query(
      'SELECT id, retired_at FROM memory_objects WHERE id = ANY($1::uuid[])',
      [[b.id, c.id]]
    );
    assert.equal(bcRows.length, 2);
    for (const row of bcRows) {
      assert.equal(row.retired_at, null, `source ${row.id} should still be active after rollback`);
    }
  });
});

describe('delete_memory_object', () => {
  test('hard-deletes the row and errors on unknown id', async () => {
    const obj = await seed({ title: 'delete_ok' });
    const result = await deleteMemoryObject(pool, { id: obj.id });
    assert.equal(result.id, obj.id);

    const { rows } = await pool.query('SELECT id FROM memory_objects WHERE id = $1', [obj.id]);
    assert.equal(rows.length, 0);

    await assert.rejects(
      () => deleteMemoryObject(pool, { id: '00000000-0000-4000-8000-000000000000' }),
      (err) => {
        assert.match(err.message, /does not exist|not deleted/i);
        return true;
      }
    );
  });
});

describe('search_memory / list_memory_objects include_retired wiring', () => {
  test('supersedes_ids lineage still resolves even when referenced object is retired', async () => {
    const old = await seed({ title: 'lineage_old' });
    await retireMemoryObject(pool, { id: old.id, reason: 'superseded' });

    // Insert a new object that supersedes the retired one.
    const { rows } = await pool.query(
      `INSERT INTO memory_objects
         (object_type, domain, title, content, supersedes_ids, embedding, metadata)
       VALUES ('synthesis', 'general', $1, 'new body', $2::uuid[], $3::vector, '{}')
       RETURNING id`,
      [PREFIX + 'lineage_new', [old.id], formatVector(ZEROS)]
    );
    const newId = rows[0].id;

    // Lineage lookup by id still finds the retired object.
    const { rows: lineage } = await pool.query(
      `SELECT m.id, m.title, m.retired_at
         FROM memory_objects parent
         JOIN memory_objects m ON m.id = ANY(parent.supersedes_ids)
        WHERE parent.id = $1`,
      [newId]
    );
    assert.equal(lineage.length, 1);
    assert.equal(lineage[0].id, old.id);
    assert.ok(lineage[0].retired_at, 'retired object still resolvable by lineage');

    // But the retired object does not show up in the default list.
    const listed = await listMemoryObjects(pool, {
      title_like: PREFIX + 'lineage_old',
      limit: 5,
    });
    assert.equal(listed.length, 0);

    const listedWithRetired = await listMemoryObjects(pool, {
      title_like: PREFIX + 'lineage_old',
      limit: 5,
      include_retired: true,
    });
    assert.equal(listedWithRetired.length, 1);
  });
});
