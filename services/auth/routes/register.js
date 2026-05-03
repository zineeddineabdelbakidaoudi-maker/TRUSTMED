/**
 * POST /v1/practitioner/register — Self-service practitioner registration
 * 
 * This creates a new practitioner record and returns a JWT so the frontend
 * can authenticate subsequent document uploads.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const pool = require('../../../shared/db/pool');
const { signToken } = require('../../../shared/crypto/jwt');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { full_name, cnom_number, specialty, wilaya_code } = req.body;

    if (!full_name || !cnom_number) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'full_name and cnom_number are required',
      });
    }

    // Generate unique TrustMed ID
    const wilaya = (wilaya_code || '00').toString().padStart(2, '0');
    const year = new Date().getFullYear().toString().slice(-2);
    const seq = crypto.randomBytes(2).toString('hex').toUpperCase();
    const trustmedId = `TM-${wilaya}-${year}${seq.slice(0, 2)}-${seq.slice(2)}${crypto.randomBytes(1).toString('hex').toUpperCase()}`;

    const practitionerId = uuidv4();

    // Check if CNOM already exists
    const existing = await pool.query(
      'SELECT id FROM practitioners WHERE cnom_number = $1',
      [cnom_number]
    );

    if (existing.rows.length > 0) {
      // Return existing practitioner's token instead of creating duplicate
      const existingId = existing.rows[0].id;
      const token = signToken({
        sub: existingId,
        type: 'practitioner',
        scopes: ['identity', 'documents', 'status'],
      });

      return res.json({
        practitioner_id: existingId,
        access_token: token,
        message: 'Practitioner already registered',
      });
    }

    // Insert new practitioner
    await pool.query(
      `INSERT INTO practitioners 
       (id, trustmed_id, full_name, cnom_number, specialty, wilaya_code, 
        verification_status, trust_score, badge_level, privacy_consented)
       VALUES ($1, $2, $3, $4, $5, $6, 'IDENTITY_PENDING', 0, 'NONE', false)`,
      [practitionerId, trustmedId, full_name, cnom_number, specialty || null, wilaya || null]
    );

    // Audit
    await writeAuditLog({
      actorId: practitionerId,
      actorType: 'practitioner',
      action: 'PRACTITIONER_REGISTERED',
      targetId: practitionerId,
      metadata: { full_name, cnom_number, specialty, wilaya_code },
      ipAddress: req.ip,
    });

    // Sign JWT
    const token = signToken({
      sub: practitionerId,
      type: 'practitioner',
      scopes: ['identity', 'documents', 'status'],
    });

    logger.info('Practitioner registered', { practitionerId, trustmedId, full_name });

    return res.status(201).json({
      practitioner_id: practitionerId,
      trustmed_id: trustmedId,
      access_token: token,
    });
  } catch (err) {
    logger.error('Error registering practitioner', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

module.exports = router;
