const express = require('express');
const authenticate = require('../../auth/middleware/authenticate');
const InstitutionalEmailService = require('../InstitutionalEmailService');
const logger = require('../../../shared/logger');

const router = express.Router();
const service = new InstitutionalEmailService();

// POST /v1/practitioner/institutional/request-confirmation
router.post('/request-confirmation', authenticate, async (req, res) => {
  try {
    const practitionerId = req.auth.sub;
    const { institution_admin_email } = req.body;

    if (!institution_admin_email) {
      return res.status(400).json({ error: 'missing_field', message: 'institution_admin_email is required' });
    }

    const result = await service.requestInstitutionalConfirmation(practitionerId, institution_admin_email);
    res.status(200).json(result);
  } catch (err) {
    if (err.code === 'SELF_CONFIRMATION' || err.code === 'DOMAIN_NOT_APPROVED' || err.code === 'INVALID_EMAIL') {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.code, message: err.message });
    }
    logger.error('Institutional confirmation request failed', { error: err.message });
    res.status(500).json({ error: 'internal_error', message: 'Failed to request institutional confirmation' });
  }
});

// GET /v1/institutional/confirm-institution?token=
router.get('/confirm-institution', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'missing_token', message: 'Token is required' });
    }
    const result = await service.confirmByInstitution(token);
    res.status(200).json(result);
  } catch (err) {
    if (err.code === 'INVALID_OR_EXPIRED_TOKEN') {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    logger.error('Institutional confirmation failed', { error: err.message });
    res.status(500).json({ error: 'internal_error', message: 'Failed to confirm' });
  }
});

// GET /v1/institutional/reject-institution?token=
router.get('/reject-institution', async (req, res) => {
  try {
    const { token, reason } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'missing_token', message: 'Token is required' });
    }
    await service.rejectByInstitution(token, reason || 'Rejected by institution admin');
    res.status(200).json({ rejected: true });
  } catch (err) {
    if (err.code === 'INVALID_OR_EXPIRED_TOKEN') {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    logger.error('Institutional rejection failed', { error: err.message });
    res.status(500).json({ error: 'internal_error', message: 'Failed to reject' });
  }
});

module.exports = router;
