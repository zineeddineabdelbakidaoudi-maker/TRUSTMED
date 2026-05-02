const Redis = require('ioredis');
const logger = require('../../../shared/logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;
try {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
  });
  redis.on('error', (err) => {
    logger.error('Redis connection error', { error: err.message });
  });
} catch (err) {
  logger.error('Failed to initialize Redis', { error: err.message });
}

/**
 * Rate limiter middleware: 10 requests per minute per IP.
 * Uses Redis sliding window counter.
 */
function rateLimiter(maxRequests = 10, windowSeconds = 60) {
  return async (req, res, next) => {
    if (!redis || redis.status !== 'ready') {
      logger.warn('Redis unavailable — skipping rate limit');
      return next();
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `ratelimit:oauth_token:${ip}`;

    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - current));

      if (current > maxRequests) {
        logger.warn('Rate limit exceeded', { ip, current, maxRequests });
        return res.status(429).json({
          error: 'too_many_requests',
          message: `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowSeconds} seconds.`,
          retry_after: windowSeconds,
        });
      }

      next();
    } catch (err) {
      logger.error('Rate limiter error', { error: err.message });
      next(); // fail open — don't block requests if Redis has issues
    }
  };
}

module.exports = rateLimiter;
