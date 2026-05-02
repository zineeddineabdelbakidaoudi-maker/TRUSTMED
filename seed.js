/**
 * seed.js — Seeds the database with test data for development.
 *
 * Creates:
 *   1. A test partner (client_id: test_client_001)
 *   2. A test practitioner (TM-19-26-0847)
 *   3. A verification session with a valid auth_code (60s TTL)
 *
 * Usage: node seed.js
 */
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT, 10) || 5432,
  user: process.env.PGUSER || 'trustmed',
  password: process.env.PGPASSWORD || 'change_me_in_production',
  database: process.env.PGDATABASE || 'trustmed',
});

const BCRYPT_SALT_ROUNDS = 12;

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. Create test partner ──
    const clientSecret = 'secret123';
    const hashedSecret = await bcrypt.hash(clientSecret, BCRYPT_SALT_ROUNDS);

    const partnerResult = await client.query(
      `INSERT INTO partners (name, client_id, client_secret, redirect_uris, allowed_scopes, webhook_url, webhook_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_id) DO UPDATE SET
         client_secret = EXCLUDED.client_secret,
         redirect_uris = EXCLUDED.redirect_uris,
         webhook_url = EXCLUDED.webhook_url
       RETURNING id, client_id`,
      [
        'TestApp (Doctome.dz)',
        'test_client_001',
        hashedSecret,
        ['http://localhost:3001/callback'],
        ['identity', 'cnom'],
        'http://localhost:3001/webhook',
        'test_webhook_secret_key',
      ]
    );

    const partnerId = partnerResult.rows[0].id;
    console.log(`  ✅ Partner created: client_id=test_client_001 (secret: ${clientSecret})`);

    // ── 2. Create test practitioner ──
    const nfcHash = crypto.createHash('sha256').update('test-nfc-chip-uid').digest('hex');

    const practResult = await client.query(
      `INSERT INTO practitioners (trustmed_id, nfc_identity_hash, full_name, cin_number, specialty, wilaya_code, verification_status, trust_score, badge_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (trustmed_id) DO UPDATE SET
         verification_status = EXCLUDED.verification_status,
         trust_score = EXCLUDED.trust_score,
         badge_level = EXCLUDED.badge_level
       RETURNING id, trustmed_id`,
      [
        'TM-19-26-0847',
        nfcHash,
        'Dr. Ahmed Benmoussa',
        '119990847',
        'Cardiologie',
        19,  // Sétif
        'IDENTITY_PENDING',
        0,
        'NONE',
      ]
    );

    const practitionerId = practResult.rows[0].id;
    console.log(`  ✅ Practitioner created: ${practResult.rows[0].trustmed_id} (id: ${practitionerId})`);

    // ── 3. Create verification session with auth_code ──
    const authCode = crypto.randomBytes(32).toString('hex');
    const authCodeExp = new Date(Date.now() + 60 * 1000); // 60 seconds

    await client.query(
      `INSERT INTO verification_sessions 
       (practitioner_id, partner_id, auth_code, auth_code_exp, state, redirect_uri, scopes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
      [
        practitionerId,
        partnerId,
        authCode,
        authCodeExp,
        'abc123csrf',
        'http://localhost:3001/callback',
        ['identity', 'cnom'],
      ]
    );

    console.log(`  ✅ Verification session created with auth_code`);
    console.log(`     auth_code: ${authCode}`);
    console.log(`     expires:   ${authCodeExp.toISOString()}`);

    // ── 4. Audit log entries ──
    await client.query(
      `INSERT INTO audit_log (actor_id, actor_type, action, target_id, metadata)
       VALUES ($1, 'system', 'SEED_DATA_CREATED', $2, $3)`,
      [partnerId, practitionerId, JSON.stringify({ seeded: true })]
    );

    await client.query('COMMIT');

    console.log('\n  ═══════════════════════════════════════════════');
    console.log('  Test with:');
    console.log(`  curl -X POST http://localhost:8000/oauth/token \\`);
    console.log(`    -H "Content-Type: application/x-www-form-urlencoded" \\`);
    console.log(`    -d "client_id=test_client_001&client_secret=${clientSecret}&code=${authCode}&redirect_uri=http://localhost:3001/callback"`);
    console.log('  ═══════════════════════════════════════════════\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

console.log('\n🌱 TrustMed — Seeding database...\n');
seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
