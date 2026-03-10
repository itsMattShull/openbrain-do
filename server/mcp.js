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

  // Tool 4: Capture a new thought from an MCP client
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
