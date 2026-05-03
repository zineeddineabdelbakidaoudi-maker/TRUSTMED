require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./shared/db/pool');

async function createAdmin() {
  const email = process.argv[2] || 'admin@trustmed.dz';
  const password = process.argv[3] || 'UltraSecureAdmin2026!';
  const fullName = 'System Administrator';

  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`
      INSERT INTO admin_users (email, password_hash, full_name, role)
      VALUES ($1, $2, $3, 'ADMIN')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    `, [email, hash, fullName]);
    
    console.log(`\n✅ Admin account created/updated successfully!`);
    console.log(`Email: ${email}`);
    console.log(`Password: ${password}`);
    console.log(`\nYou can now log in to the dashboard.\n`);
    process.exit(0);
  } catch (err) {
    console.error('Failed to create admin:', err);
    process.exit(1);
  }
}

createAdmin();
