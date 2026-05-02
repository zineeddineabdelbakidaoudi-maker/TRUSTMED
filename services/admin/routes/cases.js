const express = require('express');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');
const StorageService = require('../../../shared/storage/StorageService');
const VerificationEngine = require('../../verification/VerificationEngine');
const EmailService = require('../../notifications/EmailService');
const { publishDocumentJob } = require('../../../shared/queue/publisher'); // Just for the queue name reference or standard rabbitmq publisher if needed
const { getChannel } = require('../../../shared/queue/connection');
const { requireRole } = require('../middleware/adminAuth');

const router = express.Router();
const storage = new StorageService();
const engine = new VerificationEngine();
const emailService = new EmailService();

// GET /admin/cases/:practitioner_id
router.get('/:practitioner_id', async (req, res) => {
  const { practitioner_id } = req.params;

  try {
    const practResult = await pool.query('SELECT * FROM practitioners WHERE id = $1', [practitioner_id]);
    if (practResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Practitioner not found' });
    }
    const practitioner = practResult.rows[0];

    const docsResult = await pool.query('SELECT id, doc_type, status, fraud_score, fraud_flags, ocr_result, storage_key, created_at AS uploaded_at FROM documents WHERE practitioner_id = $1 ORDER BY created_at DESC', [practitioner_id]);
    const cnomResult = await pool.query('SELECT result, match_score, scraped_name, scraped_at FROM cnom_verifications WHERE practitioner_id = $1 ORDER BY created_at DESC', [practitioner_id]);
    const phoneResult = await pool.query('SELECT status, verified_at FROM phone_verifications WHERE practitioner_id = $1 ORDER BY created_at DESC', [practitioner_id]);
    const legalResult = await pool.query('SELECT created_at AS signed_at, hmac_signature FROM legal_declarations WHERE practitioner_id = $1 ORDER BY created_at DESC', [practitioner_id]);
    
    const auditResult = await pool.query('SELECT action, actor_type, metadata, created_at FROM audit_log WHERE target_id = $1 OR (metadata->>\'practitioner_id\') = $1 ORDER BY created_at DESC LIMIT 10', [practitioner_id]);
    
    const queueResult = await pool.query('SELECT id AS queue_id, status, reason, assigned_to, resolution FROM reviewer_queue WHERE practitioner_id = $1 AND status IN (\'PENDING\', \'ASSIGNED\') ORDER BY created_at DESC LIMIT 1', [practitioner_id]);

    return res.json({
      practitioner,
      documents: docsResult.rows,
      cnom_verifications: cnomResult.rows,
      phone_verifications: phoneResult.rows,
      legal_declarations: legalResult.rows,
      trust_history: auditResult.rows,
      reviewer_queue: queueResult.rows.length > 0 ? queueResult.rows[0] : null
    });
  } catch (err) {
    logger.error('Error fetching admin case', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// GET /admin/cases/:practitioner_id/documents/:document_id/download
router.get('/:practitioner_id/documents/:document_id/download', async (req, res) => {
  const { practitioner_id, document_id } = req.params;
  const adminId = req.admin.id;

  try {
    const result = await pool.query('SELECT storage_key FROM documents WHERE id = $1 AND practitioner_id = $2', [document_id, practitioner_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found' });
    }

    const { storage_key } = result.rows[0];
    const { buffer, mimeType } = await storage.downloadDocument(storage_key);

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'ADMIN_DOCUMENT_VIEW',
      targetId: document_id,
      metadata: { practitioner_id },
      ipAddress: req.ip,
    });

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${document_id}"`);
    return res.send(buffer);
  } catch (err) {
    logger.error('Error in admin document download', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// POST /admin/cases/:queue_id/approve
router.post('/:queue_id/approve', async (req, res) => {
  const { queue_id } = req.params;
  const { notes } = req.body;
  const adminId = req.admin.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const queueResult = await client.query('SELECT practitioner_id, status FROM reviewer_queue WHERE id = $1 FOR UPDATE', [queue_id]);
    if (queueResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'Queue item not found' });
    }

    const { practitioner_id, status } = queueResult.rows[0];
    if (status !== 'PENDING' && status !== 'ASSIGNED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_state', message: 'Queue item already resolved' });
    }

    await client.query(
      `UPDATE reviewer_queue SET status = 'RESOLVED', resolution = 'APPROVED', resolution_notes = $1, resolved_at = NOW() WHERE id = $2`,
      [notes || null, queue_id]
    );

    // Get practitioner to pass to engine, although VerificationEngine.processStep will fetch it.
    await client.query('COMMIT');

    let engineResult = { trustScore: 0, badgeLevel: 'NONE' };
    try {
      engineResult = await engine.processStep(practitioner_id, 'DOCUMENT_CLEAN', { adminApproved: true, adminId, queueId: queue_id });
    } catch (err) {
      logger.warn('DOCUMENT_CLEAN engine step failed during admin approve', { error: err.message });
    }

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'CASE_APPROVED',
      targetId: practitioner_id,
      metadata: { queue_id, notes },
      ipAddress: req.ip,
    });

    const practFinal = await pool.query('SELECT email, full_name, trust_score, badge_level FROM practitioners WHERE id = $1', [practitioner_id]);
    if (practFinal.rows.length > 0 && practFinal.rows[0].email) {
      const p = practFinal.rows[0];
      await emailService.sendEmail(p.email, 'verification_approved', {
        full_name: p.full_name,
        trust_score: p.trust_score,
        badge_level: p.badge_level,
        VERIFICATION_PORTAL_URL: process.env.VERIFICATION_PORTAL_URL || 'http://localhost:3000'
      });
    }

    return res.json({ resolved: true, new_trust_score: engineResult.trustScore, badge_level: engineResult.badgeLevel });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Error approving case', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /admin/cases/:queue_id/reject
router.post('/:queue_id/reject', async (req, res) => {
  const { queue_id } = req.params;
  const { notes } = req.body;
  const adminId = req.admin.id;

  if (!notes) {
    return res.status(400).json({ error: 'invalid_request', message: 'Notes are required for rejection' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const queueResult = await client.query('SELECT practitioner_id, status FROM reviewer_queue WHERE id = $1 FOR UPDATE', [queue_id]);
    if (queueResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'Queue item not found' });
    }

    const { practitioner_id, status } = queueResult.rows[0];
    if (status !== 'PENDING' && status !== 'ASSIGNED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_state', message: 'Queue item already resolved' });
    }

    await client.query(
      `UPDATE reviewer_queue SET status = 'RESOLVED', resolution = 'REJECTED', resolution_notes = $1, resolved_at = NOW() WHERE id = $2`,
      [notes, queue_id]
    );

    await client.query(
      `UPDATE practitioners SET verification_status = 'REJECTED', updated_at = NOW() WHERE id = $1`,
      [practitioner_id]
    );

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'CASE_REJECTED',
      targetId: practitioner_id,
      metadata: { queue_id, notes },
      ipAddress: req.ip,
      client,
    });

    await client.query('COMMIT');

    const practResult = await pool.query('SELECT email, full_name FROM practitioners WHERE id = $1', [practitioner_id]);
    if (practResult.rows.length > 0 && practResult.rows[0].email) {
      const p = practResult.rows[0];
      await emailService.sendEmail(p.email, 'verification_rejected', {
        full_name: p.full_name,
        notes
      });
    }

    return res.json({ resolved: true, status: 'REJECTED' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Error rejecting case', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /admin/cases/:queue_id/request-more-info
router.post('/:queue_id/request-more-info', async (req, res) => {
  const { queue_id } = req.params;
  const { message } = req.body;
  const adminId = req.admin.id;

  if (!message) {
    return res.status(400).json({ error: 'invalid_request', message: 'Message is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const queueResult = await client.query('SELECT practitioner_id, status FROM reviewer_queue WHERE id = $1 FOR UPDATE', [queue_id]);
    if (queueResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'Queue item not found' });
    }

    const { practitioner_id, status } = queueResult.rows[0];
    if (status !== 'PENDING' && status !== 'ASSIGNED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_state', message: 'Queue item already resolved' });
    }

    await client.query(
      `UPDATE reviewer_queue SET status = 'ASSIGNED', resolution = 'MORE_INFO', resolution_notes = $1 WHERE id = $2`,
      [message, queue_id]
    );

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'CASE_MORE_INFO_REQUESTED',
      targetId: practitioner_id,
      metadata: { queue_id, message },
      ipAddress: req.ip,
      client,
    });

    await client.query('COMMIT');

    const practResult = await pool.query('SELECT email, full_name FROM practitioners WHERE id = $1', [practitioner_id]);
    if (practResult.rows.length > 0 && practResult.rows[0].email) {
      const p = practResult.rows[0];
      await emailService.sendEmail(p.email, 'more_info_required', {
        full_name: p.full_name,
        message
      });
    }

    return res.json({ sent: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Error requesting more info', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /admin/practitioners/:practitioner_id/freeze
router.post('/practitioners/:practitioner_id/freeze', requireRole('ADMIN'), async (req, res) => {
  const { practitioner_id } = req.params;
  const { reason } = req.body;
  const adminId = req.admin.id;

  if (!reason) {
    return res.status(400).json({ error: 'invalid_request', message: 'Reason is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get previous status
    const pResult = await client.query('SELECT verification_status FROM practitioners WHERE id = $1', [practitioner_id]);
    if (pResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'Practitioner not found' });
    }
    const previousStatus = pResult.rows[0].verification_status;

    await client.query(
      `UPDATE practitioners SET verification_status = 'FROZEN', updated_at = NOW() WHERE id = $1`,
      [practitioner_id]
    );

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'PRACTITIONER_FROZEN',
      targetId: practitioner_id,
      metadata: { reason, previous_status: previousStatus },
      ipAddress: req.ip,
      client,
    });

    await client.query('COMMIT');

    // Publish COMPLIANCE_ALERT
    try {
      const channel = getChannel();
      if (channel) {
        channel.publish('trustmed_exchange', 'compliance.alert', Buffer.from(JSON.stringify({
          event: 'compliance.fraud_alert',
          practitioner_id,
          reason,
          admin_id: adminId,
          timestamp: new Date().toISOString()
        })));
      }
    } catch (e) {
      logger.warn('Failed to publish COMPLIANCE_ALERT', { error: e.message });
    }

    return res.json({ success: true, status: 'FROZEN' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Error freezing practitioner', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /admin/practitioners/:practitioner_id/unfreeze
router.post('/practitioners/:practitioner_id/unfreeze', requireRole('ADMIN'), async (req, res) => {
  const { practitioner_id } = req.params;
  const { reason } = req.body;
  const adminId = req.admin.id;

  if (!reason) {
    return res.status(400).json({ error: 'invalid_request', message: 'Reason is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const auditResult = await client.query(
      `SELECT metadata->>'previous_status' AS prev FROM audit_log WHERE target_id = $1 AND action = 'PRACTITIONER_FROZEN' ORDER BY created_at DESC LIMIT 1`,
      [practitioner_id]
    );
    const previousStatus = (auditResult.rows.length > 0 && auditResult.rows[0].prev) ? auditResult.rows[0].prev : 'IDENTITY_PENDING';

    await client.query(
      `UPDATE practitioners SET verification_status = $1, updated_at = NOW() WHERE id = $2`,
      [previousStatus, practitioner_id]
    );

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'PRACTITIONER_UNFROZEN',
      targetId: practitioner_id,
      metadata: { reason, restored_status: previousStatus },
      ipAddress: req.ip,
      client,
    });

    await client.query('COMMIT');

    return res.json({ success: true, status: previousStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Error unfreezing practitioner', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});
// GET /admin/practitioners/:id/vouches
router.get('/practitioners/:id/vouches', requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;

  try {
    const givenResult = await pool.query(
      `SELECT pv.id, pv.subject_id, pv.vouch_note, pv.status, pv.created_at,
              p.full_name AS subject_name, p.badge_level AS subject_badge, p.trustmed_id AS subject_trustmed_id
       FROM practitioner_vouches pv
       JOIN practitioners p ON pv.subject_id = p.id
       WHERE pv.voucher_id = $1
       ORDER BY pv.created_at DESC`,
      [id]
    );

    const receivedResult = await pool.query(
      `SELECT pv.id, pv.voucher_id, pv.voucher_score, pv.voucher_badge, pv.vouch_note, pv.status, pv.created_at,
              p.full_name AS voucher_name, p.trustmed_id AS voucher_trustmed_id
       FROM practitioner_vouches pv
       JOIN practitioners p ON pv.voucher_id = p.id
       WHERE pv.subject_id = $1
       ORDER BY pv.created_at DESC`,
      [id]
    );

    const countResult = await pool.query(
      'SELECT vouch_count FROM practitioners WHERE id = $1',
      [id]
    );

    const count = countResult.rows.length > 0 ? countResult.rows[0].vouch_count : 0;
    const required = parseInt(process.env.VOUCHING_REQUIRED_COUNT || '2', 10);

    return res.json({
      given: givenResult.rows,
      received: receivedResult.rows,
      count,
      required,
      completed: count >= required,
    });
  } catch (err) {
    logger.error('Error fetching practitioner vouches for admin', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════
// Shadow Ban Admin Endpoints
// ═══════════════════════════════════════════════════

// GET /admin/practitioners/:id/shadow-ban
router.get('/practitioners/:id/shadow-ban', requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT shadow_banned, shadow_banned_at, behavioral_score, risk_momentum
       FROM practitioners WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Practitioner not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    logger.error('Error fetching shadow ban status', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// POST /admin/practitioners/:id/shadow-ban/lift
router.post('/practitioners/:id/shadow-ban/lift', requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!reason) {
    return res.status(400).json({ error: 'missing_field', message: 'reason is required' });
  }
  try {
    const PredictiveRiskService = require('../../risk/PredictiveRiskService');
    const predictive = new PredictiveRiskService();
    await predictive.liftShadowBan(id, req.admin.id, reason, pool);
    return res.json({ success: true, shadow_banned: false });
  } catch (err) {
    logger.error('Error lifting shadow ban', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

module.exports = router;
