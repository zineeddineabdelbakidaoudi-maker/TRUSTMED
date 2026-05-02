const crypto = require('crypto');
const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');
const EmailService = require('../notifications/EmailService');
const VerificationEngine = require('../verification/VerificationEngine');

const emailService = new EmailService();
const engine = new VerificationEngine();

const DOMAIN_WHITELIST = (process.env.INSTITUTIONAL_DOMAIN_WHITELIST || '').split(',').map(d => d.trim()).filter(Boolean);

class InstitutionalEmailService {
  /**
   * Send a verification email to an institutional address.
   *
   * @param {string} practitionerId     - UUID
   * @param {string} institutionalEmail - e.g. user@chu-algier.dz
   * @returns {object} { sent, domain, expires_in_hours }
   */
  async sendVerificationEmail(practitionerId, institutionalEmail) {
    // 1. Extract and validate domain
    const parts = institutionalEmail.split('@');
    if (parts.length !== 2) {
      const err = new Error('Invalid email format');
      err.code = 'INVALID_EMAIL';
      throw err;
    }

    const domain = parts[1].toLowerCase();

    if (DOMAIN_WHITELIST.length > 0 && !DOMAIN_WHITELIST.includes(domain)) {
      const err = new Error('Domain not in approved institutional list');
      err.code = 'DOMAIN_NOT_APPROVED';
      throw err;
    }

    // 2. Check practitioner has not already verified an institutional email
    const existingResult = await pool.query(
      `SELECT id FROM institutional_verifications
       WHERE practitioner_id = $1 AND status = 'VERIFIED'`,
      [practitionerId]
    );

    if (existingResult.rows.length > 0) {
      const err = new Error('Institutional email already verified');
      err.code = 'ALREADY_VERIFIED';
      throw err;
    }

    // 3. Expire any pending verifications for this practitioner
    await pool.query(
      `UPDATE institutional_verifications SET status = 'EXPIRED'
       WHERE practitioner_id = $1 AND status = 'PENDING'`,
      [practitionerId]
    );

    // 4. Generate token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // 5. Insert verification record
    const { weight, tier } = this.computeDomainWeight(domain);
    await pool.query(
      `INSERT INTO institutional_verifications
       (practitioner_id, institutional_email, domain, token_hash, expires_at, domain_weight, domain_tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [practitionerId, institutionalEmail, domain, tokenHash, expiresAt, weight, tier]
    );

    // 6. Send email
    const portalUrl = process.env.VERIFICATION_PORTAL_URL || 'http://localhost:3000';
    await emailService.sendEmail(institutionalEmail, 'institutional_verify', {
      verification_link: `${portalUrl}/verify-email?token=${rawToken}`,
    });

    // 7. Audit log
    await writeAuditLog({
      actorId: practitionerId,
      actorType: 'practitioner',
      action: 'INSTITUTIONAL_EMAIL_SENT',
      targetId: practitionerId,
      metadata: { domain },
    });

    logger.info('Institutional verification email sent', { practitionerId, domain });

    return { sent: true, domain, expires_in_hours: 24 };
  }

  /**
   * Confirm an institutional email verification via token.
   *
   * @param {string} rawToken - The raw token from the email link
   * @returns {object} { verified, domain, new_trust_score, badge_level }
   */
  async confirmVerification(rawToken) {
    // 1. Hash token
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // 2. Look up pending verification
    const result = await pool.query(
      `SELECT id, practitioner_id, institutional_email, domain, domain_weight
       FROM institutional_verifications
       WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      const err = new Error('Invalid or expired verification token');
      err.code = 'INVALID_OR_EXPIRED_TOKEN';
      throw err;
    }

    const record = result.rows[0];

    // 3. Mark as verified
    await pool.query(
      `UPDATE institutional_verifications SET status = 'VERIFIED', verified_at = NOW() WHERE id = $1`,
      [record.id]
    );

    // 4. Update practitioner
    await pool.query(
      `UPDATE practitioners SET
         institutional_email = $1,
         institutional_email_verified = true,
         institutional_email_verified_at = NOW()
       WHERE id = $2`,
      [record.institutional_email, record.practitioner_id]
    );

    // 5. Trigger VerificationEngine step
    let engineResult = { trustScore: 0, badgeLevel: 'NONE' };
    try {
      engineResult = await engine.processStep(record.practitioner_id, 'INSTITUTIONAL_EMAIL_VERIFIED', {
        domain: record.domain,
        domainWeight: record.domain_weight,
      });
    } catch (err) {
      logger.warn('INSTITUTIONAL_EMAIL_VERIFIED step failed', { error: err.message, practitionerId: record.practitioner_id });
    }

    // 6. Audit log
    await writeAuditLog({
      actorId: record.practitioner_id,
      actorType: 'practitioner',
      action: 'INSTITUTIONAL_EMAIL_VERIFIED',
      targetId: record.practitioner_id,
      metadata: { domain: record.domain },
    });

    logger.info('Institutional email verified', { practitionerId: record.practitioner_id, domain: record.domain });

    return {
      verified: true,
      domain: record.domain,
      new_trust_score: engineResult.trustScore,
      badge_level: engineResult.badgeLevel,
    };
  }

  /**
   * Get the list of approved institutional domains.
   *
   * @returns {object} { domains, count }
   */
  getDomainWhitelist() {
    return {
      domains: DOMAIN_WHITELIST,
      count: DOMAIN_WHITELIST.length,
    };
  }

  /**
   * Compute the domain weight and tier.
   *
   * @param {string} domain
   * @returns {object} { weight, tier }
   */
  computeDomainWeight(domain) {
    let weight = 8;
    let tier = 'INSTITUTION';
    if (domain.includes('chu')) { weight = 30; tier = 'TEACHING_HOSPITAL'; }
    else if (domain.includes('hopital')) { weight = 20; tier = 'HOSPITAL'; }
    else if (domain.includes('clinique')) { weight = 10; tier = 'PRIVATE_CLINIC'; }
    else if (domain.includes('univ')) { weight = 15; tier = 'UNIVERSITY'; }
    else if (domain.includes('ens') || domain.includes('école')) { weight = 12; tier = 'SCHOOL'; }
    return { weight, tier };
  }

  // ══════════════════════════════════════════════════
  // LEVEL 2: Institutional Proof (admin confirms doctor)
  // ══════════════════════════════════════════════════

  /**
   * Request institutional confirmation from an HR/admin email.
   */
  async requestInstitutionalConfirmation(practitionerId, institutionAdminEmail) {
    const parts = institutionAdminEmail.split('@');
    if (parts.length !== 2) {
      const err = new Error('Invalid email format');
      err.code = 'INVALID_EMAIL';
      throw err;
    }

    const domain = parts[1].toLowerCase();
    if (DOMAIN_WHITELIST.length > 0 && !DOMAIN_WHITELIST.includes(domain)) {
      const err = new Error('Domain not in approved institutional list');
      err.code = 'DOMAIN_NOT_APPROVED';
      throw err;
    }

    // Prevent self-confirmation
    const practResult = await pool.query(
      'SELECT institutional_email, trustmed_id, full_name FROM practitioners WHERE id = $1',
      [practitionerId]
    );
    if (practResult.rows.length === 0) {
      const err = new Error('Practitioner not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const pract = practResult.rows[0];
    if (pract.institutional_email && pract.institutional_email.toLowerCase() === institutionAdminEmail.toLowerCase()) {
      const err = new Error('Admin email must differ from practitioner institutional email');
      err.code = 'SELF_CONFIRMATION';
      throw err;
    }

    // Expire pending confirmations
    await pool.query(
      `UPDATE institutional_confirmations SET status = 'EXPIRED' WHERE practitioner_id = $1 AND status = 'PENDING'`,
      [practitionerId]
    );

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const { tier } = this.computeDomainWeight(domain);
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO institutional_confirmations
       (practitioner_id, institution_email, institution_domain, domain_tier,
        confirmation_token, token_hash, admin_email, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [practitionerId, institutionAdminEmail, domain, tier, rawToken, tokenHash, institutionAdminEmail, expiresAt]
    );

    const portalUrl = process.env.VERIFICATION_PORTAL_URL || 'http://localhost:3000';
    await emailService.sendEmail(institutionAdminEmail, 'institutional_confirmation_request', {
      trustmed_id: pract.trustmed_id,
      full_name: pract.full_name,
      confirm_url: `${portalUrl}/institutional/confirm-institution?token=${rawToken}`,
      reject_url: `${portalUrl}/institutional/reject-institution?token=${rawToken}`,
    });

    await writeAuditLog({
      actorId: practitionerId,
      actorType: 'practitioner',
      action: 'INSTITUTIONAL_CONFIRMATION_REQUESTED',
      targetId: practitionerId,
      metadata: { institution_domain: domain, admin_email_hash: crypto.createHash('sha256').update(institutionAdminEmail).digest('hex') },
    });

    logger.info('Institutional confirmation requested', { practitionerId, domain });
    return { sent: true, admin_email: institutionAdminEmail, expires_in_hours: 72 };
  }

  /**
   * Institution admin confirms the doctor's affiliation.
   */
  async confirmByInstitution(rawToken) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const result = await pool.query(
      `SELECT id, practitioner_id, institution_domain, admin_email
       FROM institutional_confirmations
       WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      const err = new Error('Invalid or expired confirmation token');
      err.code = 'INVALID_OR_EXPIRED_TOKEN';
      throw err;
    }

    const record = result.rows[0];

    await pool.query(
      `UPDATE institutional_confirmations SET status = 'CONFIRMED', confirmed_at = NOW() WHERE id = $1`,
      [record.id]
    );

    // Grant bonus +5 trust
    await pool.query(
      `UPDATE practitioners SET trust_score = LEAST(trust_score + 5, 100), base_trust_score = LEAST(base_trust_score + 5, 100) WHERE id = $1`,
      [record.practitioner_id]
    );

    // Record in trust_score_history
    const practRes = await pool.query('SELECT trust_score, base_trust_score, risk_score FROM practitioners WHERE id = $1', [record.practitioner_id]);
    if (practRes.rows.length > 0) {
      const p = practRes.rows[0];
      await pool.query(
        `INSERT INTO trust_score_history (practitioner_id, trust_score, base_score, risk_score, trigger_event)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.practitioner_id, p.trust_score, p.base_trust_score, p.risk_score || 0, 'INSTITUTIONAL_CONFIRMATION']
      );
    }

    // Vault legal record
    const LegalVaultService = require('../legal-vault/LegalVaultService');
    const vault = new LegalVaultService();
    await vault.recordDeclaration(record.practitioner_id, 'INSTITUTIONAL_CONFIRMATION', {
      domain: record.institution_domain,
      admin_email_hash: crypto.createHash('sha256').update(record.admin_email).digest('hex'),
    });

    await writeAuditLog({
      actorType: 'system',
      action: 'INSTITUTIONAL_CONFIRMED',
      targetId: record.practitioner_id,
      metadata: { domain: record.institution_domain, bonus_trust: 5 },
    });

    const tmRes = await pool.query('SELECT trustmed_id FROM practitioners WHERE id = $1', [record.practitioner_id]);
    logger.info('Institution confirmed affiliation', { practitionerId: record.practitioner_id, domain: record.institution_domain });

    return {
      confirmed: true,
      practitioner_trustmed_id: tmRes.rows[0]?.trustmed_id,
      bonus_trust: 5,
    };
  }

  /**
   * Institution admin rejects the doctor's affiliation.
   */
  async rejectByInstitution(rawToken, reason) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const result = await pool.query(
      `SELECT id, practitioner_id, institution_domain
       FROM institutional_confirmations
       WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      const err = new Error('Invalid or expired confirmation token');
      err.code = 'INVALID_OR_EXPIRED_TOKEN';
      throw err;
    }

    const record = result.rows[0];

    await pool.query(
      `UPDATE institutional_confirmations SET status = 'REJECTED', rejected_reason = $1 WHERE id = $2`,
      [reason || 'No reason provided', record.id]
    );

    // MAJOR red flag: institution explicitly denies
    const practRes = await pool.query('SELECT risk_flags, risk_score, full_name, email FROM practitioners WHERE id = $1', [record.practitioner_id]);
    if (practRes.rows.length > 0) {
      const pract = practRes.rows[0];
      let risk_flags = pract.risk_flags || [];
      risk_flags.push({
        signal: 'INSTITUTION_DENIED_AFFILIATION',
        severity: 'HIGH',
        risk_points: 60,
        details: { domain: record.institution_domain, reason: reason || 'No reason' }
      });
      const newRiskScore = (pract.risk_score || 0) + 60;

      let updateQuery = 'UPDATE practitioners SET risk_score = $1, risk_flags = $2';
      const params = [newRiskScore, JSON.stringify(risk_flags)];

      // Auto-freeze if risk >= 60
      if (newRiskScore >= 60) {
        updateQuery += ', verification_status = $3';
        params.push('FLAGGED');
      }
      updateQuery += ' WHERE id = $' + (params.length + 1);
      params.push(record.practitioner_id);

      await pool.query(updateQuery, params);

      // Email practitioner
      if (pract.email) {
        await emailService.sendEmail(pract.email, 'institutional_affiliation_denied', {
          full_name: pract.full_name,
          domain: record.institution_domain,
        });
      }
    }

    await writeAuditLog({
      actorType: 'system',
      action: 'INSTITUTION_DENIED',
      targetId: record.practitioner_id,
      metadata: { domain: record.institution_domain, reason },
    });

    logger.warn('Institution denied affiliation', { practitionerId: record.practitioner_id, domain: record.institution_domain });
  }
}

module.exports = InstitutionalEmailService;
