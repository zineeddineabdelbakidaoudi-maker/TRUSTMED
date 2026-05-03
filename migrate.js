const fs = require('fs');
const path = require('path');
const pool = require('./shared/db/pool');

async function runMigrations() {
  console.log("DEBUG: DATABASE_URL exists?", !!process.env.DATABASE_URL);
  if (!process.env.DATABASE_URL) {
    console.log("CRITICAL ERROR: DATABASE_URL is completely missing from Render environment variables!");
    console.log("Current keys in process.env:", Object.keys(process.env).join(', '));
  }
  
  const migrationsDir = path.join(__dirname, 'migrations');
  
  if (!fs.existsSync(migrationsDir)) {
    console.log('No migrations directory found.');
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // Run in alphabetical order (001_, 002_, etc.)

  console.log(`Found ${files.length} migration files. Starting...`);

  const client = await pool.connect();
  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const file of files) {
      // Check if already applied
      const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [file]);
      
      if (rows.length === 0) {
        console.log(`Applying migration: ${file}...`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
          console.log(`✅ Applied ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`❌ Failed to apply ${file}:`, err.message);
          throw err;
        }
      } else {
        console.log(`⏭️  Skipping ${file} (already applied)`);
      }
    }
    
    console.log('All migrations applied successfully!');
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

runMigrations().then(() => process.exit(0));
