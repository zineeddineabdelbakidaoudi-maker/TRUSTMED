const { verifyToken } = require('../../../shared/crypto/jwt');
const logger = require('../../../shared/logger');

/**
 * JWT Bearer token authentication middleware.
 * Extracts token from Authorization header, verifies RS256 signature,
 * and attaches decoded payload to req.auth.
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid Authorization header. Use: Bearer <token>',
    });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = verifyToken(token);
    req.auth = decoded;

    // Upgrade G: Extract and attach device fingerprint hash
    const DeviceFingerprintService = require('../../risk/DeviceFingerprintService');
    const { fingerprint_hash } = DeviceFingerprintService.computeFingerprint(req);
    req.fingerprint_hash = fingerprint_hash;

    next();
  } catch (err) {
    logger.warn('JWT verification failed', { error: err.message });

    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'token_expired',
        message: 'Access token has expired. Please re-authenticate.',
      });
    }

    return res.status(401).json({
      error: 'invalid_token',
      message: 'Access token is invalid.',
    });
  }
}

module.exports = authenticate;
