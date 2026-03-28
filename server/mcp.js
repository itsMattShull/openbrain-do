'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { pool, formatVector } = require('./db');

const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY;
const { getEmbedding, extractMetadata } = require('./utils');

// Creates a fresh McpServer with all tools registered.
// Called per-request so there are no shared-state issues with concurrent connections.
// extensionTools: array of { name, config, handler } from loader.js
function createMcpServer(extensionTools = []) {
  const server = new McpServer({ name: 'open-brain', version: '1.0.0' });

  // Tool 1: Semantic search
  server.registerTool(
    'search_thoughts',
    {
      title: 'Search Thoughts',
      description:
        'Search raw captured thoughts (Tier 1) by meaning. Use this when you need original unprocessed captures — specific meeting details, exact timestamps, task lists, unfiltered feedback, or the source material for a consolidation/dream pass. Do NOT use this as the default lookup tool. For general questions about a person, project, topic, or situation, use search_memory instead, which searches across all tiers and surfaces synthesized knowledge first.',
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
        'List raw captured thoughts (Tier 1) in reverse chronological order with optional filters by type, topic, person, or time range. Use this when you need a time-ordered log of what was captured — for review, auditing, or feeding into a consolidation/dream pass. For semantic lookup by meaning, use search_memory or search_thoughts instead.',
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
      description: 'Get a summary of raw captured thoughts (Tier 1): totals by type, top topics, and people mentioned. For a combined stats summary across all memory tiers including synthesized memory objects, use memory_stats instead.',
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
        "Save a synthesized memory object to the Open Brain (Tier 2). Use this when consolidating raw thoughts into durable, distilled knowledge — not for capturing something new in the moment. Three types: (1) 'synthesis' — distilled understanding of a topic, project, or situation as of a date, e.g. the current state of a competitive situation or a product initiative; (2) 'profile' — synthesized understanding of a person: who they are, their role, relationship to the user, and what to watch for; (3) 'principle' — a durable mental model, hard-won lesson, or way of working that doesn't expire. Always set domain to 'work', 'personal', or 'general'. Include source_thought_ids when the object was derived from specific raw thoughts. Include supersedes_ids when this object replaces an older memory object on the same topic.",
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
        "Primary search tool across all memory tiers. Use this by default whenever looking up anything about a person, project, topic, competitive situation, or past decision. Searches both raw thoughts (Tier 1) and synthesized memory objects (Tier 2) together, with synthesized knowledge ranked first. Supports filtering by tier ('all', 'thoughts', 'objects'), object_type ('synthesis', 'profile', 'principle'), and domain ('work', 'personal', 'general'). Use tier='objects' when you specifically want synthesized knowledge only — e.g. 'what do I know about this person' or 'what is the current state of this project'. Use tier='thoughts' when you need raw unprocessed captures specifically.",
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
        'List synthesized memory objects (Tier 2) with optional filters by type, domain, or recency. Use this when you want to browse what has been consolidated — e.g. all profiles of people, all active synthesis objects for a domain, or recently updated principles. For semantic search by meaning across all tiers, use search_memory instead.',
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
      description: 'Get a combined stats summary across all memory tiers: raw thought totals by type (Tier 1) plus memory object totals by type and domain (Tier 2), with the most recent object per type. Use this instead of thought_stats when you want a full picture of the knowledge base, not just raw captures.',
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
        'Save a new raw thought to the Open Brain (Tier 1). Generates an embedding and extracts metadata automatically. Use this to capture a new observation, task, idea, reference, or person note in the moment. This is the intake layer — unprocessed, append-only. For saving synthesized knowledge, profiles of people, or durable principles, use capture_memory_object instead.',
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

  // Extension tools — registered after built-ins
  for (const tool of extensionTools) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }

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

// Factory — call once at startup with the loaded extension tools.
// Returns an Express route handler that creates a fresh McpServer per request.
function createHandleMcp(extensionTools) {
  return async function handleMcp(req, res) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    const server = createMcpServer(extensionTools);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

module.exports = { checkAuth, createHandleMcp };
