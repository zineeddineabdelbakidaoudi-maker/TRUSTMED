/**
 * CnomWorker — Scheduled + on-demand CNOM verification worker.
 *
 * Cron: every night at 2 AM → CnomScraper.runBatchVerification()
 * RabbitMQ: VERIFY_CNOM queue → on-demand verification
 *
 * Start as: node services/cnom/CnomWorker.js
 */
require('dotenv').config();
const cron = require('node-cron');
const { connectQueue, getChannel } = require('../../shared/queue/connection');
const { writeAuditLog } = require('../../shared/db/audit');
const CnomScraper = require('./CnomScraper');
const logger = require('../../shared/logger');

const VERIFY_CNOM_QUEUE = 'verify_cnom';
const scraper = new CnomScraper();

/**
 * Handle a single on-demand CNOM verification job.
 */
async function processVerifyCnomJob(job) {
  const { practitioner_id, cnom_number, full_name, specialty } = job;

  logger.info('Processing on-demand CNOM verification', {
    practitioner_id,
    cnom_number,
  });

  const result = await scraper.matchPractitioner(cnom_number, full_name, specialty);

  // Insert CNOM verification record
  const pool = require('../../shared/db/pool');
  await pool.query(
    `INSERT INTO cnom_verifications
     (practitioner_id, cnom_number, scraped_name, scraped_specialty, scraped_status,
      source_url, match_score, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      practitioner_id,
      cnom_number,
      result.scraped_data.scraped_name,
      result.scraped_data.scraped_specialty,
      result.scraped_data.scraped_status,
      result.scraped_data.portal_url,
      result.match_score,
      result.result,
    ]
  );

  // Update last_cnom_check
  await pool.query(
    `UPDATE practitioners SET last_cnom_check = NOW() WHERE id = $1`,
    [practitioner_id]
  );

  // If CONFIRMED, trigger VerificationEngine
  if (result.result === 'CONFIRMED') {
    const VerificationEngine = require('../verification/VerificationEngine');
    const engine = new VerificationEngine();
    try {
      await engine.processStep(practitioner_id, 'CNOM_CONFIRMED', {
        cnomNumber: cnom_number,
        scrapedName: result.scraped_data.scraped_name,
        scrapedSpecialty: result.scraped_data.scraped_specialty,
        scrapedStatus: result.scraped_data.scraped_status,
        sourceUrl: result.scraped_data.portal_url,
        matchScore: result.match_score,
        result: 'CONFIRMED',
      });
    } catch (err) {
      logger.warn('CNOM_CONFIRMED engine step failed', { error: err.message, practitioner_id });
    }
  } else if (result.result === 'MISMATCH') {
    // Route to human review
    const docResult = await pool.query(
      `SELECT id FROM documents WHERE practitioner_id = $1 AND doc_type = 'CNOM_CARD' ORDER BY created_at DESC LIMIT 1`,
      [practitioner_id]
    );
    const docId = docResult.rows.length > 0 ? docResult.rows[0].id : practitioner_id;
    await pool.query(
      `INSERT INTO reviewer_queue (practitioner_id, document_id, reason)
       VALUES ($1, $2, $3)`,
      [practitioner_id, docId, `CNOM_MISMATCH: score=${result.match_score}`]
    );
  } else if (result.result === 'RETIRED') {
    const practResult = await pool.query('SELECT email, full_name, trustmed_id FROM practitioners WHERE id = $1', [practitioner_id]);
    const p = practResult.rows[0];

    await pool.query(
      `UPDATE practitioners SET verification_status = 'RETIRED', badge_level = 'NONE', trust_score = 0, updated_at = NOW() WHERE id = $1`,
      [practitioner_id]
    );

    if (p && p.email) {
      const EmailService = require('../notifications/EmailService');
      const emailService = new EmailService();
      await emailService.sendEmail(p.email, 'profile_deactivated_retired', { full_name: p.full_name });
    }

    const WebhookDispatcher = require('../webhook/WebhookDispatcher');
    const webhookDispatcher = new WebhookDispatcher();
    
    const partnersResult = await pool.query(
      `SELECT DISTINCT partner_id FROM verification_sessions WHERE practitioner_id = $1`,
      [practitioner_id]
    );

    for (const row of partnersResult.rows) {
      const partnerRes = await pool.query('SELECT webhook_url, webhook_secret FROM partners WHERE id = $1', [row.partner_id]);
      if (partnerRes.rows.length > 0) {
        const partner = partnerRes.rows[0];
        if (partner.webhook_url) {
          await webhookDispatcher.dispatch({
            url: partner.webhook_url,
            secret: partner.webhook_secret || process.env.HMAC_SECRET,
            payload: {
              event: 'PRACTITIONER_DEACTIVATED',
              practitioner_id,
              trustmed_id: p ? p.trustmed_id : null,
              reason: 'CNOM_STATUS_RETIRED',
              trust_score: 0,
              badge_level: 'NONE',
              timestamp: new Date().toISOString()
            }
          });
        }
      }
    }
  }

  // Update Redis cache for recheck endpoint
  const finalState = await pool.query('SELECT trust_score, badge_level, verification_status FROM practitioners WHERE id = $1', [practitioner_id]);
  if (finalState.rows.length > 0) {
    const pFinal = finalState.rows[0];
    const { createClient } = require('redis');
    const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    try {
      await redisClient.connect();
      const cacheData = JSON.stringify({
        trust_score: pFinal.trust_score,
        badge_level: pFinal.badge_level,
        verification_status: pFinal.verification_status,
        checked_at: new Date().toISOString()
      });
      await redisClient.setEx(`recheck:${practitioner_id}`, 86400, cacheData);
      await redisClient.quit();
    } catch (err) {
      logger.warn('Failed to update Redis cache for recheck', { error: err.message });
    }
  }

  await writeAuditLog({
    actorType: 'system',
    action: 'CNOM_VERIFICATION_ON_DEMAND',
    targetId: practitioner_id,
    metadata: {
      cnom_number,
      match_score: result.match_score,
      result: result.result,
    },
  });

  logger.info('On-demand CNOM verification complete', {
    practitioner_id,
    result: result.result,
    match_score: result.match_score,
  });

  return result;
}

/**
 * Start the CNOM worker: cron scheduler + RabbitMQ consumer.
 */
async function start() {
  logger.info('CnomWorker starting...');

  // ── Schedule nightly batch verification at 2:00 AM ──
  cron.schedule('0 2 * * *', async () => {
    logger.info('Nightly CNOM batch verification triggered');
    try {
      const summary = await scraper.runBatchVerification();
      logger.info('Nightly batch complete', summary);
    } catch (err) {
      logger.error('Nightly CNOM batch failed', { error: err.message });
    }
  }, {
    timezone: 'Africa/Algiers',
  });

  logger.info('CNOM batch cron scheduled: 0 2 * * * (Africa/Algiers)');

  // ── Start RabbitMQ consumer for on-demand verification ──
  try {
    await connectQueue();
    const channel = getChannel();
    await channel.assertQueue(VERIFY_CNOM_QUEUE, { durable: true });
    channel.prefetch(1);

    logger.info(`CnomWorker consuming from queue: ${VERIFY_CNOM_QUEUE}`);

    channel.consume(VERIFY_CNOM_QUEUE, async (msg) => {
      if (!msg) return;

      try {
        const content = JSON.parse(msg.content.toString());
        const job = content.payload || content;

        await processVerifyCnomJob(job);
        channel.ack(msg);

        logger.info('CNOM verification job acknowledged', {
          practitioner_id: job.practitioner_id,
        });
      } catch (err) {
        logger.error('CNOM verification job failed', { error: err.message });
        channel.nack(msg, false, false);
      }
    });
  } catch (err) {
    logger.warn('RabbitMQ unavailable — cron-only mode', { error: err.message });
  }

  logger.info('CnomWorker ready (cron + queue)');
}

// Run as standalone process
if (require.main === module) {
  start().catch((err) => {
    logger.error('CnomWorker failed to start', { error: err.message });
    process.exit(1);
  });
}

module.exports = { processVerifyCnomJob, start, VERIFY_CNOM_QUEUE };
