/**
 * Admin Practitioner Management Routes
 * 
 * GET    /api/admin/practitioners/provisional  — List PROVISIONAL practitioners
 * PATCH  /api/admin/practitioners/:id/approve  — Manually approve a practitioner
 * PATCH  /api/admin/practitioners/:id/reject   — Manually reject a practitioner
 */
const express = require('express');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const { requireAdmin, requireRole } = require('../middleware/adminAuth');
const logger = require('../../../shared/logger');

const router = express.Router();

// GET /api/admin/practitioners/provisional
router.get('/provisional', requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM practitioners WHERE verification_status = 'PROVISIONAL'`
    );
    const total = parseInt(countResult.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    const result = await pool.query(
      `SELECT p.id, p.full_name, p.cnom_number, p.wilaya_code, p.specialty,
              p.trust_score, p.verification_status, p.created_at, p.updated_at,
              (SELECT cv.match_score FROM cnom_verifications cv
               WHERE cv.practitioner_id = p.id
               ORDER BY cv.created_at DESC LIMIT 1) as last_score,
              (SELECT cv.created_at FROM cnom_verifications cv
               WHERE cv.practitioner_id = p.id
               ORDER BY cv.created_at DESC LIMIT 1) as last_cnom_check
       FROM practitioners p
       WHERE p.verification_status = 'PROVISIONAL'
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return res.json({
      data: result.rows,
      total,
      page,
      totalPages,
    });
  } catch (err) {
    logger.error('Error fetching provisional practitioners', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// PATCH /api/admin/practitioners/:id/approve
router.patch('/:id/approve', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const adminId = req.admin.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const practResult = await client.query(
      `SELECT id, verification_status FROM practitioners WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (practResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'Practitioner not found' });
    }

    await client.query(
      `UPDATE practitioners SET verification_status = 'CNOM_CONFIRMED', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'MANUAL_APPROVE',
      targetId: id,
      metadata: { previous_status: practResult.rows[0].verification_status },
      ipAddress: req.ip,
      client,
    });

    await client.query('COMMIT');

    logger.info('Practitioner manually approved', { practitionerId: id, adminId });
    return res.json({ success: true, verification_status: 'CNOM_CONFIRMED' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Error approving practitioner', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/practitioners/:id/reject
router.patch('/:id/reject', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const adminId = req.admin.id;

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return res.status(400).json({ error: 'validation_error', message: 'Rejection reason is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const practResult = await client.query(
      `SELECT id, verification_status FROM practitioners WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (practResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'Practitioner not found' });
    }

    await client.query(
      `UPDATE practitioners SET verification_status = 'FLAGGED', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'MANUAL_REJECT',
      targetId: id,
      metadata: { reason: reason.trim(), previous_status: practResult.rows[0].verification_status },
      ipAddress: req.ip,
      client,
    });

    await client.query('COMMIT');

    logger.info('Practitioner manually rejected', { practitionerId: id, adminId, reason: reason.trim() });
    return res.json({ success: true, verification_status: 'FLAGGED' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Error rejecting practitioner', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
