'use strict';

const fs = require('fs');
const path = require('path');
const { pool, formatVector } = require('./db');
const { getEmbedding, extractMetadata } = require('./utils');

const EXTENSIONS_DIR = path.resolve(__dirname, '..', 'extensions');

function buildContext() {
  return Object.freeze({ pool, formatVector, getEmbedding, extractMetadata });
}

async function loadExtensions() {
  const context = buildContext();
  const tools = [];

  if (!fs.existsSync(EXTENSIONS_DIR)) {
    console.log('Extensions: no extensions/ directory found, skipping');
    return tools;
  }

  const entries = fs.readdirSync(EXTENSIONS_DIR).sort();

  for (const entry of entries) {
    // Skip template/private directories (start with _)
    if (entry.startsWith('_')) continue;

    const extDir = path.join(EXTENSIONS_DIR, entry);
    const stat = fs.statSync(extDir);
    if (!stat.isDirectory()) continue;

    const indexPath = path.join(extDir, 'index.js');
    if (!fs.existsSync(indexPath)) {
      console.warn(`Extensions: "${entry}" has no index.js, skipping`);
      continue;
    }

    // Run schema.sql if present — safe to rerun (all statements use IF NOT EXISTS)
    const schemaPath = path.join(extDir, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      try {
        const sql = fs.readFileSync(schemaPath, 'utf8');
        await pool.query(sql);
        console.log(`Extensions: schema applied for "${entry}"`);
      } catch (err) {
        console.error(`Extensions: schema failed for "${entry}":`, err.message);
        continue;
      }
    }

    // Load the extension module
    let ext;
    try {
      ext = require(indexPath);
    } catch (err) {
      console.error(`Extensions: failed to load "${entry}":`, err.message);
      continue;
    }

    // Validate required fields
    if (!ext.name || typeof ext.name !== 'string') {
      console.error(`Extensions: "${entry}/index.js" missing required string "name", skipping`);
      continue;
    }
    if (!Array.isArray(ext.tools) || ext.tools.length === 0) {
      console.error(`Extensions: "${ext.name}" has no tools array, skipping`);
      continue;
    }

    // Run optional setup
    if (ext.setup) {
      try {
        await ext.setup(context);
        console.log(`Extensions: setup complete for "${ext.name}"`);
      } catch (err) {
        console.error(`Extensions: setup failed for "${ext.name}":`, err.message);
        continue;
      }
    }

    // Collect tools, injecting context as second handler argument
    for (const tool of ext.tools) {
      if (!tool.name || !tool.config || typeof tool.handler !== 'function') {
        console.error(`Extensions: "${ext.name}" has a tool missing name/config/handler, skipping that tool`);
        continue;
      }
      const boundHandler = (args) => tool.handler(args, context);
      tools.push({ name: tool.name, config: tool.config, handler: boundHandler });
      console.log(`Extensions: registered tool "${tool.name}" from "${ext.name}"`);
    }
  }

  return tools;
}

module.exports = { loadExtensions };
