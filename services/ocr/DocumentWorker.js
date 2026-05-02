/**
 * DocumentWorker — Real RabbitMQ consumer for PROCESS_DOCUMENTS jobs.
 *
 * Replaces the stub consumer. Runs as a separate process:
 *   node services/ocr/DocumentWorker.js
 *
 * For each job: download → OCR → fraud detection → branch on recommendation.
 */
require('dotenv').config();
const pool = require('../../shared/db/pool');
const { connectQueue, getChannel } = require('../../shared/queue/connection');
const { DOCUMENT_QUEUE } = require('../../shared/queue/publisher');
const { writeAuditLog } = require('../../shared/db/audit');
const StorageService = require('../../shared/storage/StorageService');
const OcrService = require('./OcrService');
const FraudDetector = require('./FraudDetector');
const VisionVerificationService = require('./VisionVerificationService');
const VerificationEngine = require('../verification/VerificationEngine');
const WebhookDispatcher = require('../webhook/WebhookDispatcher');
const logger = require('../../shared/logger');

const storage = new StorageService();
const ocrService = new OcrService();
const fraudDetector = new FraudDetector();
const visionService = new VisionVerificationService();
const verificationEngine = new VerificationEngine();
const webhookDispatcher = new WebhookDispatcher();

const COMPLIANCE_WEBHOOK_URL = process.env.COMPLIANCE_WEBHOOK_URL || '';

/**
 * Process a single PROCESS_DOCUMENTS job.
 */
async function processDocument(job) {
  const { practitionerId, documentId, docType, storageKey } = job;

  logger.info('Processing document', { practitionerId, documentId, docType });

  // 1. Download and decrypt the document
  const { buffer, mimeType } = await storage.downloadDocument(storageKey);

  // Upgrade B: Liveness Check for SELFIE
  if (docType === 'SELFIE') {
    const LivenessService = require('../liveness/LivenessService');
    const livenessService = new LivenessService();
    
    const cinResult = await pool.query(
      `SELECT id FROM documents WHERE practitioner_id = $1 AND doc_type IN ('CIN', 'PASSPORT') AND status = 'PROCESSED' ORDER BY created_at DESC LIMIT 1`,
      [practitionerId]
    );

    if (cinResult.rows.length === 0) {
      logger.warn('Liveness check skipped: No processed CIN/PASSPORT found', { practitionerId });
      await pool.query(`UPDATE documents SET status = 'FAILED' WHERE id = $1`, [documentId]);
      return;
    }

    try {
      await livenessService.verifyPractitionerLiveness(practitionerId, documentId, cinResult.rows[0].id, pool);
      await pool.query(`UPDATE documents SET status = 'PROCESSED', processed_at = NOW() WHERE id = $1`, [documentId]);
    } catch (err) {
      logger.error('Liveness processing error', { error: err.message, practitionerId });
      await pool.query(`UPDATE documents SET status = 'FAILED' WHERE id = $1`, [documentId]);
    }
    return; // End processing for SELFIE
  }

  // 2. Run OCR analysis (Azure primary, Tesseract fallback)
  const ocrResult = await ocrService.analyzeDocument(buffer, mimeType, docType);

  // 3. Fetch practitioner profile for fraud checks
  const practResult = await pool.query(
    'SELECT * FROM practitioners WHERE id = $1',
    [practitionerId]
  );
  if (practResult.rows.length === 0) {
    throw new Error(`Practitioner not found: ${practitionerId}`);
  }
  const practitioner = practResult.rows[0];

  // 4. Run fraud detection
  const fraudResult = fraudDetector.detectFraud(
    { ...ocrResult.extracted_fields, confidence_scores: ocrResult.confidence_scores },
    docType,
    practitioner,
    buffer
  );

  // 4b. Run multi-model Vision AI verification
  if (docType === 'DIPLOMA' || docType === 'CNOM_CARD') {
    try {
      logger.info('Initiating Multi-Model Vision AI verification', { documentId, docType });
      const visionResult = await visionService.evaluateDiploma(buffer, mimeType);
      
      if (!visionResult.is_authentic) {
        fraudResult.flags.push({
          check: 'VISION_AI_REJECTION',
          severity: 'HIGH',
          score_penalty: 50,
          details: visionResult
        });
        fraudResult.fraud_score = Math.max(0, fraudResult.fraud_score - 50);
        fraudResult.recommendation = 'FREEZE';
      } else {
        logger.info('Vision AI confirmed authenticity', { documentId, score: visionResult.score });
      }
    } catch (vErr) {
      logger.warn('Vision AI verification failed (non-blocking)', { error: vErr.message });
    }
  }

  // 5. Update document record
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE documents
       SET ocr_result = $1, fraud_flags = $2, fraud_score = $3,
           pattern_score = $4, status = 'PROCESSED', processed_at = NOW()
       WHERE id = $5`,
      [
        JSON.stringify(ocrResult.extracted_fields),
        JSON.stringify(fraudResult.flags),
        fraudResult.fraud_score,
        fraudResult.fraud_score,
        documentId,
      ]
    );

    if (docType === 'AGREMENT') {
      const expiry = ocrResult.extracted_fields.expiry_date;
      if (expiry) {
        await client.query(
          `UPDATE practitioners SET agrement_expiry = $1 WHERE id = $2`,
          [expiry, practitionerId]
        );
      } else {
        await client.query(
          `UPDATE practitioners SET annual_resubmit_due_at = COALESCE(verified_at, NOW()) + INTERVAL '11 months' WHERE id = $1`,
          [practitionerId]
        );
      }
    }

    // 6. Audit log
    await writeAuditLog({
      actorType: 'system',
      action: 'DOCUMENT_PROCESSED',
      targetId: documentId,
      metadata: {
        practitionerId,
        docType,
        fraudScore: fraudResult.fraud_score,
        recommendation: fraudResult.recommendation,
        flagCount: fraudResult.flags.length,
      },
      client,
    });

    // 6b. Predictive risk analysis
    try {
      const PredictiveRiskService = require('../risk/PredictiveRiskService');
      const predictive = new PredictiveRiskService();
      await predictive.recordBehavioralEvent(practitionerId, 'DOCUMENT_UPLOAD_COMPLETED', { docType, documentId }, {}, pool);
      await predictive.scoreSequenceAnomaly(practitionerId, pool);
      await predictive.computeRiskMomentum(practitionerId, pool);
      await predictive.evaluateShadowBan(practitionerId, pool);
    } catch (predErr) {
      logger.warn('Predictive risk analysis failed (non-blocking)', { error: predErr.message });
    }

    // 7. Branch on recommendation
    switch (fraudResult.recommendation) {
      case 'AUTO_APPROVE':
        logger.info('Document auto-approved', { documentId, score: fraudResult.fraud_score });
        
        if (docType === 'AGREMENT') {
          await client.query(
            `UPDATE practitioners SET last_resubmit_at = NOW(), annual_resubmit_due_at = NOW() + INTERVAL '11 months' WHERE id = $1`,
            [practitionerId]
          );
          await writeAuditLog({
            actorType: 'system',
            action: 'ANNUAL_RESUBMIT_COMPLETED',
            targetId: practitionerId,
            client,
          });
        }
        
        await client.query('COMMIT');
        // Trigger DOCUMENT_CLEAN step (outside transaction)
        try {
          await verificationEngine.processStep(practitionerId, 'DOCUMENT_CLEAN', {
            documentId,
            patternScore: fraudResult.fraud_score,
          });
        } catch (err) {
          // DOCUMENT_CLEAN may not be valid for current state — that's OK
          logger.warn('DOCUMENT_CLEAN step skipped', { error: err.message, practitionerId });
        }
        break;

      case 'HUMAN_REVIEW':
        logger.warn('Document routed to human review', {
          documentId,
          score: fraudResult.fraud_score,
          flags: fraudResult.flags.map((f) => f.check),
        });
        // Update practitioner status to FLAGGED (under review)
        await client.query(
          `UPDATE practitioners SET verification_status = 'FLAGGED', updated_at = NOW() WHERE id = $1`,
          [practitionerId]
        );
        // Insert into reviewer_queue
        await client.query(
          `INSERT INTO reviewer_queue (practitioner_id, document_id, reason)
           VALUES ($1, $2, $3)`,
          [
            practitionerId,
            documentId,
            `Fraud score: ${fraudResult.fraud_score}. Flags: ${fraudResult.flags.map((f) => f.check).join(', ')}`,
          ]
        );
        await client.query('COMMIT');
        break;

      case 'FREEZE':
        logger.error('Document FROZEN — suspected fraud', {
          documentId,
          score: fraudResult.fraud_score,
          flags: fraudResult.flags.map((f) => f.check),
        });
        // Update practitioner status to SUSPENDED
        await client.query(
          `UPDATE practitioners SET verification_status = 'SUSPENDED', updated_at = NOW() WHERE id = $1`,
          [practitionerId]
        );
        // Insert into reviewer_queue
        await client.query(
          `INSERT INTO reviewer_queue (practitioner_id, document_id, reason)
           VALUES ($1, $2, $3)`,
          [
            practitionerId,
            documentId,
            `FREEZE: Fraud score ${fraudResult.fraud_score}. Flags: ${fraudResult.flags.map((f) => f.check).join(', ')}`,
          ]
        );
        await client.query('COMMIT');

        // Dispatch compliance alert webhook
        if (COMPLIANCE_WEBHOOK_URL) {
          webhookDispatcher.dispatch({
            url: COMPLIANCE_WEBHOOK_URL,
            secret: process.env.HMAC_SECRET,
            payload: {
              event: 'compliance.fraud_alert',
              practitioner_id: practitionerId,
              document_id: documentId,
              fraud_score: fraudResult.fraud_score,
              flags: fraudResult.flags,
              timestamp: new Date().toISOString(),
            },
          }).catch((err) => {
            logger.error('Compliance webhook failed', { error: err.message });
          });
        }
        break;

      default:
        await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 8. Compute practitioner-level Risk Score (after all document processing)
  try {
    const riskResult = await FraudDetector.computeRiskSignals(practitionerId, pool);

    await pool.query(
      `UPDATE practitioners SET risk_score = $1, risk_flags = $2 WHERE id = $3`,
      [riskResult.risk_score, JSON.stringify(riskResult.risk_flags), practitionerId]
    );

    await writeAuditLog({
      actorType: 'system',
      action: 'RISK_SCORE_UPDATED',
      targetId: practitionerId,
      metadata: {
        risk_score: riskResult.risk_score,
        risk_level: riskResult.risk_level,
        flag_count: riskResult.risk_flags.filter(f => f.severity !== 'SKIPPED').length,
      },
    });

    // If HIGH risk, also insert into reviewer_queue
    if (riskResult.risk_score >= 60) {
      const docIdResult = await pool.query(
        `SELECT id FROM documents WHERE practitioner_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [practitionerId]
      );
      const latestDocId = docIdResult.rows.length > 0 ? docIdResult.rows[0].id : practitionerId;

      await pool.query(
        `INSERT INTO reviewer_queue (practitioner_id, document_id, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [practitionerId, latestDocId, `HIGH_RISK_SCORE: ${riskResult.risk_score}. Flags: ${riskResult.risk_flags.filter(f => f.severity !== 'SKIPPED').map(f => f.signal).join(', ')}`]
      );

      logger.warn('HIGH risk practitioner routed to reviewer queue', { practitionerId, riskScore: riskResult.risk_score });
    }

    logger.info('Risk score updated', { practitionerId, riskScore: riskResult.risk_score, riskLevel: riskResult.risk_level });
  } catch (err) {
    logger.error('Failed to compute risk signals', { error: err.message, practitionerId });
  }
}

/**
 * Start the DocumentWorker consumer.
 */
async function start() {
  logger.info('DocumentWorker starting...');

  await connectQueue();
  const channel = getChannel();
  await channel.assertQueue(DOCUMENT_QUEUE, { durable: true });
  channel.prefetch(1);

  logger.info(`DocumentWorker consuming from queue: ${DOCUMENT_QUEUE}`);

  channel.consume(DOCUMENT_QUEUE, async (msg) => {
    if (!msg) return;

    try {
      const content = JSON.parse(msg.content.toString());
      const job = content.payload || content;

      await processDocument(job);
      channel.ack(msg);

      logger.info('Document job completed and acknowledged', {
        documentId: job.documentId,
      });
    } catch (err) {
      logger.error('Document processing failed', { error: err.message, stack: err.stack });
      // NACK without requeue on unrecoverable error
      channel.nack(msg, false, false);
    }
  });
}

// Run as standalone process
if (require.main === module) {
  start().catch((err) => {
    logger.error('DocumentWorker failed to start', { error: err.message });
    process.exit(1);
  });
}

module.exports = { processDocument, start };
