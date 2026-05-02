const express = require('express');
const pool = require('../../../shared/db/pool');
const authenticate = require('../middleware/authenticate');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');

const router = express.Router();

// ════════════════════════════════════════════════════════════════
// GET /v1/practitioner/me — Returns full practitioner profile
// Requires Bearer token authentication
// ════════════════════════════════════════════════════════════════
router.get('/me', authenticate, async (req, res) => {
  try {
    const practitionerId = req.auth.sub;

    if (!practitionerId) {
      return res.status(400).json({
        error: 'invalid_token',
        message: 'Token does not contain a valid practitioner reference',
      });
    }

    const result = await pool.query(
      `SELECT 
         id, trustmed_id, full_name, specialty, wilaya_code,
         cnom_number, verification_status, trust_score, badge_level,
         risk_score, risk_flags, base_trust_score, trust_confidence,
         created_at, updated_at
       FROM practitioners
       WHERE id = $1`,
      [practitionerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Practitioner not found',
      });
    }

    const practitioner = result.rows[0];

    // Audit log
    await writeAuditLog({
      actorId: practitionerId,
      actorType: 'practitioner',
      action: 'PROFILE_VIEWED',
      targetId: practitionerId,
      metadata: { partner_id: req.auth.partner_id, scopes: req.auth.scopes },
      ipAddress: req.ip,
      req, // Pass req for fingerprint extraction
    });

    // Filter response based on scopes in the JWT
    const scopes = req.auth.scopes || [];
    const response = {
      practitioner_id: practitioner.trustmed_id,
      verification_status: practitioner.verification_status,
      trust_score: practitioner.trust_score,
      trust_confidence: practitioner.trust_confidence,
      badge_level: practitioner.badge_level,
      verified_at: practitioner.updated_at,
    };

    if (scopes.includes('identity')) {
      response.full_name = practitioner.full_name;
      response.specialty = practitioner.specialty;
      response.wilaya_code = practitioner.wilaya_code;
    }

    if (scopes.includes('cnom')) {
      response.cnom_number = practitioner.cnom_number;
    }

    if (scopes.includes('risk')) {
      const riskScore = practitioner.risk_score || 0;
      response.risk_score = riskScore;
      response.risk_level = riskScore >= 60 ? 'HIGH' : riskScore >= 30 ? 'MEDIUM' : 'LOW';
      response.risk_flags = practitioner.risk_flags || [];
    }

    return res.json(response);
  } catch (err) {
    logger.error('Error in /v1/practitioner/me', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'server_error',
      message: 'Internal server error',
    });
  }
});

module.exports = router;
