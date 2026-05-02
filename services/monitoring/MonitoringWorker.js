require('dotenv').config();
const cron = require('node-cron');
const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');
const EmailService = require('../notifications/EmailService');
const { connectQueue, getChannel } = require('../../shared/queue/connection');

const emailService = new EmailService();

async function start() {
  logger.info('MonitoringWorker starting...');
  await connectQueue();

  // JOB 1: Sunday 3 AM — Re-verify FULLY_VERIFIED practitioners
  cron.schedule('0 3 * * 0', async () => {
    logger.info('Running JOB 1: Re-verify FULLY_VERIFIED practitioners');
    try {
      const result = await pool.query(`
        SELECT id, cnom_number, full_name, specialty
        FROM practitioners
        WHERE badge_level = 'FULLY_VERIFIED'
          AND cnom_number IS NOT NULL
          AND (last_cnom_check IS NULL OR last_cnom_check < NOW() - INTERVAL '30 days')
        LIMIT 100
      `);

      const channel = getChannel();
      let published = 0;

      for (const p of result.rows) {
        if (channel) {
          channel.publish('trustmed_exchange', 'verify.cnom', Buffer.from(JSON.stringify({
            practitioner_id: p.id,
            cnom_number: p.cnom_number,
            full_name: p.full_name,
            specialty: p.specialty
          })));
          published++;
        }
      }

      await writeAuditLog({
        actorType: 'system',
        action: 'BATCH_REVERIFY_CNOM',
        metadata: { count: published },
      });

      logger.info(`JOB 1 complete: ${published} practitioners queued for CNOM re-verification`);
    } catch (err) {
      logger.error('Error in JOB 1', { error: err.message });
    }
  }, { timezone: 'Africa/Algiers' });


  // JOB 2: Daily 4 AM — Check expiring documents
  cron.schedule('0 4 * * *', async () => {
    logger.info('Running JOB 2: Check expiring documents');
    try {
      const result = await pool.query(`
        SELECT d.id AS document_id, d.doc_type, d.ocr_result, p.id AS practitioner_id, p.full_name, p.email
        FROM documents d
        JOIN practitioners p ON d.practitioner_id = p.id
        WHERE d.doc_type IN ('CNOM_CARD', 'AGREMENT', 'CIN')
          AND d.status = 'PROCESSED'
          AND d.ocr_result->>'expiry_date' IS NOT NULL
      `);

      const now = new Date();
      let warned = 0;
      let demoted = 0;

      for (const row of result.rows) {
        const expiryDate = new Date(row.ocr_result.expiry_date);
        if (isNaN(expiryDate.getTime())) continue;

        const diffTime = expiryDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays <= 60 && diffDays > 0) {
          if (row.email) {
            await emailService.sendEmail(row.email, 'expiry_warning', {
              full_name: row.full_name,
              doc_type: row.doc_type,
              days_remaining: diffDays
            });
            warned++;
          }
        } else if (diffDays <= 0) {
          await pool.query(`UPDATE practitioners SET badge_level = 'CNOM_CONFIRMED' WHERE id = $1 AND badge_level = 'FULLY_VERIFIED'`, [row.practitioner_id]);
          if (row.email) {
            await emailService.sendEmail(row.email, 'expiry_warning', {
              full_name: row.full_name,
              doc_type: row.doc_type,
              days_remaining: 0
            });
          }
          await writeAuditLog({
            actorType: 'system',
            action: 'BADGE_DEMOTED',
            targetId: row.practitioner_id,
            metadata: { reason: 'DOCUMENT_EXPIRED', document_id: row.document_id, doc_type: row.doc_type },
          });
          demoted++;
        }
      }

      logger.info(`JOB 2 complete: ${warned} warnings sent, ${demoted} badges demoted`);
    } catch (err) {
      logger.error('Error in JOB 2', { error: err.message });
    }
  }, { timezone: 'Africa/Algiers' });


  // JOB 3: Every hour — Escalate stale FROZEN cases
  cron.schedule('0 * * * *', async () => {
    logger.info('Running JOB 3: Escalate stale FROZEN cases');
    try {
      const result = await pool.query(`
        SELECT id
        FROM practitioners
        WHERE verification_status = 'FROZEN'
          AND updated_at < NOW() - INTERVAL '7 days'
      `);

      const channel = getChannel();
      let escalated = 0;

      for (const p of result.rows) {
        if (channel) {
          channel.publish('trustmed_exchange', 'compliance.alert', Buffer.from(JSON.stringify({
            event: 'compliance.fraud_alert.escalation',
            practitioner_id: p.id,
            reason: 'Stale FROZEN case (> 7 days)',
            timestamp: new Date().toISOString()
          })));
          escalated++;
        }

        await writeAuditLog({
          actorType: 'system',
          action: 'FROZEN_CASE_ESCALATED',
          targetId: p.id,
        });
      }

      logger.info(`JOB 3 complete: ${escalated} stale FROZEN cases escalated`);
    } catch (err) {
      logger.error('Error in JOB 3', { error: err.message });
    }
  });

  // JOB 4: Annual Re-Submission Enforcer
  cron.schedule('0 5 * * *', async () => {
    logger.info('Running JOB 4: Annual Re-Submission Enforcer');
    try {
      const result = await pool.query(`
        SELECT *
        FROM practitioners
        WHERE annual_resubmit_due_at IS NOT NULL
          AND badge_level IN ('FULLY_VERIFIED', 'CNOM_CONFIRMED_PLUS', 'CNOM_CONFIRMED')
      `);

      const now = new Date();
      let warned = 0;
      let overdue = 0;

      for (const p of result.rows) {
        const dueAt = new Date(p.annual_resubmit_due_at);
        const lastResubmit = p.last_resubmit_at ? new Date(p.last_resubmit_at) : null;
        const diffTime = dueAt - now;
        const diffDays = Math.ceil(diffTime / 86400000);

        // Case B - OVERDUE
        if (dueAt < now && (!lastResubmit || lastResubmit < dueAt)) {
          await pool.query(
            `UPDATE practitioners SET badge_level = 'CNOM_CONFIRMED' WHERE id = $1`,
            [p.id]
          );
          if (p.email) {
            await emailService.sendEmail(p.email, 'annual_resubmit_overdue', {
              full_name: p.full_name,
              portal_url: process.env.VERIFICATION_PORTAL_URL || 'http://localhost:3000'
            });
          }
          await writeAuditLog({
            actorType: 'system',
            action: 'BADGE_DEMOTED_ANNUAL_RESUBMIT',
            targetId: p.id
          });
          overdue++;
        } 
        // Case A - WARNING
        else if (diffDays > 0 && diffDays <= 30) {
          if (p.email) {
            await emailService.sendEmail(p.email, 'annual_resubmit_warning', {
              full_name: p.full_name,
              days_remaining: diffDays,
              portal_url: process.env.VERIFICATION_PORTAL_URL || 'http://localhost:3000'
            });
          }
          await writeAuditLog({
            actorType: 'system',
            action: 'ANNUAL_RESUBMIT_WARNING_SENT',
            targetId: p.id
          });
          warned++;
        }
      }
      
      logger.info(`JOB 4 complete: ${warned} warnings sent, ${overdue} badges demoted`);
    } catch (err) {
      logger.error('Error in JOB 4', { error: err.message });
    }
  }, { timezone: 'Africa/Algiers' });

  // JOB 5: Monday 3 AM — Trust Graph Analysis
  cron.schedule('0 3 * * 1', async () => {
    logger.info('Running JOB 5: Trust Graph Analysis');
    try {
      const TrustGraphService = require('../graph/TrustGraphService');
      const graphService = new TrustGraphService();
      await graphService.runFullAnalysis(pool);
      logger.info('Trust graph analysis complete');
    } catch (err) {
      logger.error('Error in JOB 5', { error: err.message });
    }
  }, { timezone: 'Africa/Algiers' });

  // JOB 6: Daily 1 AM — Predictive Risk Behavioral Analysis
  cron.schedule('0 1 * * *', async () => {
    logger.info('Running JOB 6: Predictive Risk Analysis');
    try {
      const PredictiveRiskService = require('../risk/PredictiveRiskService');
      const predictive = new PredictiveRiskService();

      // 1. Recompute behavioral baselines
      await predictive.computeBehavioralBaseline(pool);

      // 2. Score all active practitioners
      const practitioners = await pool.query(
        `SELECT id FROM practitioners WHERE verification_status IN ('PROVISIONAL', 'PHONE_VERIFIED', 'NFC_VERIFIED', 'DOCUMENT_SUBMITTED')`
      );

      let anomaliesFound = 0;
      let shadowBansApplied = 0;

      for (const row of practitioners.rows) {
        const anomaly = await predictive.scoreSequenceAnomaly(row.id, pool);
        if (anomaly.anomaly_score >= 60) anomaliesFound++;
        await predictive.computeRiskMomentum(row.id, pool);
        const ban = await predictive.evaluateShadowBan(row.id, pool);
        if (ban.shadow_banned) shadowBansApplied++;
      }

      logger.info('Predictive risk analysis complete', {
        baselines_computed: true,
        practitioners_analyzed: practitioners.rows.length,
        anomalies_found: anomaliesFound,
        shadow_bans_applied: shadowBansApplied,
      });
    } catch (err) {
      logger.error('Error in JOB 6', { error: err.message });
    }
  }, { timezone: 'Africa/Algiers' });

  logger.info('MonitoringWorker ready (6 cron jobs scheduled)');
}

if (require.main === module) {
  start().catch(err => {
    logger.error('MonitoringWorker failed to start', { error: err.message });
    process.exit(1);
  });
}

module.exports = { start };
