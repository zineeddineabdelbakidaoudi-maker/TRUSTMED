/**
 * Phone OTP verification routes.
 *
 * POST /v1/practitioner/phone/request  — Request OTP via Twilio SMS
 * POST /v1/practitioner/phone/verify   — Verify OTP code
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const logger = require('../../../shared/logger');
const VerificationEngine = require('../../verification/VerificationEngine');

const router = express.Router();

// Zod schemas
const requestOtpSchema = z.object({
  phone_number: z.string().regex(
    /^\+213[5-7]\d{8}$/,
    'Phone number must be Algerian format: +213XXXXXXXXX'
  ),
});

const verifyOtpSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
});

const BCRYPT_OTP_ROUNDS = 10;
const OTP_EXPIRY_SECONDS = 300; // 5 minutes
const OTP_COOLDOWN_SECONDS = 60; // 1 minute between requests
const MAX_ATTEMPTS = 3;

// ════════════════════════════════════════════════════════════════
// POST /phone/request — Request OTP
// ════════════════════════════════════════════════════════════════
router.post(
  '/phone/request',
  authenticate,
  validate(requestOtpSchema, 'body'),
  async (req, res) => {
    const { phone_number } = req.validated;
    const practitionerId = req.auth.sub;

    try {
      // Check cooldown: no PENDING record in the last 60 seconds
      const recentResult = await pool.query(
        `SELECT id, created_at FROM phone_verifications
         WHERE practitioner_id = $1 AND status = 'PENDING'
           AND created_at > NOW() - INTERVAL '${OTP_COOLDOWN_SECONDS} seconds'
         ORDER BY created_at DESC LIMIT 1`,
        [practitionerId]
      );

      if (recentResult.rows.length > 0) {
        const created = new Date(recentResult.rows[0].created_at);
        const retryAfter = Math.ceil(OTP_COOLDOWN_SECONDS - (Date.now() - created.getTime()) / 1000);
        return res.status(429).json({
          error: 'otp_too_soon',
          message: 'Please wait before requesting another OTP',
          retry_after_seconds: Math.max(1, retryAfter),
        });
      }

      // Generate 6-digit OTP
      const otp = crypto.randomInt(100000, 999999).toString();

      // Hash OTP with bcrypt (never store plaintext)
      const otpHash = await bcrypt.hash(otp, BCRYPT_OTP_ROUNDS);
      const otpExp = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000);

      // Insert phone verification record
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Expire any previous PENDING records
        await client.query(
          `UPDATE phone_verifications SET status = 'EXPIRED'
           WHERE practitioner_id = $1 AND status = 'PENDING'`,
          [practitionerId]
        );

        await client.query(
          `INSERT INTO phone_verifications
           (practitioner_id, phone_number, otp_hash, otp_exp, attempt_count, status, called_at)
           VALUES ($1, $2, $3, $4, 0, 'PENDING', NOW())`,
          [practitionerId, phone_number, otpHash, otpExp]
        );

        // Audit log — log phone number, NOT the OTP value
        await writeAuditLog({
          actorId: practitionerId,
          actorType: 'practitioner',
          action: 'OTP_REQUESTED',
          targetId: practitionerId,
          metadata: { phone_number, expires_in: OTP_EXPIRY_SECONDS },
          ipAddress: req.ip,
          client,
        });

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Send OTP via Twilio SMS
      try {
        const twilioSid = process.env.TWILIO_ACCOUNT_SID;
        const twilioToken = process.env.TWILIO_AUTH_TOKEN;
        const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

        if (twilioSid && twilioToken && twilioPhone) {
          const twilio = require('twilio')(twilioSid, twilioToken);
          await twilio.messages.create({
            body: `TrustMed: votre code de vérification est ${otp}. Valable 5 minutes.`,
            from: twilioPhone,
            to: phone_number,
          });
          logger.info('OTP SMS sent via Twilio', { practitionerId, phone_number });
        } else {
          // Development mode: log OTP to console
          logger.warn('Twilio not configured — OTP logged for dev only', {
            practitionerId,
            otp,
            phone_number,
          });
        }
      } catch (smsErr) {
        logger.error('Failed to send OTP SMS', { error: smsErr.message, practitionerId });
        // Don't fail the request — OTP is stored, user can retry
      }

      return res.json({
        message: 'OTP sent',
        expires_in_seconds: OTP_EXPIRY_SECONDS,
      });
    } catch (err) {
      logger.error('Error in /phone/request', { error: err.message, stack: err.stack });
      return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
    }
  }
);

// ════════════════════════════════════════════════════════════════
// POST /phone/verify — Verify OTP
// ════════════════════════════════════════════════════════════════
router.post(
  '/phone/verify',
  authenticate,
  validate(verifyOtpSchema, 'body'),
  async (req, res) => {
    const { otp } = req.validated;
    const practitionerId = req.auth.sub;

    try {
      // Fetch latest PENDING OTP that hasn't expired
      const otpResult = await pool.query(
        `SELECT id, otp_hash, attempt_count, phone_number
         FROM phone_verifications
         WHERE practitioner_id = $1 AND status = 'PENDING' AND otp_exp > NOW()
         ORDER BY called_at DESC LIMIT 1`,
        [practitionerId]
      );

      if (otpResult.rows.length === 0) {
        return res.status(400).json({
          error: 'no_active_otp',
          message: 'No active OTP found. Please request a new one.',
        });
      }

      const record = otpResult.rows[0];

      // Check if locked (max 3 attempts)
      if (record.attempt_count >= MAX_ATTEMPTS) {
        await pool.query(
          `UPDATE phone_verifications SET status = 'LOCKED' WHERE id = $1`,
          [record.id]
        );
        await writeAuditLog({
          actorId: practitionerId,
          actorType: 'practitioner',
          action: 'OTP_LOCKED',
          targetId: record.id,
          metadata: { attempt_count: record.attempt_count, phone_number: record.phone_number },
          ipAddress: req.ip,
        });
        return res.status(429).json({
          error: 'otp_locked',
          message: 'Too many failed attempts. Please request a new OTP.',
        });
      }

      // Increment attempt count
      await pool.query(
        `UPDATE phone_verifications SET attempt_count = attempt_count + 1 WHERE id = $1`,
        [record.id]
      );

      // Compare OTP (bcrypt)
      const match = await bcrypt.compare(otp, record.otp_hash);

      if (!match) {
        const remaining = MAX_ATTEMPTS - (record.attempt_count + 1);
        await writeAuditLog({
          actorId: practitionerId,
          actorType: 'practitioner',
          action: 'OTP_VERIFY_FAILED',
          targetId: record.id,
          metadata: { attempts_used: record.attempt_count + 1, attempts_remaining: remaining },
          ipAddress: req.ip,
        });
        return res.status(400).json({
          error: 'invalid_otp',
          message: 'Invalid OTP code',
          attempts_remaining: remaining,
        });
      }

      // OTP matched — mark as VERIFIED
      await pool.query(
        `UPDATE phone_verifications SET status = 'VERIFIED', verified_at = NOW() WHERE id = $1`,
        [record.id]
      );

      await writeAuditLog({
        actorId: practitionerId,
        actorType: 'practitioner',
        action: 'OTP_VERIFIED',
        targetId: record.id,
        metadata: { phone_number: record.phone_number },
        ipAddress: req.ip,
      });

      // Trigger VerificationEngine.processStep(PHONE_OTP_VERIFIED)
      let result = { trustScore: 0, badgeLevel: 'NONE' };
      try {
        const engine = new VerificationEngine();
        result = await engine.processStep(practitionerId, 'PHONE_OTP_VERIFIED', {
          phoneNumber: record.phone_number,
          ipAddress: req.ip,
        });
      } catch (engineErr) {
        logger.warn('PHONE_OTP_VERIFIED step skipped', {
          error: engineErr.message,
          practitionerId,
        });
      }

      logger.info('Phone OTP verified successfully', {
        practitionerId,
        phone: record.phone_number,
      });

      return res.json({
        verified: true,
        trust_score: result.trustScore,
        badge_level: result.badgeLevel,
      });
    } catch (err) {
      logger.error('Error in /phone/verify', { error: err.message, stack: err.stack });
      return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
    }
  }
);

module.exports = router;
