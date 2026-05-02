const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const { publishDocumentJob } = require('../../shared/queue/publisher');
const logger = require('../../shared/logger');
const TrustScoreCalculator = require('./TrustScoreCalculator');
const LegalVaultService = require('../legal-vault/LegalVaultService');
const WebhookDispatcher = require('../webhook/WebhookDispatcher');

/**
 * VerificationEngine — State machine that processes verification steps.
 *
 * Steps (in typical order):
 *   1. NFC_COMPLETE                    → IDENTITY_CONFIRMED, +25 trust
 *   2. DECLARATION_SIGNED             → stays same status,   +5 trust
 *   3. DOCUMENTS_UPLOADED             → PROVISIONAL,         +0 trust (publishes RabbitMQ job)
 *   4. CNOM_CONFIRMED                 → CNOM_CONFIRMED,      +15 trust (fires webhook)
 *   5. PHONE_OTP_VERIFIED             → PHONE_VERIFIED,      +10 trust
 *   6. INSTITUTIONAL_EMAIL_VERIFIED   → no status change,    +20 trust (fires webhook)
 *   7. PEER_VOUCHING_COMPLETE         → FULLY_VERIFIED,      +25 trust (fires webhook)
 *   X. DOCUMENT_CLEAN                 → no status change,    +0 trust  (feeds Risk Score only)
 */

// Valid state transitions: from → allowed steps
const STATE_TRANSITIONS = {
  IDENTITY_PENDING:    ['NFC_COMPLETE'],
  IDENTITY_CONFIRMED:  ['DECLARATION_SIGNED', 'DOCUMENTS_UPLOADED'],
  PROVISIONAL:         ['CNOM_CONFIRMED', 'DOCUMENT_CLEAN', 'LIVENESS_VERIFIED'],
  CNOM_CONFIRMED:      ['PHONE_OTP_VERIFIED', 'DOCUMENT_CLEAN', 'LIVENESS_VERIFIED'],
  PHONE_VERIFIED:      ['INSTITUTIONAL_EMAIL_VERIFIED', 'PEER_VOUCHING_COMPLETE', 'DOCUMENT_CLEAN', 'LIVENESS_VERIFIED'],
  VOUCHING_PENDING:    ['PEER_VOUCHING_COMPLETE', 'INSTITUTIONAL_EMAIL_VERIFIED', 'DOCUMENT_CLEAN', 'LIVENESS_VERIFIED'],
  FULLY_VERIFIED:      ['DOCUMENT_CLEAN', 'LIVENESS_VERIFIED'],
  FLAGGED:             [],
  SUSPENDED:           [],
  RETIRED:             [],
};

// Step → resulting verification_status (null means no status change)
const STEP_STATUS_MAP = {
  NFC_COMPLETE:                  'IDENTITY_CONFIRMED',
  DECLARATION_SIGNED:            null, // stays at current status
  DOCUMENTS_UPLOADED:            'PROVISIONAL',
  DOCUMENT_CLEAN:                null, // no status change, Risk Score only
  CNOM_CONFIRMED:                'CNOM_CONFIRMED',
  PHONE_OTP_VERIFIED:            'PHONE_VERIFIED',
  INSTITUTIONAL_EMAIL_VERIFIED:  null, // additive, no status change
  PEER_VOUCHING_COMPLETE:        'FULLY_VERIFIED',
  LIVENESS_VERIFIED:             null, // additive, no status change
};

// Steps that trigger a webhook to the partner
const WEBHOOK_STEPS = ['CNOM_CONFIRMED', 'PHONE_OTP_VERIFIED', 'INSTITUTIONAL_EMAIL_VERIFIED', 'PEER_VOUCHING_COMPLETE', 'LIVENESS_VERIFIED'];

class VerificationEngine {
  /**
   * Process a verification step for a practitioner.
   *
   * @param {string} practitionerId - UUID of the practitioner
   * @param {string} step           - Step name (e.g. 'NFC_COMPLETE')
   * @param {object} data           - Step-specific payload
   * @returns {object} Updated practitioner state
   */
  async processStep(practitionerId, step, data = {}) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Get current practitioner state (with row lock)
      const practResult = await client.query(
        `SELECT id, trustmed_id, verification_status, trust_score, badge_level,
                full_name, cin_number, nfc_identity_hash, risk_score, risk_flags,
                privacy_consented, base_trust_score, trust_confidence,
                shadow_banned, stake_status, can_progress_after
         FROM practitioners
         WHERE id = $1
         FOR UPDATE`,
        [practitionerId]
      );

      if (practResult.rows.length === 0) {
        throw new Error(`Practitioner not found: ${practitionerId}`);
      }

      const practitioner = practResult.rows[0];

      if (!practitioner.privacy_consented) {
        const err = new Error('Practitioner must accept privacy policy before verification');
        err.code = 'CONSENT_REQUIRED';
        throw err;
      }

      // Shadow ban gate: return fake success without DB mutations
      if (practitioner.shadow_banned) {
        const delta = TrustScoreCalculator.getStepPoints(step);
        const fakeScore = Math.min((practitioner.trust_score || 0) + delta, 100);
        await client.query('ROLLBACK');
        client.release();
        logger.info('Shadow ban: returning fake success', { practitionerId, step });
        return {
          practitionerId,
          trustmedId: practitioner.trustmed_id,
          verificationStatus: practitioner.verification_status,
          trustScore: fakeScore,
          baseTrustScore: (practitioner.base_trust_score || 0) + delta,
          trustConfidence: practitioner.trust_confidence || 'HIGH',
          badgeLevel: TrustScoreCalculator.getBadgeLevel(fakeScore),
          step,
        };
      }

      // Economic friction gate
      const EconomicDefenseService = require('../economic/EconomicDefenseService');
      const economicService = new EconomicDefenseService();
      await economicService.enforceFriction(practitioner, client);

      const currentStatus = practitioner.verification_status;

      // 2. Validate state transition
      const allowedSteps = STATE_TRANSITIONS[currentStatus];
      if (!allowedSteps) {
        throw new Error(`Practitioner is in terminal state: ${currentStatus}`);
      }

      // For DECLARATION_SIGNED, check it happens after NFC (trust_score >= 25)
      if (step === 'DOCUMENTS_UPLOADED' && practitioner.trust_score < 30) {
        throw new Error('Declaration must be signed before uploading documents');
      }

      if (!allowedSteps.includes(step)) {
        throw new Error(
          `Step "${step}" is not allowed from status "${currentStatus}". ` +
          `Allowed steps: ${allowedSteps.join(', ')}`
        );
      }

      // 3. Calculate new trust score
      let delta = TrustScoreCalculator.getStepPoints(step);
      if (step === 'INSTITUTIONAL_EMAIL_VERIFIED' && data.domainWeight) {
        delta = Math.max(5, Math.min(20, Math.round((data.domainWeight / 30) * 20)));
      }
      const currentBase = practitioner.base_trust_score > 0 ? practitioner.base_trust_score : practitioner.trust_score;
      const newBaseScore = Math.min(currentBase + delta, TrustScoreCalculator.getMaxScore());
      
      const { final_score: newScore, trust_confidence } = TrustScoreCalculator.computeFinalScore(
        newBaseScore, 
        practitioner.risk_score, 
        practitioner.risk_flags || []
      );
      const newBadge = TrustScoreCalculator.getBadgeLevel(newScore);
      // 4. Determine new status
      const newStatus = STEP_STATUS_MAP[step] || currentStatus;

      // 5. Execute step-specific logic
      await this._executeStepLogic(client, practitioner, step, data);

      // 6. Update practitioner
      await client.query(
        `UPDATE practitioners
         SET verification_status = $1,
             trust_score = $2,
             badge_level = $3,
             base_trust_score = $4,
             trust_confidence = $5,
             updated_at = NOW()
         WHERE id = $6`,
        [newStatus, newScore, newBadge, newBaseScore, trust_confidence, practitionerId]
      );

      // 7. Audit log
      await writeAuditLog({
        actorId: practitionerId,
        actorType: 'practitioner',
        action: `VERIFICATION_STEP_${step}`,
        targetId: practitionerId,
        metadata: {
          previousStatus: currentStatus,
          newStatus,
          previousScore: practitioner.trust_score,
          newScore,
          newBaseScore,
          trust_confidence,
          newBadge,
        },
        ipAddress: data.ipAddress || null,
        client,
      });

      // 8. Record trust score history (for velocity analysis)
      await client.query(
        `INSERT INTO trust_score_history (practitioner_id, trust_score, base_score, risk_score, trigger_event)
         VALUES ($1, $2, $3, $4, $5)`,
        [practitionerId, newScore, newBaseScore, practitioner.risk_score || 0, step]
      );

      await client.query('COMMIT');

      logger.info('Verification step processed', {
        practitionerId,
        step,
        previousStatus: currentStatus,
        newStatus,
        previousScore: practitioner.trust_score,
        newScore,
        newBaseScore,
        trust_confidence,
        newBadge,
      });

      // 8. Fire webhook (after commit, non-blocking)
      if (WEBHOOK_STEPS.includes(step)) {
        this._fireWebhooks(practitionerId, newStatus, newScore, newBadge, practitioner.risk_score).catch((err) => {
          logger.error('Webhook dispatch failed', { error: err.message, practitionerId, step });
        });
      }

      return {
        practitionerId,
        trustmedId: practitioner.trustmed_id,
        verificationStatus: newStatus,
        trustScore: newScore,
        baseTrustScore: newBaseScore,
        trustConfidence: trust_confidence,
        badgeLevel: newBadge,
        step,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Verification step failed', {
        practitionerId,
        step,
        error: err.message,
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Execute step-specific business logic.
   * @private
   */
  async _executeStepLogic(client, practitioner, step, data) {
    switch (step) {
      case 'NFC_COMPLETE':
        await this._handleNfcComplete(client, practitioner, data);
        break;
      case 'DECLARATION_SIGNED':
        await this._handleDeclarationSigned(client, practitioner, data);
        break;
      case 'DOCUMENTS_UPLOADED':
        await this._handleDocumentsUploaded(client, practitioner, data);
        break;
      case 'DOCUMENT_CLEAN':
        await this._handleDocumentClean(client, practitioner, data);
        break;
      case 'CNOM_CONFIRMED':
        await this._handleCnomConfirmed(client, practitioner, data);
        break;
      case 'PHONE_OTP_VERIFIED':
        await this._handlePhoneOtpVerified(client, practitioner, data);
        break;
      case 'INSTITUTIONAL_EMAIL_VERIFIED':
        await this._handleInstitutionalEmailVerified(client, practitioner, data);
        break;
      case 'PEER_VOUCHING_COMPLETE':
        await this._handlePeerVouchingComplete(client, practitioner, data);
        break;
      case 'LIVENESS_VERIFIED':
        await this._handleLivenessVerified(client, practitioner, data);
        break;
      default:
        throw new Error(`Unhandled step: ${step}`);
    }
  }

  async _handleLivenessVerified(client, practitioner, data) {
    logger.info('Liveness and face match verified', { practitionerId: practitioner.id });
  }

  async _handleNfcComplete(client, practitioner, data) {
    // Update NFC identity hash if provided
    if (data.nfcIdentityHash) {
      await client.query(
        'UPDATE practitioners SET nfc_identity_hash = $1 WHERE id = $2',
        [data.nfcIdentityHash, practitioner.id]
      );
    }
    logger.info('NFC verification completed', { practitionerId: practitioner.id });
  }

  async _handleDeclarationSigned(client, practitioner, data) {
    // Create a legal vault record
    const legalVault = new LegalVaultService();
    await legalVault.createDeclaration({
      practitionerId: practitioner.id,
      declarationText: data.declarationText || 'Standard TrustMed legal declaration under Art. 243 Code Pénal Algérien',
      cinNumber: data.cinNumber || practitioner.cin_number,
      selfieVectorHash: data.selfieVectorHash || null,
      ipAddress: data.ipAddress || null,
      deviceFingerprint: data.deviceFingerprint || null,
      geolocation: data.geolocation || null,
    }, client);

    logger.info('Legal declaration signed and sealed', { practitionerId: practitioner.id });
  }

  async _handleDocumentsUploaded(client, practitioner, data) {
    // Insert document record
    const docId = data.documentId || require('uuid').v4();
    await client.query(
      `INSERT INTO documents (id, practitioner_id, doc_type, storage_key, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       ON CONFLICT DO NOTHING`,
      [docId, practitioner.id, data.docType || 'general', data.storageKey || `docs/${practitioner.id}/${docId}`]
    );

    // Publish PROCESS_DOCUMENTS job to RabbitMQ (outside transaction)
    setImmediate(async () => {
      try {
        await publishDocumentJob({
          practitionerId: practitioner.id,
          documentId: docId,
          docType: data.docType || 'general',
        });
      } catch (err) {
        logger.error('Failed to publish document job', { error: err.message });
      }
    });

    logger.info('Documents uploaded, processing job queued', {
      practitionerId: practitioner.id,
      documentId: docId,
    });
  }

  async _handleDocumentClean(client, practitioner, data) {
    // Update document status if documentId provided
    if (data.documentId) {
      await client.query(
        `UPDATE documents SET status = 'CLEAN', pattern_score = $1, processed_at = NOW()
         WHERE id = $2 AND practitioner_id = $3`,
        [data.patternScore || 0, data.documentId, practitioner.id]
      );
    }
    logger.info('Document passed pattern analysis (Risk Score only)', { practitionerId: practitioner.id });
  }

  async _handleCnomConfirmed(client, practitioner, data) {
    // Insert CNOM verification record
    await client.query(
      `INSERT INTO cnom_verifications 
       (practitioner_id, cnom_number, scraped_name, scraped_specialty, scraped_status, source_url, match_score, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        practitioner.id,
        data.cnomNumber || practitioner.cnom_number || 'N/A',
        data.scrapedName || practitioner.full_name,
        data.scrapedSpecialty || null,
        data.scrapedStatus || 'active',
        data.sourceUrl || null,
        data.matchScore || 100,
        data.result || 'CONFIRMED',
      ]
    );

    // Update CNOM number on practitioner if provided
    if (data.cnomNumber) {
      await client.query(
        'UPDATE practitioners SET cnom_number = $1 WHERE id = $2',
        [data.cnomNumber, practitioner.id]
      );
    }

    logger.info('CNOM verification confirmed', { practitionerId: practitioner.id });
  }

  async _handlePhoneOtpVerified(client, practitioner, data) {
    // Insert or update phone verification record
    await client.query(
      `INSERT INTO phone_verifications 
       (practitioner_id, phone_number, status, verified_at)
       VALUES ($1, $2, 'VERIFIED', NOW())`,
      [practitioner.id, data.phoneNumber || 'N/A']
    );

    logger.info('Phone OTP verified', { practitionerId: practitioner.id });
  }

  async _handleInstitutionalEmailVerified(client, practitioner, data) {
    // Mark institutional email as verified on practitioner
    await client.query(
      `UPDATE practitioners SET
         institutional_email_verified = true,
         institutional_email_verified_at = NOW()
       WHERE id = $1`,
      [practitioner.id]
    );
    logger.info('Institutional email verified', { practitionerId: practitioner.id, domain: data.domain });
  }

  async _handlePeerVouchingComplete(client, practitioner, data) {
    logger.info('Peer vouching complete — practitioner achieves FULLY_VERIFIED', { practitionerId: practitioner.id });
  }

  /**
   * Fire webhooks to all partners with active sessions for this practitioner.
   * @private
   */
  async _fireWebhooks(practitionerId, newStatus, trustScore, badgeLevel, riskScore) {
    const result = await pool.query(
      `SELECT DISTINCT p.id, p.webhook_url, p.webhook_secret
       FROM partners p
       INNER JOIN verification_sessions vs ON vs.partner_id = p.id
       WHERE vs.practitioner_id = $1
         AND p.webhook_url IS NOT NULL
         AND p.is_active = true`,
      [practitionerId]
    );

    const dispatcher = new WebhookDispatcher();

    for (const partner of result.rows) {
      await dispatcher.dispatch({
        url: partner.webhook_url,
        secret: partner.webhook_secret,
        payload: {
          event: 'practitioner.status_changed',
          practitioner_id: practitionerId,
          verification_status: newStatus,
          trust_score: trustScore,
          badge_level: badgeLevel,
          risk_score: riskScore || 0,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }
}

module.exports = VerificationEngine;
