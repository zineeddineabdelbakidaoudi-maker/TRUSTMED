const express = require('express');
const { createClient } = require('redis');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');
const { getChannel } = require('../../../shared/queue/connection');

const router = express.Router();
let redisClient = null;

async function initRedis() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redisClient.on('error', (err) => logger.error('Recheck Redis Client Error', { error: err.message }));
    try {
      await redisClient.connect();
    } catch (err) {
      logger.error('Recheck Redis Client Connect Error', { error: err.message });
      redisClient = null;
    }
  }
}

// POST /v1/verify/recheck/:practitioner_id
router.post('/recheck/:practitioner_id', async (req, res) => {
  const { practitioner_id } = req.params;
  const partnerId = req.auth.sub; // from requireAuth middleware (practitioner or partner JWT)

  await initRedis();

  try {
    const cacheKey = `recheck:${practitioner_id}`;

    if (redisClient) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        return res.json({ ...cachedData, cached: true });
      }
    }

    const result = await pool.query(
      `SELECT id, trustmed_id, cnom_number, full_name, specialty, trust_score, badge_level, verification_status, last_cnom_check
       FROM practitioners
       WHERE id = $1`,
      [practitioner_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'practitioner_not_found', message: 'Practitioner not found' });
    }

    const p = result.rows[0];

    if (p.verification_status === 'FROZEN' || p.verification_status === 'REJECTED' || p.verification_status === 'RETIRED') {
      return res.json({
        practitioner_id: p.id,
        trustmed_id: p.trustmed_id,
        trust_score: 0,
        badge_level: 'NONE',
        verification_status: p.verification_status,
        last_cnom_check: p.last_cnom_check,
        recheck_queued: false,
        cached: false
      });
    }

    if (p.cnom_number) {
      const channel = getChannel();
      if (channel) {
        channel.publish('trustmed_exchange', 'verify.cnom', Buffer.from(JSON.stringify({
          practitioner_id: p.id,
          cnom_number: p.cnom_number,
          full_name: p.full_name,
          specialty: p.specialty,
          triggered_by: 'PARTNER_RECHECK',
          partner_id: partnerId
        })));
      }
    }

    await writeAuditLog({
      actorId: partnerId,
      actorType: 'partner',
      action: 'PARTNER_RECHECK_REQUESTED',
      targetId: practitioner_id,
      ipAddress: req.ip
    });

    logger.info('Partner requested CNOM recheck', { partnerId, practitioner_id });

    return res.json({
      practitioner_id: p.id,
      trustmed_id: p.trustmed_id,
      trust_score: p.trust_score,
      badge_level: p.badge_level,
      verification_status: p.verification_status,
      last_cnom_check: p.last_cnom_check,
      recheck_queued: !!p.cnom_number,
      note: p.cnom_number ? "Fresh CNOM check queued. Badge reflects last known status." : "Practitioner does not have a CNOM number.",
      cached: false
    });
  } catch (err) {
    logger.error('Error in partner recheck', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

module.exports = router;
