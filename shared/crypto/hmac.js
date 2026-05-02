const crypto = require('crypto');

const HMAC_SECRET = process.env.HMAC_SECRET || 'dev_hmac_secret_replace_in_production';

/**
 * Create HMAC-SHA256 signature for a given data string.
 * @param {string} data - The data to sign
 * @param {string} [secret] - Optional override secret (for per-partner webhook signing)
 * @returns {string} Hex-encoded HMAC-SHA256 signature
 */
function sign(data, secret) {
  return crypto
    .createHmac('sha256', secret || HMAC_SECRET)
    .update(data, 'utf8')
    .digest('hex');
}

/**
 * Verify an HMAC-SHA256 signature.
 * Uses constant-time comparison to prevent timing attacks.
 * @param {string} data      - The original data
 * @param {string} signature - The signature to verify
 * @param {string} [secret]  - Optional override secret
 * @returns {boolean}
 */
function verify(data, signature, secret) {
  const expected = sign(data, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const signatureBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

module.exports = { sign, verify };
