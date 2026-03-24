'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { pool, formatVector } = require('./db');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

async function getEmbedding(text) {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: text }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text) {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: 'user', content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ['uncategorized'], type: 'observation' };
  }
}

// Creates a fresh McpServer with all tools registered.
// Called per-request so there are no shared-state issues with concurrent connections.
function createMcpServer() {
  const server = new McpServer({ name: 'open-brain', version: '1.0.0' });

  // Tool 1: Semantic search
  server.registerTool(
    'search_thoughts',
    {
      title: 'Search Thoughts',
      description:
        'Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they have previously captured.',
      inputSchema: {
        query: z.string().describe('What to search for'),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.5),
      },
    },
    async ({ query, limit, threshold }) => {
      try {
        const effectiveThreshold = query.split(' ').length < 4 ? Math.min(threshold, 0.3) : threshold;
        const embedding = await getEmbedding(query);
        const { rows } = await pool.query(
          'SELECT * FROM match_thoughts($1::vector, $2::float, $3::int, $4::jsonb)',
          [formatVector(embedding), effectiveThreshold, limit, '{}']
        );

        if (!rows.length) {
          return { content: [{ type: 'text', text: `No thoughts found matching "${query}".` }] };
        }

        const results = rows.map((t, i) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || 'unknown'}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length) parts.push(`Topics: ${m.topics.join(', ')}`);
          if (Array.isArray(m.people) && m.people.length) parts.push(`People: ${m.people.join(', ')}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${m.action_items.join('; ')}`);
          parts.push(`\n${t.content}`);
          return parts.join('\n');
        });

        return { content: [{ type: 'text', text: `Found ${rows.length} thought(s):\n\n${results.join('\n\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 2: List recent thoughts with optional filters
  server.registerTool(
    'list_thoughts',
    {
      title: 'List Recent Thoughts',
      description:
        'List recently captured thoughts with optional filters by type, topic, person, or time range.',
      inputSchema: {
        limit: z.number().optional().default(10),
        type: z.string().optional().describe('Filter by type: observation, task, idea, reference, person_note'),
        topic: z.string().optional().describe('Filter by topic tag'),
        person: z.string().optional().describe('Filter by person mentioned'),
        days: z.number().optional().describe('Only thoughts from the last N days'),
      },
    },
    async ({ limit, type, topic, person, days }) => {
      try {
        const conditions = [];
        const params = [];

        if (type) {
          params.push(type);
          conditions.push(`metadata->>'type' = $${params.length}`);
        }
        if (topic) {
          params.push(topic);
          conditions.push(`metadata->'topics' ? $${params.length}`);
        }
        if (person) {
          params.push(person);
          conditions.push(`metadata->'people' ? $${params.length}`);
        }
        if (days) {
          const since = new Date();
          since.setDate(since.getDate() - days);
          params.push(since.toISOString());
          conditions.push(`created_at >= $${params.length}`);
        }

        params.push(limit);
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT content, metadata, created_at FROM thoughts ${where} ORDER BY created_at DESC LIMIT $${params.length}`;
        const { rows } = await pool.query(sql, params);

        if (!rows.length) {
          return { content: [{ type: 'text', text: 'No thoughts found.' }] };
        }

        const results = rows.map((t, i) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? m.topics.join(', ') : '';
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || '??'}${tags ? ' - ' + tags : ''})\n   ${t.content}`;
        });

        return { content: [{ type: 'text', text: `${rows.length} recent thought(s):\n\n${results.join('\n\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 3: Aggregate stats
  server.registerTool(
    'thought_stats',
    {
      title: 'Thought Statistics',
      description: 'Get a summary of all captured thoughts: totals, types, top topics, and people.',
      inputSchema: {},
    },
    async () => {
      try {
        const [countRes, dataRes] = await Promise.all([
          pool.query('SELECT COUNT(*) AS total FROM thoughts'),
          pool.query('SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC'),
        ]);

        const count = parseInt(countRes.rows[0].total, 10);
        const rows = dataRes.rows;
        const types = {};
        const topics = {};
        const people = {};

        for (const r of rows) {
          const m = r.metadata || {};
          if (m.type) types[m.type] = (types[m.type] || 0) + 1;
          if (Array.isArray(m.topics)) m.topics.forEach((t) => (topics[t] = (topics[t] || 0) + 1));
          if (Array.isArray(m.people)) m.people.forEach((p) => (people[p] = (people[p] || 0) + 1));
        }

        const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);

        const lines = [
          `Total thoughts: ${count}`,
          rows.length
            ? `Date range: ${new Date(rows[rows.length - 1].created_at).toLocaleDateString()} → ${new Date(rows[0].created_at).toLocaleDateString()}`
            : 'Date range: N/A',
          '',
          'Types:',
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ];

        if (Object.keys(topics).length) {
          lines.push('', 'Top topics:');
          sort(topics).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
        }
        if (Object.keys(people).length) {
          lines.push('', 'People mentioned:');
          sort(people).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 4: Capture a new memory object (Tier 2)
  server.registerTool(
    'capture_memory_object',
    {
      title: 'Capture Memory Object',
      description:
        'Save a synthesized memory object (Tier 2). Use this to distill and preserve insights, person profiles, or durable principles derived from raw thoughts. Not for raw captures — use capture_thought for those.',
      inputSchema: {
        object_type: z.enum(['synthesis', 'profile', 'principle']).describe(
          "'synthesis' for distilled topic knowledge, 'profile' for a person, 'principle' for a durable truth or mental model"
        ),
        domain: z.enum(['work', 'personal', 'general']).describe("'work', 'personal', or 'general'"),
        title: z.string().describe('Short descriptive title, e.g. "Ryan Fast — profile" or "Minneapolis competitive situation"'),
        content: z.string().describe('Full synthesized content. Write as a standalone briefing — clear to anyone with no prior context.'),
        source_thought_ids: z.array(z.string()).optional().describe('UUIDs of thoughts this was derived from'),
        supersedes_ids: z.array(z.string()).optional().describe('UUIDs of older memory objects this replaces'),
        valid_as_of: z.string().optional().describe('ISO date string representing when this knowledge is current, defaults to now'),
      },
    },
    async ({ object_type, domain, title, content, source_thought_ids, supersedes_ids, valid_as_of }) => {
      try {
        const textForEmbedding = `${title} ${content}`;
        const [embedding, metadata] = await Promise.all([
          getEmbedding(textForEmbedding),
          extractMetadata(content),
        ]);

        const validAsOf = valid_as_of ? new Date(valid_as_of) : new Date();
        const sourceIds = source_thought_ids || [];
        const supersedesIds = supersedes_ids || [];

        const { rows } = await pool.query(
          `INSERT INTO memory_objects
           (object_type, domain, title, content, source_thought_ids, supersedes_ids, valid_as_of, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7, $8::vector, $9)
           RETURNING id, object_type, domain, title, source_thought_ids, supersedes_ids, valid_as_of, created_at`,
          [
            object_type,
            domain,
            title,
            content,
            sourceIds,
            supersedesIds,
            validAsOf.toISOString(),
            formatVector(embedding),
            JSON.stringify(metadata),
          ]
        );

        const obj = rows[0];
        let confirmation = `Saved ${object_type} "${title}" (${domain})\nID: ${obj.id}`;
        if (Array.isArray(metadata.topics) && metadata.topics.length)
          confirmation += `\nTopics: ${metadata.topics.join(', ')}`;
        if (Array.isArray(metadata.people) && metadata.people.length)
          confirmation += `\nPeople: ${metadata.people.join(', ')}`;
        if (sourceIds.length)
          confirmation += `\nDerived from ${sourceIds.length} thought(s)`;
        if (supersedesIds.length)
          confirmation += `\nSupersedes ${supersedesIds.length} older object(s)`;

        return { content: [{ type: 'text', text: confirmation }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 5: Unified semantic search across Tier 1 and Tier 2
  server.registerTool(
    'search_memory',
    {
      title: 'Search Memory',
      description:
        'Unified semantic search across both raw thoughts (Tier 1) and synthesized memory objects (Tier 2). Memory objects are boosted in ranking so distilled knowledge surfaces above raw captures when both are relevant. Use this as the primary search tool.',
      inputSchema: {
        query: z.string().describe('Natural language search query'),
        limit: z.number().optional().default(10).describe('Total results to return'),
        tier: z.enum(['all', 'thoughts', 'objects']).optional().default('all').describe("'all' (default), 'thoughts', or 'objects'"),
        object_type: z.enum(['synthesis', 'profile', 'principle']).optional().describe('Filter memory objects by type'),
        domain: z.enum(['work', 'personal', 'general']).optional().describe('Filter by domain'),
        threshold: z.number().optional().default(0.5).describe('Cosine similarity threshold (0–1)'),
      },
    },
    async ({ query, limit, tier, object_type, domain, threshold }) => {
      try {
        const effectiveThreshold = query.split(' ').length < 4 ? Math.min(threshold, 0.3) : threshold;
        const embedding = await getEmbedding(query);
        const vec = formatVector(embedding);
        const results = [];

        if (tier === 'all' || tier === 'thoughts') {
          const { rows } = await pool.query(
            'SELECT * FROM match_thoughts($1::vector, $2::float, $3::int, $4::jsonb)',
            [vec, effectiveThreshold, limit, '{}']
          );
          for (const t of rows) {
            results.push({
              tier: 'thought',
              object_type: (t.metadata || {}).type || 'observation',
              id: t.id,
              title: null,
              content: t.content,
              metadata: t.metadata || {},
              similarity: t.similarity,
              domain: null,
              created_at: t.created_at,
            });
          }
        }

        if (tier === 'all' || tier === 'objects') {
          const conditions = ['embedding IS NOT NULL', `1 - (embedding <=> $1::vector) > $2`];
          const params = [vec, effectiveThreshold];

          if (object_type) {
            params.push(object_type);
            conditions.push(`object_type = $${params.length}`);
          }
          if (domain) {
            params.push(domain);
            conditions.push(`domain = $${params.length}`);
          }

          params.push(limit);
          const sql = `
            SELECT id, object_type, domain, title, content, metadata, valid_as_of, updated_at,
                   1 - (embedding <=> $1::vector) AS similarity
            FROM memory_objects
            WHERE ${conditions.join(' AND ')}
            ORDER BY embedding <=> $1::vector
            LIMIT $${params.length}
          `;
          const { rows } = await pool.query(sql, params);
          const boost = tier === 'all' ? 0.05 : 0;
          for (const obj of rows) {
            results.push({
              tier: 'memory_object',
              object_type: obj.object_type,
              id: obj.id,
              title: obj.title,
              content: obj.content,
              metadata: obj.metadata || {},
              similarity: obj.similarity + boost,
              domain: obj.domain,
              created_at: obj.updated_at,
            });
          }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        const top = results.slice(0, limit);

        if (!top.length) {
          return { content: [{ type: 'text', text: `No results found matching "${query}".` }] };
        }

        const formatted = top.map((r, i) => {
          const label = r.tier === 'memory_object' ? `MEMORY: ${r.object_type.toUpperCase()}` : 'THOUGHT';
          const parts = [
            `--- Result ${i + 1} [${label}] (${(Math.min(r.similarity, 1) * 100).toFixed(1)}% match) ---`,
          ];
          if (r.title) parts.push(`Title: ${r.title}`);
          if (r.domain) parts.push(`Domain: ${r.domain}`);
          parts.push(`Captured: ${new Date(r.created_at).toLocaleDateString()}`);
          const m = r.metadata;
          if (r.tier === 'thought') parts.push(`Type: ${m.type || 'unknown'}`);
          if (Array.isArray(m.topics) && m.topics.length) parts.push(`Topics: ${m.topics.join(', ')}`);
          if (Array.isArray(m.people) && m.people.length) parts.push(`People: ${m.people.join(', ')}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${m.action_items.join('; ')}`);
          parts.push(`\n${r.content}`);
          return parts.join('\n');
        });

        return { content: [{ type: 'text', text: `Found ${top.length} result(s):\n\n${formatted.join('\n\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 6: List memory objects with optional filters
  server.registerTool(
    'list_memory_objects',
    {
      title: 'List Memory Objects',
      description:
        'List synthesized memory objects (Tier 2) with optional filters. Use this to browse syntheses, profiles, and principles.',
      inputSchema: {
        object_type: z.enum(['synthesis', 'profile', 'principle']).optional().describe('Filter by type'),
        domain: z.enum(['work', 'personal', 'general']).optional().describe('Filter by domain'),
        limit: z.number().optional().default(10),
        days: z.number().optional().describe('Only objects updated within the last N days'),
      },
    },
    async ({ object_type, domain, limit, days }) => {
      try {
        const conditions = [];
        const params = [];

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

        params.push(limit);
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT id, object_type, domain, title, content, metadata, valid_as_of, updated_at
                     FROM memory_objects ${where}
                     ORDER BY updated_at DESC
                     LIMIT $${params.length}`;
        const { rows } = await pool.query(sql, params);

        if (!rows.length) {
          return { content: [{ type: 'text', text: 'No memory objects found.' }] };
        }

        const results = rows.map((obj, i) => {
          const m = obj.metadata || {};
          const tags = Array.isArray(m.topics) ? m.topics.join(', ') : '';
          return (
            `${i + 1}. [${obj.object_type.toUpperCase()}] [${obj.domain}] "${obj.title}"\n` +
            `   Updated: ${new Date(obj.updated_at).toLocaleDateString()}` +
            `${tags ? ' — ' + tags : ''}\n` +
            `   ID: ${obj.id}\n` +
            `   ${obj.content.slice(0, 120)}${obj.content.length > 120 ? '…' : ''}`
          );
        });

        return { content: [{ type: 'text', text: `${rows.length} memory object(s):\n\n${results.join('\n\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 7: Combined stats across Tier 1 and Tier 2
  server.registerTool(
    'memory_stats',
    {
      title: 'Memory Statistics',
      description: 'Get a combined stats summary across all tiers: thought counts/types (Tier 1) and memory object counts/types/domains (Tier 2).',
      inputSchema: {},
    },
    async () => {
      try {
        const [thoughtCountRes, thoughtDataRes, objStatsRes, objRecentRes, objDateRes] = await Promise.all([
          pool.query('SELECT COUNT(*) AS total FROM thoughts'),
          pool.query('SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC'),
          pool.query(
            'SELECT object_type, domain, COUNT(*) AS count FROM memory_objects GROUP BY object_type, domain ORDER BY object_type, domain'
          ),
          pool.query(`
            SELECT DISTINCT ON (object_type)
              id, object_type, domain, title, updated_at
            FROM memory_objects
            ORDER BY object_type, updated_at DESC
          `),
          pool.query('SELECT MIN(created_at) AS oldest, MAX(updated_at) AS newest FROM memory_objects'),
        ]);

        const thoughtCount = parseInt(thoughtCountRes.rows[0].total, 10);
        const thoughtRows = thoughtDataRes.rows;
        const types = {};
        const topics = {};
        const people = {};

        for (const r of thoughtRows) {
          const m = r.metadata || {};
          if (m.type) types[m.type] = (types[m.type] || 0) + 1;
          if (Array.isArray(m.topics)) m.topics.forEach((t) => (topics[t] = (topics[t] || 0) + 1));
          if (Array.isArray(m.people)) m.people.forEach((p) => (people[p] = (people[p] || 0) + 1));
        }

        const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);

        const lines = [
          '=== TIER 1: THOUGHTS ===',
          `Total thoughts: ${thoughtCount}`,
          thoughtRows.length
            ? `Date range: ${new Date(thoughtRows[thoughtRows.length - 1].created_at).toLocaleDateString()} → ${new Date(thoughtRows[0].created_at).toLocaleDateString()}`
            : 'Date range: N/A',
          '',
          'Types:',
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ];

        if (Object.keys(topics).length) {
          lines.push('', 'Top topics:');
          sort(topics).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
        }
        if (Object.keys(people).length) {
          lines.push('', 'People mentioned:');
          sort(people).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
        }

        lines.push('', '=== TIER 2: MEMORY OBJECTS ===');

        if (objStatsRes.rows.length === 0) {
          lines.push('No memory objects yet.');
        } else {
          const totalObjs = objStatsRes.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
          lines.push(`Total memory objects: ${totalObjs}`, '', 'By type and domain:');
          for (const r of objStatsRes.rows) {
            lines.push(`  ${r.object_type} / ${r.domain}: ${r.count}`);
          }
          lines.push('', 'Most recent per type:');
          for (const r of objRecentRes.rows) {
            lines.push(`  ${r.object_type}: "${r.title}" [${r.domain}] (${new Date(r.updated_at).toLocaleDateString()})`);
          }
          const dr = objDateRes.rows[0];
          if (dr.oldest) {
            lines.push(
              '',
              `Date range: ${new Date(dr.oldest).toLocaleDateString()} → ${new Date(dr.newest).toLocaleDateString()}`
            );
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 8: Capture a new thought from an MCP client
  server.registerTool(
    'capture_thought',
    {
      title: 'Capture Thought',
      description:
        'Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client.',
      inputSchema: {
        content: z.string().describe('The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI'),
      },
    },
    async ({ content }) => {
      try {
        const [embedding, metadata] = await Promise.all([getEmbedding(content), extractMetadata(content)]);
        const fullMetadata = { ...metadata, source: 'mcp' };

        await pool.query(
          'INSERT INTO thoughts (content, embedding, metadata) VALUES ($1, $2::vector, $3)',
          [content, formatVector(embedding), JSON.stringify(fullMetadata)]
        );

        let confirmation = `Captured as ${metadata.type || 'thought'}`;
        if (Array.isArray(metadata.topics) && metadata.topics.length)
          confirmation += ` — ${metadata.topics.join(', ')}`;
        if (Array.isArray(metadata.people) && metadata.people.length)
          confirmation += ` | People: ${metadata.people.join(', ')}`;
        if (Array.isArray(metadata.action_items) && metadata.action_items.length)
          confirmation += ` | Actions: ${metadata.action_items.join('; ')}`;

        return { content: [{ type: 'text', text: confirmation }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// Auth middleware — checks x-brain-key header or ?key= query param
function checkAuth(req, res, next) {
  const provided = req.headers['x-brain-key'] || req.query.key;
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return res.status(401).json({ error: 'Invalid or missing access key' });
  }
  next();
}

// Express route handler for all MCP requests (POST for RPC, GET for SSE)
async function handleMcp(req, res) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

module.exports = { checkAuth, handleMcp };
