const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');
const EmailService = require('../notifications/EmailService');

const emailService = new EmailService();
const STAKE_AMOUNT_DZD = parseInt(process.env.STAKE_AMOUNT_DZD || '500', 10);

class EconomicDefenseService {
  /**
   * Compute friction level based on risk_score.
   * @param {object} practitioner - Row from practitioners table
   * @returns {{ level: string, reason: string, delay_hours: number }}
   */
  computeFrictionLevel(practitioner) {
    const risk = practitioner.risk_score || 0;

    if (risk >= 70) {
      return { level: 'PAYMENT', reason: 'High risk requires stake deposit', delay_hours: 0 };
    }
    if (risk >= 50) {
      return { level: 'REVIEW', reason: 'Elevated risk requires admin review', delay_hours: 0 };
    }
    if (risk >= 30) {
      return { level: 'DELAY', reason: 'Moderate risk triggers processing delay', delay_hours: 24 };
    }
    return { level: 'NONE', reason: 'Normal processing', delay_hours: 0 };
  }

  /**
   * Apply a processing delay to a practitioner.
   */
  async applyDelay(practitionerId, delayHours, db = pool) {
    try {
      await db.query(
        `UPDATE practitioners SET can_progress_after = NOW() + INTERVAL '1 hour' * $1 WHERE id = $2`,
        [delayHours, practitionerId]
      );

      await db.query(
        `INSERT INTO progressive_friction_log (practitioner_id, friction_level, reason)
         VALUES ($1, 'DELAY', $2)`,
        [practitionerId, `${delayHours}hr delay applied due to risk score`]
      );

      await writeAuditLog({
        actorType: 'system',
        action: 'FRICTION_DELAY_APPLIED',
        targetId: practitionerId,
        metadata: { delay_hours: delayHours },
      });

      logger.info('Friction delay applied', { practitionerId, delayHours });
    } catch (err) {
      logger.error('applyDelay failed', { practitionerId, error: err.message });
    }
  }

  /**
   * Check if a practitioner is still under a delay.
   * @returns {{ blocked: boolean, retry_after: string|null }}
   */
  async checkDelay(practitioner) {
    if (practitioner.can_progress_after) {
      const canProgressAfter = new Date(practitioner.can_progress_after);
      if (canProgressAfter > new Date()) {
        return { blocked: true, retry_after: canProgressAfter.toISOString() };
      }
    }
    return { blocked: false, retry_after: null };
  }

  /**
   * Record a stake deposit being held.
   */
  async recordStakeHeld(practitionerId, paymentRef, db = pool) {
    try {
      await db.query(
        `INSERT INTO verification_stakes (practitioner_id, amount_dzd, payment_ref)
         VALUES ($1, $2, $3)`,
        [practitionerId, STAKE_AMOUNT_DZD, paymentRef]
      );

      await db.query(
        `UPDATE practitioners SET stake_status = 'HELD', stake_held_at = NOW() WHERE id = $1`,
        [practitionerId]
      );

      await db.query(
        `INSERT INTO progressive_friction_log (practitioner_id, friction_level, reason)
         VALUES ($1, 'PAYMENT', $2)`,
        [practitionerId, `Stake of ${STAKE_AMOUNT_DZD} DZD held`]
      );

      await writeAuditLog({
        actorType: 'system',
        action: 'STAKE_HELD',
        targetId: practitionerId,
        metadata: { amount_dzd: STAKE_AMOUNT_DZD, payment_ref: paymentRef },
      });

      logger.info('Stake held', { practitionerId, amount: STAKE_AMOUNT_DZD });
    } catch (err) {
      logger.error('recordStakeHeld failed', { practitionerId, error: err.message });
      throw err;
    }
  }

  /**
   * Release a stake when practitioner reaches FULLY_VERIFIED with HIGH confidence.
   */
  async releaseStake(practitionerId, db = pool) {
    try {
      await db.query(
        `UPDATE verification_stakes SET status = 'RELEASED', released_at = NOW()
         WHERE practitioner_id = $1 AND status = 'HELD'`,
        [practitionerId]
      );

      await db.query(
        `UPDATE practitioners SET stake_status = 'RELEASED' WHERE id = $1`,
        [practitionerId]
      );

      const practRes = await db.query('SELECT full_name, email FROM practitioners WHERE id = $1', [practitionerId]);
      if (practRes.rows.length > 0 && practRes.rows[0].email) {
        await emailService.sendEmail(practRes.rows[0].email, 'stake_released', {
          full_name: practRes.rows[0].full_name,
          amount: STAKE_AMOUNT_DZD,
        });
      }

      await writeAuditLog({
        actorType: 'system',
        action: 'STAKE_RELEASED',
        targetId: practitionerId,
        metadata: { amount_dzd: STAKE_AMOUNT_DZD },
      });

      logger.info('Stake released', { practitionerId });
    } catch (err) {
      logger.error('releaseStake failed', { practitionerId, error: err.message });
    }
  }

  /**
   * Burn a stake when FREEZE is triggered on a staked practitioner.
   */
  async burnStake(practitionerId, reason, db = pool) {
    try {
      await db.query(
        `UPDATE verification_stakes SET status = 'BURNED', burned_at = NOW(), burn_reason = $1
         WHERE practitioner_id = $2 AND status = 'HELD'`,
        [reason, practitionerId]
      );

      await db.query(
        `UPDATE practitioners SET stake_status = 'BURNED' WHERE id = $1`,
        [practitionerId]
      );

      await writeAuditLog({
        actorType: 'system',
        action: 'STAKE_BURNED',
        targetId: practitionerId,
        metadata: { amount_dzd: STAKE_AMOUNT_DZD, reason },
      });

      logger.warn('Stake burned', { practitionerId, reason });
    } catch (err) {
      logger.error('burnStake failed', { practitionerId, error: err.message });
    }
  }

  /**
   * Enforce friction gates before verification step processing.
   * Call this from VerificationEngine BEFORE processing a step.
   * @throws Error if blocked
   */
  async enforceFriction(practitioner, db = pool) {
    const friction = this.computeFrictionLevel(practitioner);

    if (friction.level === 'NONE') return;

    if (friction.level === 'DELAY') {
      const delayCheck = await this.checkDelay(practitioner);
      if (delayCheck.blocked) {
        const err = new Error(`Processing delayed. Retry after ${delayCheck.retry_after}`);
        err.code = 'FRICTION_DELAY';
        err.retry_after = delayCheck.retry_after;
        throw err;
      }
      // First time hitting delay — apply it
      if (!practitioner.can_progress_after) {
        await this.applyDelay(practitioner.id, friction.delay_hours, db);
        const err = new Error('Processing delay applied. Please retry in 24 hours.');
        err.code = 'FRICTION_DELAY';
        err.retry_after = new Date(Date.now() + friction.delay_hours * 3600000).toISOString();
        throw err;
      }
    }

    if (friction.level === 'REVIEW') {
      // Check for open reviewer_queue items
      const reviewRes = await db.query(
        `SELECT COUNT(*) as cnt FROM reviewer_queue WHERE practitioner_id = $1 AND status = 'PENDING'`,
        [practitioner.id]
      );
      if (parseInt(reviewRes.rows[0].cnt, 10) > 0) {
        const err = new Error('Pending admin review must be completed before continuing');
        err.code = 'FRICTION_REVIEW';
        throw err;
      }
    }

    if (friction.level === 'PAYMENT') {
      if (practitioner.stake_status !== 'HELD') {
        const err = new Error(`Stake deposit of ${STAKE_AMOUNT_DZD} DZD required before continuing`);
        err.code = 'FRICTION_PAYMENT';
        err.amount_dzd = STAKE_AMOUNT_DZD;
        throw err;
      }
    }
  }
}

module.exports = EconomicDefenseService;
