const express = require('express');
const { createClient } = require('redis');
const logger = require('../../../shared/logger');
const BadgeService = require('../BadgeService');

const router = express.Router();
const badgeService = new BadgeService();

let redisClient = null;
const CACHE_TTL = 300; // 5 minutes

// Initialize Redis for caching and rate limiting
async function initRedis() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redisClient.on('error', (err) => logger.error('Badge Redis Client Error', { error: err.message }));
    try {
      await redisClient.connect();
    } catch (err) {
      logger.error('Badge Redis Client Connect Error', { error: err.message });
      redisClient = null;
    }
  }
}

// Simple Redis-backed rate limiter for public routes (60 req/min/IP)
async function rateLimit(req, res, next) {
  if (!redisClient) {
    return next(); // Fallback if Redis is down
  }

  const ip = req.ip;
  const key = `rate_limit:badge:${ip}`;
  
  try {
    const requests = await redisClient.incr(key);
    if (requests === 1) {
      await redisClient.expire(key, 60);
    }
    
    if (requests > 60) {
      return res.status(429).json({ error: 'too_many_requests', message: 'Rate limit exceeded' });
    }
    
    next();
  } catch (err) {
    logger.warn('Rate limiter error', { error: err.message });
    next();
  }
}

// Apply init and rate limiting to all routes
router.use(async (req, res, next) => {
  await initRedis();
  next();
});
router.use(rateLimit);

// GET /v1/badge/:practitioner_id.svg
router.get('/:practitioner_id.svg', async (req, res) => {
  const { practitioner_id } = req.params;
  const cacheKey = `badge:svg:${practitioner_id}`;

  try {
    if (redisClient) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
        return res.send(cached);
      }
    }

    const badgeData = await badgeService.getBadgeData(practitioner_id);
    if (!badgeData) {
      return res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="20">Not Found</text></svg>');
    }

    const svg = badgeService.generateSvg(badgeData);

    if (redisClient) {
      await redisClient.setEx(cacheKey, CACHE_TTL, svg);
    }

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
    return res.send(svg);
  } catch (err) {
    logger.error('Error generating badge SVG', { error: err.message });
    return res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="20">Server Error</text></svg>');
  }
});

// GET /v1/badge/:practitioner_id/json
router.get('/:practitioner_id/json', async (req, res) => {
  const { practitioner_id } = req.params;
  const cacheKey = `badge:json:${practitioner_id}`;

  try {
    if (redisClient) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
        return res.send(cached);
      }
    }

    const badgeData = await badgeService.getBadgeData(practitioner_id);
    if (!badgeData) {
      return res.status(404).json({ error: 'not_found', message: 'Badge not found' });
    }

    const json = badgeService.generateJson(badgeData);
    const jsonStr = JSON.stringify(json);

    if (redisClient) {
      await redisClient.setEx(cacheKey, CACHE_TTL, jsonStr);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
    return res.send(jsonStr);
  } catch (err) {
    logger.error('Error generating badge JSON', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// GET /v1/widget/:practitioner_id.js
router.get('/widget/:practitioner_id.js', async (req, res) => {
  const { practitioner_id } = req.params;
  const cacheKey = `badge:widget:${practitioner_id}`;

  try {
    if (redisClient) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
        return res.send(cached);
      }
    }

    const badgeData = await badgeService.getBadgeData(practitioner_id);
    if (!badgeData) {
      return res.status(404).send('console.error("TrustMed Badge: Practitioner not found");');
    }

    const script = badgeService.generateWidgetScript(practitioner_id, badgeData);

    if (redisClient) {
      await redisClient.setEx(cacheKey, CACHE_TTL, script);
    }

    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
    return res.send(script);
  } catch (err) {
    logger.error('Error generating badge widget', { error: err.message });
    return res.status(500).send('console.error("TrustMed Badge: Server Error");');
  }
});

// GET /v1/verify/:practitioner_id
router.get('/verify/:practitioner_id', async (req, res) => {
  const { practitioner_id } = req.params;

  try {
    const badgeData = await badgeService.getBadgeData(practitioner_id);
    if (!badgeData) {
      return res.status(404).send('<h1>404 Not Found</h1><p>Praticien non trouvé.</p>');
    }

    const json = badgeService.generateJson(badgeData);
    
    // Very simple HTML verification page
    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TrustMed - Vérification de ${badgeData.full_name}</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background-color: #f3f4f6; color: #1f2937; display: flex; justify-content: center; padding: 40px 20px; }
        .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); padding: 32px; max-width: 500px; width: 100%; }
        .header { text-align: center; margin-bottom: 24px; }
        .name { font-size: 24px; font-weight: bold; margin: 0 0 8px 0; }
        .specialty { color: #6b7280; font-size: 16px; margin: 0; }
        .badge-box { background: ${json.badge_color}15; border: 2px solid ${json.badge_color}; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px; }
        .badge-title { color: ${json.badge_color}; font-weight: bold; font-size: 20px; margin: 0 0 8px 0; }
        .score { font-size: 36px; font-weight: bold; margin: 0; color: #111827; }
        .score span { font-size: 18px; color: #6b7280; font-weight: normal; }
        .details { border-top: 1px solid #e5e7eb; padding-top: 20px; }
        .detail-row { display: flex; justify-content: space-between; margin-bottom: 12px; }
        .detail-label { color: #6b7280; font-weight: 500; }
        .detail-value { font-weight: bold; text-align: right; }
        .footer { text-align: center; margin-top: 32px; font-size: 14px; color: #9ca3af; }
        .footer a { color: #3b82f6; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1 class="name">${badgeData.full_name}</h1>
          <p class="specialty">${badgeData.specialty || 'Médecin'}</p>
        </div>
        
        <div class="badge-box">
          <h2 class="badge-title">${json.badge_label}</h2>
          <p class="score">${badgeData.trust_score}<span>/100</span></p>
        </div>
        
        <div class="details">
          <div class="detail-row">
            <span class="detail-label">ID TrustMed</span>
            <span class="detail-value">${badgeData.trustmed_id}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Dernière vérification</span>
            <span class="detail-value">${badgeData.verified_at ? new Date(badgeData.verified_at).toLocaleDateString('fr-DZ') : 'En attente'}</span>
          </div>
        </div>
        
        <div class="footer">
          <p>Vérifié par <a href="https://trustmed.dz">TrustMed.dz</a></p>
          <p>La plateforme officielle de vérification des praticiens médicaux en Algérie.</p>
        </div>
      </div>
    </body>
    </html>`;

    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch (err) {
    logger.error('Error generating verification page', { error: err.message });
    return res.status(500).send('<h1>500 Erreur Interne</h1>');
  }
});

module.exports = router;
