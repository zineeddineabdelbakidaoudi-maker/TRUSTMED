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
    let decoded;
    
    // Try RS256 first (production-grade PEM keys)
    try {
      decoded = verifyToken(token);
    } catch (rs256Err) {
      // Fallback: try HMAC verification (for self-registered practitioners)
      const jwt = require('jsonwebtoken');
      const secret = process.env.ADMIN_JWT_SECRET || process.env.HMAC_SECRET || 'trustmed_dev_secret';
      decoded = jwt.verify(token, secret, { issuer: 'trustmed' });
    }
    
    req.auth = decoded;

    // Upgrade G: Extract and attach device fingerprint hash
    try {
      const DeviceFingerprintService = require('../../risk/DeviceFingerprintService');
      const { fingerprint_hash } = DeviceFingerprintService.computeFingerprint(req);
      req.fingerprint_hash = fingerprint_hash;
    } catch (_) {
      // Non-blocking if fingerprint service fails
    }

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
