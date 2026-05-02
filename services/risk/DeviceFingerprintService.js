const crypto = require('crypto');

class DeviceFingerprintService {
  /**
   * Compute a secure SHA-256 fingerprint hash from request headers.
   * NEVER store raw User-Agent or headers — hash only.
   *
   * @param {object} req - Express request object
   * @returns {object} { fingerprint_hash, ip }
   */
  static computeFingerprint(req) {
    const userAgent = req.headers['user-agent'] || 'unknown';
    const acceptLang = req.headers['accept-language'] || '';
    const acceptEnc = req.headers['accept-encoding'] || '';
    
    // Get real IP considering proxies
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

    const rawSignals = {
      userAgent,
      acceptLang,
      acceptEnc,
      ip,
    };

    const fingerprint_hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(rawSignals))
      .digest('hex');

    return { fingerprint_hash, ip };
  }

  /**
   * Check if this fingerprint has been used by multiple accounts.
   *
   * @param {string} fingerprintHash
   * @param {string} practitionerId
   * @param {object} db - pg pool
   * @returns {object} { other_accounts, risk_flag: object | null }
   */
  static async checkFingerprintAbuse(fingerprintHash, practitionerId, db) {
    if (!fingerprintHash) return { other_accounts: 0, risk_flag: null };

    const res = await db.query(
      `SELECT COUNT(DISTINCT practitioner_id) as other_accounts
       FROM audit_log
       WHERE metadata->>'fingerprint_hash' = $1
         AND practitioner_id != $2
         AND practitioner_id IS NOT NULL
         AND created_at > NOW() - INTERVAL '30 days'`,
      [fingerprintHash, practitionerId]
    );

    const other_accounts = parseInt(res.rows[0].other_accounts, 10);

    let risk_flag = null;
    if (other_accounts >= 2) {
      risk_flag = {
        signal: 'DEVICE_SHARED_MULTIPLE_ACCOUNTS',
        severity: 'HIGH',
        risk_points: 35,
        details: { related_accounts_count: other_accounts }
      };
    }

    return { other_accounts, risk_flag };
  }
}

module.exports = DeviceFingerprintService;
