const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');
const validate = require('../middleware/validate');
const { partnerRegisterSchema } = require('../schemas/auth.schemas');

const router = express.Router();
const BCRYPT_SALT_ROUNDS = 12;

// ════════════════════════════════════════════════════════════════
// POST /v1/partner/register — Register a new partner application
// ════════════════════════════════════════════════════════════════
router.post('/register', validate(partnerRegisterSchema, 'body'), async (req, res) => {
  const {
    name,
    client_id,
    client_secret,
    redirect_uris,
    allowed_scopes,
    webhook_url,
    webhook_secret,
  } = req.validated;

  try {
    // Check for duplicate client_id
    const existing = await pool.query(
      'SELECT id FROM partners WHERE client_id = $1',
      [client_id]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'duplicate_client',
        message: 'A partner with this client_id already exists',
      });
    }

    // Hash client_secret with bcrypt (saltRounds=12)
    const hashedSecret = await bcrypt.hash(client_secret, BCRYPT_SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO partners (name, client_id, client_secret, redirect_uris, allowed_scopes, webhook_url, webhook_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, client_id, redirect_uris, allowed_scopes, webhook_url, is_active, created_at`,
      [name, client_id, hashedSecret, redirect_uris, allowed_scopes, webhook_url || null, webhook_secret || null]
    );

    const partner = result.rows[0];

    // Audit log
    await writeAuditLog({
      actorId: partner.id,
      actorType: 'system',
      action: 'PARTNER_REGISTERED',
      targetId: partner.id,
      metadata: { client_id, name, scopes: allowed_scopes },
      ipAddress: req.ip,
    });

    logger.info('Partner registered', { partnerId: partner.id, client_id, name });

    return res.status(201).json({
      message: 'Partner registered successfully',
      partner: {
        id: partner.id,
        name: partner.name,
        client_id: partner.client_id,
        redirect_uris: partner.redirect_uris,
        allowed_scopes: partner.allowed_scopes,
        webhook_url: partner.webhook_url,
        is_active: partner.is_active,
        created_at: partner.created_at,
      },
    });
  } catch (err) {
    logger.error('Error in /v1/partner/register', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'server_error',
      message: 'Internal server error',
    });
  }
});

module.exports = router;
