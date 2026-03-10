'use strict';

require('dotenv').config();

const express = require('express');
const { handleIngest } = require('./ingest');
const { checkAuth, handleMcp } = require('./mcp');

const PORT = process.env.PORT || 3000;
const app = express();

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Discord ingest — must receive the raw body string for Ed25519 signature verification
app.post('/ingest', express.text({ type: 'application/json' }), handleIngest);

// MCP server — POST (RPC calls) and GET (SSE event stream)
app.post('/mcp', checkAuth, express.json(), handleMcp);
app.get('/mcp', checkAuth, handleMcp);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  process.exit(0);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenBrain listening on port ${PORT}`);
  console.log(`  POST /ingest  — Discord webhook`);
  console.log(`  POST /mcp     — MCP RPC`);
  console.log(`  GET  /mcp     — MCP SSE stream`);
});
