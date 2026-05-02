const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');
const VerificationEngine = require('../verification/VerificationEngine');
const EmailService = require('../notifications/EmailService');
const WebhookDispatcher = require('../webhook/WebhookDispatcher');

const VOUCHING_REQUIRED_COUNT = parseInt(process.env.VOUCHING_REQUIRED_COUNT || '2', 10);
const engine = new VerificationEngine();
const emailService = new EmailService();

class VouchingService {
  /**
   * Compute the effective weight of a voucher based on out-degree.
   */
  async computeEffectiveVouchWeight(voucherId, db) {
    const res = await db.query(
      `SELECT COUNT(*) as given_count FROM practitioner_vouches WHERE voucher_id = $1 AND status = 'ACTIVE'`,
      [voucherId]
    );
    const givenCount = parseInt(res.rows[0].given_count, 10);
    const weight = 1.0 / Math.max(givenCount, 1);
    return { voucherId, weight, givenCount };
  }

  /**
   * Compute the effective vouch strength for a subject.
   */
  async computeWeightedVouchScore(subjectId, db) {
    const res = await db.query(
      `SELECT pv.voucher_id FROM practitioner_vouches pv WHERE pv.subject_id = $1 AND pv.status = 'ACTIVE'`,
      [subjectId]
    );

    let sumWeights = 0;
    for (const row of res.rows) {
      const weightInfo = await this.computeEffectiveVouchWeight(row.voucher_id, db);
      sumWeights += weightInfo.weight;
    }

    const effective_vouch_strength = Math.min(1.0, sumWeights / VOUCHING_REQUIRED_COUNT);
    return effective_vouch_strength;
  }

  /**
   * Request a vouch from voucher for subject.
   *
   * @param {string} subjectId  - UUID of the practitioner being vouched for
   * @param {string} voucherId  - UUID of the vouching practitioner
   * @param {string} note       - Optional vouch note
   * @returns {object} { vouched, subject_vouch_count, required, completed }
   */
  async requestVouch(subjectId, voucherId, note) {
    // 1. Cannot vouch for self
    if (subjectId === voucherId) {
      const err = new Error('Cannot vouch for yourself');
      err.code = 'SELF_VOUCH';
      throw err;
    }

    // 2. Fetch voucher — must be FULLY_VERIFIED
    const voucherResult = await pool.query(
      'SELECT id, trust_score, badge_level FROM practitioners WHERE id = $1',
      [voucherId]
    );

    if (voucherResult.rows.length === 0) {
      const err = new Error('Voucher practitioner not found');
      err.code = 'VOUCHER_NOT_FOUND';
      throw err;
    }

    const voucher = voucherResult.rows[0];
    if (voucher.badge_level !== 'FULLY_VERIFIED' || voucher.trust_score < 94) {
      const err = new Error('Voucher must be FULLY_VERIFIED');
      err.code = 'VOUCHER_NOT_QUALIFIED';
      throw err;
    }

    // 3. Check subject exists and current vouch_count
    const subjectResult = await pool.query(
      'SELECT id, vouch_count, full_name FROM practitioners WHERE id = $1',
      [subjectId]
    );

    if (subjectResult.rows.length === 0) {
      const err = new Error('Subject practitioner not found');
      err.code = 'SUBJECT_NOT_FOUND';
      throw err;
    }

    const subject = subjectResult.rows[0];

    // 4. Check not already reached required count
    if (subject.vouch_count >= VOUCHING_REQUIRED_COUNT) {
      const err = new Error('Subject already has enough vouches');
      err.code = 'VOUCHING_ALREADY_COMPLETE';
      throw err;
    }

    // 5. Check no existing ACTIVE vouch from this voucher
    const existingResult = await pool.query(
      'SELECT id FROM practitioner_vouches WHERE voucher_id = $1 AND subject_id = $2 AND status = $3',
      [voucherId, subjectId, 'ACTIVE']
    );

    if (existingResult.rows.length > 0) {
      const err = new Error('You have already vouched for this practitioner');
      err.code = 'ALREADY_VOUCHED';
      throw err;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 6. INSERT vouch
      const weightInfo = await this.computeEffectiveVouchWeight(voucherId, client);

      await client.query(
        `INSERT INTO practitioner_vouches (voucher_id, subject_id, voucher_score, voucher_badge, vouch_note, vouch_weight)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [voucherId, subjectId, voucher.trust_score, voucher.badge_level, note || null, weightInfo.weight]
      );

      // 7. Increment vouch_count
      await client.query(
        'UPDATE practitioners SET vouch_count = vouch_count + 1 WHERE id = $1',
        [subjectId]
      );

      // 8. Audit log
      await writeAuditLog({
        actorId: voucherId,
        actorType: 'practitioner',
        action: 'VOUCH_GIVEN',
        targetId: subjectId,
        metadata: { voucher_score: voucher.trust_score, voucher_badge: voucher.badge_level },
        client,
      });

      await client.query('COMMIT');

      // 9. Check if vouching is now complete
      const newCount = subject.vouch_count + 1;
      const strength = await this.computeWeightedVouchScore(subjectId, client);

      await client.query(
        'UPDATE practitioners SET effective_vouch_strength = $1 WHERE id = $2',
        [strength, subjectId]
      );

      const completed = strength >= 1.0;

      if (completed) {
        try {
          await engine.processStep(subjectId, 'PEER_VOUCHING_COMPLETE', {});
        } catch (err) {
          logger.warn('PEER_VOUCHING_COMPLETE step failed', { error: err.message, subjectId });
        }
      } else if (strength >= 0.80) {
        await client.query(
          `INSERT INTO reviewer_queue (practitioner_id, document_id, reason) VALUES ($1, null, $2) ON CONFLICT DO NOTHING`,
          [subjectId, `VOUCH_STRENGTH_MARGINAL: ${strength.toFixed(2)}`]
        );
      }

      logger.info('Vouch given', { voucherId, subjectId, newCount, strength, completed });

      return {
        vouched: true,
        subject_vouch_count: newCount,
        required: VOUCHING_REQUIRED_COUNT,
        completed,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Withdraw a vouch.
   *
   * @param {string} subjectId  - UUID of the subject practitioner
   * @param {string} voucherId  - UUID of the voucher withdrawing
   * @param {string} reason     - Reason for withdrawal
   * @returns {object} { withdrawn, subject_new_vouch_count }
   */
  async withdrawVouch(subjectId, voucherId, reason) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Find ACTIVE vouch
      const vouchResult = await client.query(
        `SELECT id FROM practitioner_vouches
         WHERE voucher_id = $1 AND subject_id = $2 AND status = 'ACTIVE'
         FOR UPDATE`,
        [voucherId, subjectId]
      );

      if (vouchResult.rows.length === 0) {
        const err = new Error('No active vouch found');
        err.code = 'VOUCH_NOT_FOUND';
        throw err;
      }

      // 2. Withdraw vouch
      await client.query(
        `UPDATE practitioner_vouches
         SET status = 'WITHDRAWN', withdrawn_at = NOW(), withdrawn_reason = $1
         WHERE voucher_id = $2 AND subject_id = $3 AND status = 'ACTIVE'`,
        [reason, voucherId, subjectId]
      );

      // 3. Decrement vouch_count
      await client.query(
        'UPDATE practitioners SET vouch_count = GREATEST(vouch_count - 1, 0) WHERE id = $1',
        [subjectId]
      );

      // 4. Check if subject should be demoted
      const strength = await this.computeWeightedVouchScore(subjectId, client);
      await client.query('UPDATE practitioners SET effective_vouch_strength = $1 WHERE id = $2', [strength, subjectId]);

      const subjectResult = await client.query(
        'SELECT id, vouch_count, badge_level, trust_score, full_name, email FROM practitioners WHERE id = $1',
        [subjectId]
      );

      const subject = subjectResult.rows[0];
      const newCount = subject.vouch_count;

      if (subject.badge_level === 'FULLY_VERIFIED' && strength < 1.0) {
        // Recompute trust score without PEER_VOUCHING_COMPLETE
        const newScore = Math.max(0, subject.trust_score - 25);
        const TrustScoreCalculator = require('../verification/TrustScoreCalculator');
        const newBadge = TrustScoreCalculator.getBadgeLevel(newScore);

        await client.query(
          `UPDATE practitioners
           SET verification_status = 'VOUCHING_PENDING', trust_score = $1, badge_level = $2, updated_at = NOW()
           WHERE id = $3`,
          [newScore, newBadge, subjectId]
        );

        // Email notification
        if (subject.email) {
          await emailService.sendEmail(subject.email, 'vouch_withdrawn', {
            full_name: subject.full_name,
            required: VOUCHING_REQUIRED_COUNT,
            portal_url: process.env.VERIFICATION_PORTAL_URL || 'http://localhost:3000'
          });
        }

        // Fire webhook
        const dispatcher = new WebhookDispatcher();
        const partnersResult = await client.query(
          `SELECT DISTINCT p.webhook_url, p.webhook_secret
           FROM partners p
           INNER JOIN verification_sessions vs ON vs.partner_id = p.id
           WHERE vs.practitioner_id = $1 AND p.webhook_url IS NOT NULL AND p.is_active = true`,
          [subjectId]
        );

        await client.query('COMMIT');

        for (const partner of partnersResult.rows) {
          await dispatcher.dispatch({
            url: partner.webhook_url,
            secret: partner.webhook_secret,
            payload: {
              event: 'VOUCHING_DEGRADED',
              practitioner_id: subjectId,
              trust_score: newScore,
              badge_level: newBadge,
              vouch_count: newCount,
              timestamp: new Date().toISOString(),
            },
          });
        }
      } else {
        // 5. Audit log
        await writeAuditLog({
          actorId: voucherId,
          actorType: 'practitioner',
          action: 'VOUCH_WITHDRAWN',
          targetId: subjectId,
          metadata: { reason },
          client,
        });

        await client.query('COMMIT');
      }

      logger.info('Vouch withdrawn', { voucherId, subjectId, newCount, reason });

      return {
        withdrawn: true,
        subject_new_vouch_count: newCount,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get vouch summary for a practitioner.
   *
   * @param {string} practitionerId - UUID
   * @returns {object} { given, received, count, required, completed }
   */
  async getVouches(practitionerId) {
    const givenResult = await pool.query(
      `SELECT pv.id, pv.subject_id, pv.vouch_note, pv.status, pv.created_at,
              p.full_name AS subject_name, p.badge_level AS subject_badge, p.trustmed_id AS subject_trustmed_id
       FROM practitioner_vouches pv
       JOIN practitioners p ON pv.subject_id = p.id
       WHERE pv.voucher_id = $1
       ORDER BY pv.created_at DESC`,
      [practitionerId]
    );

    const receivedResult = await pool.query(
      `SELECT pv.id, pv.voucher_id, pv.voucher_score, pv.voucher_badge, pv.vouch_note, pv.status, pv.created_at,
              p.full_name AS voucher_name, p.trustmed_id AS voucher_trustmed_id
       FROM practitioner_vouches pv
       JOIN practitioners p ON pv.voucher_id = p.id
       WHERE pv.subject_id = $1
       ORDER BY pv.created_at DESC`,
      [practitionerId]
    );

    const countResult = await pool.query(
      'SELECT vouch_count FROM practitioners WHERE id = $1',
      [practitionerId]
    );

    const count = countResult.rows.length > 0 ? countResult.rows[0].vouch_count : 0;

    return {
      given: givenResult.rows,
      received: receivedResult.rows,
      count,
      required: VOUCHING_REQUIRED_COUNT,
      completed: count >= VOUCHING_REQUIRED_COUNT,
    };
  }
}

module.exports = VouchingService;
