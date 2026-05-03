/**
 * POST /v1/practitioner/register — Self-service practitioner registration
 * 
 * Creates a new practitioner record and returns a JWT for subsequent uploads.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');

const router = express.Router();

// Try RS256 signing first, fall back to HMAC if no PEM keys are configured
function signPractitionerToken(payload) {
  const jwt = require('jsonwebtoken');
  
  // Try RS256 (production-grade)
  if (process.env.JWT_PRIVATE_KEY) {
    try {
      const { signToken } = require('../../../shared/crypto/jwt');
      return signToken(payload);
    } catch (err) {
      logger.warn('RS256 signing failed, falling back to HMAC', { error: err.message });
    }
  }
  
  // Fallback: HMAC with ADMIN_JWT_SECRET or HMAC_SECRET
  const secret = process.env.ADMIN_JWT_SECRET || process.env.HMAC_SECRET || 'trustmed_dev_secret';
  return jwt.sign(payload, secret, { expiresIn: '24h', issuer: 'trustmed' });
}

router.post('/register', async (req, res) => {
  try {
    const { full_name, cnom_number, specialty, wilaya_code } = req.body;

    if (!full_name || !cnom_number) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'full_name and cnom_number are required',
      });
    }

    // Normalize CNOM: convert 16/8343 → 16-8343
    const normalizedCnom = cnom_number.trim().replace(/\//g, '-');

    // Check if CNOM already exists
    const existing = await pool.query(
      'SELECT id FROM practitioners WHERE cnom_number = $1',
      [normalizedCnom]
    );

    if (existing.rows.length > 0) {
      const existingId = existing.rows[0].id;
      const token = signPractitionerToken({
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

    // Generate TrustMed ID matching constraint: TM-XX-XXXX-XXXX
    const wc = (wilaya_code || '16').toString().padStart(2, '0');
    const seq1 = Math.floor(1000 + Math.random() * 9000).toString();
    const seq2 = Math.floor(1000 + Math.random() * 9000).toString();
    const trustmedId = `TM-${wc}-${seq1}-${seq2}`;

    // Generate a placeholder CIN (since it's NOT NULL in the schema)
    const placeholderCin = `CIN-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const practitionerId = uuidv4();

    await pool.query(
      `INSERT INTO practitioners 
       (id, trustmed_id, full_name, cin_number, cnom_number, specialty, wilaya_code, 
        verification_status, trust_score, badge_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'IDENTITY_PENDING', 0, 'NONE')`,
      [practitionerId, trustmedId, full_name, placeholderCin, normalizedCnom, specialty || null, parseInt(wc) || null]
    );

    await writeAuditLog({
      actorId: practitionerId,
      actorType: 'practitioner',
      action: 'PRACTITIONER_REGISTERED',
      targetId: practitionerId,
      metadata: { full_name, cnom_number: normalizedCnom, specialty, wilaya_code },
      ipAddress: req.ip,
    });

    const token = signPractitionerToken({
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
    logger.error('Error registering practitioner', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

module.exports = router;
