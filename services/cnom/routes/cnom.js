/**
 * CNOM Verification Routes (Admin-only)
 * 
 * POST /api/cnom/verify   — Verify single practitioner by CNOM number
 * POST /api/cnom/batch    — Run batch verification on all PROVISIONAL practitioners
 */
const express = require('express');
const { requireAdmin, requireRole } = require('../../admin/middleware/adminAuth');
const CnomScraper = require('../CnomScraper');
const logger = require('../../../shared/logger');

const router = express.Router();
const scraper = new CnomScraper();

// Rate limit: 1 batch per 10 minutes (in-memory flag)
let lastBatchRun = 0;
const BATCH_COOLDOWN_MS = 10 * 60 * 1000;

// POST /api/cnom/verify
router.post('/verify', requireAdmin, async (req, res) => {
  const { cnomNumber, fullName, specialty } = req.body;

  if (!cnomNumber || typeof cnomNumber !== 'string' || cnomNumber.trim().length === 0) {
    return res.status(400).json({ error: 'validation_error', message: 'cnomNumber is required' });
  }

  const sanitizedCnom = cnomNumber.trim().replace(/[^\d\-\/]/g, '');
  const sanitizedName = fullName ? fullName.trim().substring(0, 255) : null;
  const sanitizedSpecialty = specialty ? specialty.trim().substring(0, 100) : null;

  try {
    const result = await scraper.matchPractitioner(sanitizedCnom, sanitizedName, sanitizedSpecialty);
    logger.info('CNOM verify completed', { cnomNumber: sanitizedCnom, result: result.result });
    return res.json(result);
  } catch (err) {
    logger.error('CNOM verify failed', { error: err.message, cnomNumber: sanitizedCnom });
    return res.status(500).json({ error: 'verification_failed', message: err.message });
  }
});

// POST /api/cnom/batch
router.post('/batch', requireAdmin, requireRole('ADMIN'), async (req, res) => {
  const now = Date.now();
  if (now - lastBatchRun < BATCH_COOLDOWN_MS) {
    const retryAfter = Math.ceil((BATCH_COOLDOWN_MS - (now - lastBatchRun)) / 1000);
    return res.status(429).json({
      error: 'rate_limited',
      message: `Batch verification can only run once every 10 minutes`,
      retry_after_seconds: retryAfter,
    });
  }

  lastBatchRun = now;

  try {
    const result = await scraper.runBatchVerification();
    logger.info('CNOM batch verification completed', result);
    return res.json(result);
  } catch (err) {
    logger.error('CNOM batch verification failed', { error: err.message });
    return res.status(500).json({ error: 'batch_failed', message: err.message });
  }
});

module.exports = router;
