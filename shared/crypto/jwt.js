const jwt = require('jsonwebtoken');
const logger = require('../logger');

/**
 * Decode base64-encoded PEM keys from environment variables.
 * Keys are stored as base64 in .env to avoid multiline issues.
 */
function getPrivateKey() {
  const b64 = process.env.JWT_PRIVATE_KEY;
  if (!b64) throw new Error('JWT_PRIVATE_KEY environment variable is not set');
  return Buffer.from(b64, 'base64').toString('utf8');
}

function getPublicKey() {
  const b64 = process.env.JWT_PUBLIC_KEY;
  if (!b64) throw new Error('JWT_PUBLIC_KEY environment variable is not set');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Sign a JWT with RS256 using the private key from environment.
 * @param {object} payload - JWT payload
 * @param {object} [options] - jsonwebtoken sign options
 * @returns {string} Signed JWT
 */
function signToken(payload, options = {}) {
  const privateKey = getPrivateKey();
  const defaults = {
    algorithm: 'RS256',
    expiresIn: '1h',
    issuer: 'trustmed',
  };
  return jwt.sign(payload, privateKey, { ...defaults, ...options });
}

/**
 * Verify and decode a JWT with RS256 using the public key from environment.
 * @param {string} token - The JWT to verify
 * @returns {object} Decoded payload
 * @throws {Error} If token is invalid or expired
 */
function verifyToken(token) {
  const publicKey = getPublicKey();
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: 'trustmed',
  });
}

module.exports = { signToken, verifyToken, getPublicKey };
