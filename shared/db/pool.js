const { Pool } = require('pg');
const logger = require('../logger');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT, 10) || 5432,
  user: process.env.PGUSER || 'trustmed',
  password: process.env.PGPASSWORD || 'change_me_in_production',
  database: process.env.PGDATABASE || 'trustmed',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

pool.on('connect', () => {
  logger.debug('New PostgreSQL client connected');
});

module.exports = pool;
