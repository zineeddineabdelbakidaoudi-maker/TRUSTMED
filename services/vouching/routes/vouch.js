const express = require('express');
const pool = require('../../../shared/db/pool');
const authenticate = require('../../auth/middleware/authenticate');
const logger = require('../../../shared/logger');
const VouchingService = require('../VouchingService');

const router = express.Router();
const vouchingService = new VouchingService();

// POST /v1/practitioner/vouch/:subject_trustmed_id
router.post('/vouch/:subject_trustmed_id', authenticate, async (req, res) => {
  const voucherId = req.auth.sub;
  const { subject_trustmed_id } = req.params;
  const { note } = req.body;

  try {
    // Resolve trustmed_id → UUID
    const subjectResult = await pool.query(
      'SELECT id FROM practitioners WHERE trustmed_id = $1',
      [subject_trustmed_id]
    );

    if (subjectResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Subject practitioner not found' });
    }

    const subjectId = subjectResult.rows[0].id;
    const result = await vouchingService.requestVouch(subjectId, voucherId, note);

    return res.json(result);
  } catch (err) {
    if (err.code === 'VOUCHER_NOT_QUALIFIED') {
      return res.status(403).json({ error: 'voucher_not_qualified', message: err.message });
    }
    if (err.code === 'SELF_VOUCH') {
      return res.status(400).json({ error: 'self_vouch', message: err.message });
    }
    if (err.code === 'ALREADY_VOUCHED') {
      return res.status(409).json({ error: 'already_vouched', message: err.message });
    }
    if (err.code === 'VOUCHING_ALREADY_COMPLETE') {
      return res.status(400).json({ error: 'vouching_complete', message: err.message });
    }
    logger.error('Error in vouch request', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// DELETE /v1/practitioner/vouch/:subject_trustmed_id
router.delete('/vouch/:subject_trustmed_id', authenticate, async (req, res) => {
  const voucherId = req.auth.sub;
  const { subject_trustmed_id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'invalid_request', message: 'Reason is required for withdrawal' });
  }

  try {
    const subjectResult = await pool.query(
      'SELECT id FROM practitioners WHERE trustmed_id = $1',
      [subject_trustmed_id]
    );

    if (subjectResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Subject practitioner not found' });
    }

    const subjectId = subjectResult.rows[0].id;
    const result = await vouchingService.withdrawVouch(subjectId, voucherId, reason);

    return res.json(result);
  } catch (err) {
    if (err.code === 'VOUCH_NOT_FOUND') {
      return res.status(404).json({ error: 'vouch_not_found', message: err.message });
    }
    logger.error('Error in vouch withdrawal', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// GET /v1/practitioner/vouch
router.get('/vouch', authenticate, async (req, res) => {
  const practitionerId = req.auth.sub;

  try {
    const result = await vouchingService.getVouches(practitionerId);
    return res.json(result);
  } catch (err) {
    logger.error('Error fetching vouches', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

module.exports = router;
