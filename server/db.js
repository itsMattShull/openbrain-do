'use strict';

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err);
});

// Format a number[] as a pgvector literal: [0.1, 0.2, ...]
function formatVector(arr) {
  return '[' + arr.join(',') + ']';
}

module.exports = { pool, formatVector };
