'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// EXTENSION TEMPLATE
//
// Copy this directory, rename it (e.g. extensions/my-feature/), and fill it in.
// Directories starting with _ are skipped by the loader — rename to activate.
//
// This file must export: { name, tools[], setup? }
//
//   name     — unique string, used in logs (required)
//   tools    — array of MCP tool definitions (required, at least one)
//   setup    — async function called once at startup, after schema.sql runs (optional)
//
// Each tool definition:
//   name     — the MCP tool name (snake_case)
//   config   — { title, description, inputSchema } — inputSchema uses Zod fields
//   handler  — async (args, context) => { content: [{ type: 'text', text: '...' }] }
//
// context contains:
//   context.pool           — pg Pool for database queries
//   context.formatVector   — formats number[] as pgvector literal
//   context.getEmbedding   — async (text) => number[]  (OpenRouter embeddings)
//   context.extractMetadata — async (text) => { topics, type, people, action_items, ... }
// ─────────────────────────────────────────────────────────────────────────────

const { z } = require('zod');

module.exports = {
  name: 'my-extension',   // ← change this

  // Optional: runs once at startup after schema.sql has been applied.
  // Use for seed data, sanity checks, or anything beyond table creation.
  async setup(context) {
    // Example: verify connectivity
    // await context.pool.query('SELECT 1');
    // console.log('my-extension: setup complete');
  },

  tools: [
    {
      name: 'add_my_item',          // ← change this
      config: {
        title: 'Add My Item',       // ← change this
        description: 'Add a new item.',  // ← write a clear description for the AI
        inputSchema: {
          name: z.string().describe('Item name'),
          notes: z.string().optional(),
        },
      },
      async handler({ name, notes }, context) {
        try {
          const { rows } = await context.pool.query(
            `INSERT INTO my_items (name, notes) VALUES ($1, $2) RETURNING id, name`,
            [name, notes || null]
          );
          return { content: [{ type: 'text', text: `Added "${rows[0].name}" — ID: ${rows[0].id}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'list_my_items',        // ← change this
      config: {
        title: 'List My Items',
        description: 'List all items.',
        inputSchema: {
          limit: z.number().optional().default(20),
        },
      },
      async handler({ limit }, context) {
        try {
          const { rows } = await context.pool.query(
            `SELECT id, name, notes, created_at FROM my_items ORDER BY created_at DESC LIMIT $1`,
            [limit ?? 20]
          );
          if (!rows.length) return { content: [{ type: 'text', text: 'No items yet.' }] };
          const lines = rows.map((r, i) => `${i + 1}. ${r.name}${r.notes ? ` — ${r.notes}` : ''}`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    // Add more tools here following the same pattern.
    // Tools that need semantic search can use context.getEmbedding:
    //
    // async handler({ query }, context) {
    //   const embedding = await context.getEmbedding(query);
    //   const vec = context.formatVector(embedding);
    //   const { rows } = await context.pool.query(`SELECT ... WHERE embedding <=> $1 ...`, [vec]);
    //   ...
    // }
  ],
};
