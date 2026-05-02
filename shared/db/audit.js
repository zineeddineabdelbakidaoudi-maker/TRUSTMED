const pool = require('./pool');
const logger = require('../logger');

/**
 * Writes an immutable entry to the audit_log table.
 * Every database action in TrustMed must call this.
 *
 * @param {object} params
 * @param {string|null} params.actorId    - UUID of the actor (practitioner, partner, or system)
 * @param {string}      params.actorType  - 'practitioner' | 'partner' | 'system'
 * @param {string}      params.action     - Action name (e.g. 'OAUTH_AUTHORIZE', 'TOKEN_EXCHANGE')
 * @param {string|null} params.targetId   - UUID of the affected entity
 * @param {object}      params.metadata   - Additional context as JSON
 * @param {string|null} params.ipAddress  - Request IP address
 * @param {object}      [params.client]   - Optional pg client for transactional audit writes
 */
async function writeAuditLog({ actorId, actorType, action, targetId, metadata, ipAddress, client, req }) {
  const enhancedMetadata = {
    ...(metadata || {}),
    ...(req?.fingerprint_hash ? { fingerprint_hash: req.fingerprint_hash } : {})
  };

  const query = `
    INSERT INTO audit_log (actor_id, actor_type, action, target_id, metadata, ip_address)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;
  const values = [
    actorId || null,
    actorType || 'system',
    action,
    targetId || null,
    Object.keys(enhancedMetadata).length > 0 ? JSON.stringify(enhancedMetadata) : null,
    ipAddress || (req?.ip) || null,
  ];

  try {
    const db = client || pool;
    await db.query(query, values);
  } catch (err) {
    // Audit failures must never crash the main flow — log and continue
    logger.error('Failed to write audit log', {
      error: err.message,
      action,
      actorId,
      targetId,
    });
  }
}

module.exports = { writeAuditLog };
