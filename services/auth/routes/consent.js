const express = require('express');
const { z } = require('zod');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');
const authenticate = require('../middleware/authenticate');
const hmac = require('../../../shared/crypto/hmac');

const router = express.Router();

const consentSchema = z.object({
  privacy_policy: z.literal(true),
  terms: z.literal(true),
  policy_version: z.string().default('1.0'),
});

// POST /v1/practitioner/consent
router.post('/consent', authenticate, async (req, res) => {
  const practitionerId = req.auth.sub;

  try {
    const validatedData = consentSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const practResult = await client.query(
        'SELECT privacy_consented, privacy_consented_at FROM practitioners WHERE id = $1 FOR UPDATE',
        [practitionerId]
      );

      if (practResult.rows.length === 0) {
        throw new Error('Practitioner not found');
      }

      if (practResult.rows[0].privacy_consented) {
        await client.query('ROLLBACK');
        return res.json({
          already_consented: true,
          consented_at: practResult.rows[0].privacy_consented_at,
        });
      }

      await client.query(
        `UPDATE practitioners SET
           privacy_consented = true,
           privacy_consented_at = NOW(),
           privacy_policy_version = $1,
           terms_consented = true,
           terms_consented_at = NOW()
         WHERE id = $2`,
        [validatedData.policy_version, practitionerId]
      );

      await writeAuditLog({
        actorId: practitionerId,
        actorType: 'practitioner',
        action: 'PRIVACY_CONSENT_GIVEN',
        targetId: practitionerId,
        metadata: { policy_version: validatedData.policy_version },
        ipAddress: req.ip,
        client,
      });

      // Write to legal_declarations
      const declarationPayload = JSON.stringify({
        type: 'PRIVACY_CONSENT',
        policy_version: validatedData.policy_version,
        consented_at: new Date().toISOString(),
        practitioner_id: practitionerId,
        ip_address: req.ip,
      });
      const signature = hmac.sign(declarationPayload, process.env.HMAC_SECRET);

      await client.query(
        `INSERT INTO legal_declarations (practitioner_id, declaration_text, hmac_signature)
         VALUES ($1, $2, $3)`,
        [practitionerId, declarationPayload, signature]
      );

      await client.query('COMMIT');

      logger.info('Privacy consent recorded', { practitionerId, version: validatedData.policy_version });

      return res.json({
        consented: true,
        consented_at: new Date().toISOString(),
        policy_version: validatedData.policy_version,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation_error', issues: err.errors });
    }
    logger.error('Error recording consent', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

module.exports = router;
