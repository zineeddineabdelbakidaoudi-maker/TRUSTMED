/**
 * generate-keys.js — RSA keypair generator for JWT RS256 signing.
 *
 * Prints base64-encoded PEM keys to console.
 * Copy the output into your .env file as JWT_PRIVATE_KEY and JWT_PUBLIC_KEY.
 *
 * IMPORTANT: Keys are NEVER stored as files in the project.
 *
 * Usage: node generate-keys.js
 */
const crypto = require('crypto');

console.log('\n🔐 Generating RSA-2048 keypair for JWT RS256 signing...\n');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

const privateB64 = Buffer.from(privateKey).toString('base64');
const publicB64 = Buffer.from(publicKey).toString('base64');

console.log('═══════════════════════════════════════════════════');
console.log('Add these to your .env file:');
console.log('═══════════════════════════════════════════════════\n');
console.log(`JWT_PRIVATE_KEY=${privateB64}\n`);
console.log(`JWT_PUBLIC_KEY=${publicB64}\n`);
console.log('═══════════════════════════════════════════════════');
console.log('⚠️  NEVER commit these keys to version control.');
console.log('⚠️  NEVER store them as .pem files in the project.');
console.log('═══════════════════════════════════════════════════\n');
