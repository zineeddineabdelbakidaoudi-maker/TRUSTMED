const express = require('express');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');

const router = express.Router();

// GET /admin/queue
router.get('/', async (req, res) => {
  const status = req.query.status || 'PENDING';
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = (page - 1) * limit;

  try {
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM reviewer_queue WHERE status = $1',
      [status]
    );
    const total = parseInt(countResult.rows[0].count, 10);
    const pages = Math.ceil(total / limit);

    const result = await pool.query(
      `SELECT
         q.id AS queue_id, q.reason, q.created_at, q.status, q.assigned_to,
         p.id AS p_id, p.trustmed_id, p.full_name, p.specialty, p.wilaya_code, p.trust_score, p.badge_level,
         d.id AS d_id, d.doc_type, d.fraud_score, d.created_at AS uploaded_at
       FROM reviewer_queue q
       JOIN practitioners p ON q.practitioner_id = p.id
       JOIN documents d ON q.document_id = d.id
       WHERE q.status = $1
       ORDER BY d.fraud_score ASC NULLS LAST, q.created_at ASC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );

    const items = result.rows.map(row => ({
      queue_id: row.queue_id,
      reason: row.reason,
      created_at: row.created_at,
      status: row.status,
      assigned_to: row.assigned_to,
      practitioner: {
        id: row.p_id,
        trustmed_id: row.trustmed_id,
        full_name: row.full_name,
        specialty: row.specialty,
        wilaya_code: row.wilaya_code,
        trust_score: row.trust_score,
        badge_level: row.badge_level
      },
      document: {
        document_id: row.d_id,
        doc_type: row.doc_type,
        fraud_score: row.fraud_score,
        uploaded_at: row.uploaded_at
      }
    }));

    return res.json({ items, total, page, pages });
  } catch (err) {
    logger.error('Error fetching admin queue', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// GET /admin/queue/stats
router.get('/stats', async (req, res) => {
  try {
    const statsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
        COUNT(*) FILTER (WHERE status = 'ASSIGNED') AS assigned,
        COUNT(*) FILTER (WHERE status = 'RESOLVED' AND resolved_at >= CURRENT_DATE) AS resolved_today
      FROM reviewer_queue
    `);

    // Calculate average resolution hours for all resolved cases
    const avgResult = await pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) AS avg_hours
      FROM reviewer_queue
      WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL AND created_at IS NOT NULL
    `);

    return res.json({
      pending: parseInt(statsResult.rows[0].pending, 10),
      assigned: parseInt(statsResult.rows[0].assigned, 10),
      resolved_today: parseInt(statsResult.rows[0].resolved_today, 10),
      avg_resolution_hours: parseFloat(avgResult.rows[0].avg_hours || 0).toFixed(2),
    });
  } catch (err) {
    logger.error('Error fetching admin queue stats', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// POST /admin/queue/:queue_id/assign
router.post('/:queue_id/assign', async (req, res) => {
  const { queue_id } = req.params;
  const adminId = req.admin.id;

  try {
    const result = await pool.query(
      `UPDATE reviewer_queue
       SET status = 'ASSIGNED', assigned_to = $1
       WHERE id = $2 AND status = 'PENDING'
       RETURNING id, practitioner_id`,
      [adminId, queue_id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'invalid_state', message: 'Case not found or already assigned' });
    }

    const caseData = result.rows[0];

    await writeAuditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'CASE_ASSIGNED',
      targetId: queue_id,
      metadata: { practitioner_id: caseData.practitioner_id },
      ipAddress: req.ip,
    });

    logger.info('Case assigned to admin', { queue_id, adminId });

    return res.json({ success: true, queue_id, assigned_to: adminId });
  } catch (err) {
    logger.error('Error assigning admin case', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

module.exports = router;
