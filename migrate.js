/**
 * migrate.js — Sequential migration runner for TrustMed.
 *
 * Reads SQL files from ./migrations/ in alphabetical order,
 * tracks applied migrations in a _migrations table,
 * and runs only new migrations.
 *
 * Usage: node migrate.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT, 10) || 5432,
  user: process.env.PGUSER || 'trustmed',
  password: process.env.PGPASSWORD || 'change_me_in_production',
  database: process.env.PGDATABASE || 'trustmed',
});

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
  const client = await pool.connect();

  try {
    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get list of already applied migrations
    const applied = await client.query('SELECT name FROM _migrations ORDER BY name');
    const appliedSet = new Set(applied.rows.map((r) => r.name));

    // Read migration files sorted alphabetically
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  ⏭  Skipping (already applied): ${file}`);
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      console.log(`  ▶  Running migration: ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  ✅ Applied: ${file}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌ Failed: ${file}`);
        console.error(`     Error: ${err.message}`);
        process.exit(1);
      }
    }

    if (count === 0) {
      console.log('\n  All migrations are up to date.\n');
    } else {
      console.log(`\n  ✅ Successfully applied ${count} migration(s).\n`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

console.log('\n🔄 TrustMed — Running database migrations...\n');
migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
