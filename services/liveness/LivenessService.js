const axios = require('axios');
const FormData = require('form-data');
const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');
const StorageService = require('../../shared/storage/StorageService');
const VerificationEngine = require('../verification/VerificationEngine');

const AZURE_FACE_API_KEY = process.env.AZURE_FACE_API_KEY;
const AZURE_FACE_API_ENDPOINT = process.env.AZURE_FACE_API_ENDPOINT;
const LIVENESS_CONFIDENCE_THRESHOLD = parseFloat(process.env.LIVENESS_CONFIDENCE_THRESHOLD || '0.85');
const FACE_MATCH_CONFIDENCE_THRESHOLD = parseFloat(process.env.FACE_MATCH_CONFIDENCE_THRESHOLD || '0.80');

class LivenessService {
  constructor() {
    this.storage = new StorageService();
    this.engine = new VerificationEngine();
  }

  /**
   * Check liveness and extract faceId from a buffer.
   *
   * @param {Buffer} imageBuffer
   * @param {string} mimeType
   * @returns {object} { passed: boolean, score: number, faceId?: string, reason?: string }
   */
  async checkLiveness(imageBuffer, mimeType = 'application/octet-stream') {
    if (!AZURE_FACE_API_KEY || !AZURE_FACE_API_ENDPOINT) {
      throw new Error('Azure Face API keys not configured');
    }

    try {
      const response = await axios.post(
        `${AZURE_FACE_API_ENDPOINT}/face/v1.0/detect`,
        imageBuffer,
        {
          params: {
            returnFaceId: true,
            returnFaceAttributes: 'headPose,blur,exposure,noise,occlusion,qualityForRecognition',
            detectionModel: 'detection_03',
            recognitionModel: 'recognition_04'
          },
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_FACE_API_KEY,
            'Content-Type': mimeType,
          },
        }
      );

      const faces = response.data;

      if (!faces || faces.length === 0) {
        return { passed: false, reason: 'NO_FACE_DETECTED', score: 0 };
      }

      if (faces.length > 1) {
        return { passed: false, reason: 'MULTIPLE_FACES', score: 0 };
      }

      const face = faces[0];
      const attrs = face.faceAttributes;

      // Quality checks
      if (attrs.qualityForRecognition === 'low') {
        return { passed: false, reason: 'LOW_QUALITY', score: 0 };
      }

      if (attrs.blur && attrs.blur.value > 0.5) {
        return { passed: false, reason: 'BLURRY_IMAGE', score: 1 - attrs.blur.value };
      }

      if (attrs.occlusion && (attrs.occlusion.foreheadOccluded || attrs.occlusion.eyeOccluded || attrs.occlusion.mouthOccluded)) {
        return { passed: false, reason: 'FACE_OCCLUDED', score: 0 };
      }

      // Compute a synthetic liveness score based on blur, exposure, and quality
      let livenessScore = 0.5; // Base score
      
      // Add points for lack of blur
      if (attrs.blur) livenessScore += (1 - attrs.blur.value) * 0.2;
      
      // Add points for good exposure
      if (attrs.exposure) {
        if (attrs.exposure.exposureLevel === 'goodExposure') livenessScore += 0.15;
        else livenessScore += 0.05;
      }
      
      // Add points for recognition quality
      if (attrs.qualityForRecognition === 'high') livenessScore += 0.15;
      else if (attrs.qualityForRecognition === 'medium') livenessScore += 0.05;

      livenessScore = Math.min(1.0, livenessScore);

      if (livenessScore >= LIVENESS_CONFIDENCE_THRESHOLD) {
        return { passed: true, score: livenessScore, faceId: face.faceId };
      }

      return { passed: false, reason: 'LOW_CONFIDENCE', score: livenessScore };

    } catch (err) {
      logger.error('Azure Face Detect failed', { error: err.message, response: err.response?.data });
      throw err;
    }
  }

  /**
   * Detect face in a document and compare with a known faceId.
   *
   * @param {string} selfieFaceId
   * @param {Buffer} documentBuffer
   * @param {string} mimeType
   * @returns {object} { matched: boolean, confidence: number, reason?: string }
   */
  async compareFaces(selfieFaceId, documentBuffer, mimeType = 'application/octet-stream') {
    try {
      // 1. Detect face in document
      const detectResponse = await axios.post(
        `${AZURE_FACE_API_ENDPOINT}/face/v1.0/detect`,
        documentBuffer,
        {
          params: {
            returnFaceId: true,
            detectionModel: 'detection_03',
            recognitionModel: 'recognition_04'
          },
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_FACE_API_KEY,
            'Content-Type': mimeType,
          },
        }
      );

      const docFaces = detectResponse.data;
      if (!docFaces || docFaces.length === 0) {
        return { matched: false, confidence: 0, reason: 'NO_FACE_IN_DOCUMENT' };
      }

      const documentFaceId = docFaces[0].faceId;

      // 2. Verify match
      const verifyResponse = await axios.post(
        `${AZURE_FACE_API_ENDPOINT}/face/v1.0/verify`,
        {
          faceId1: selfieFaceId,
          faceId2: documentFaceId
        },
        {
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_FACE_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const match = verifyResponse.data;

      if (match.isIdentical && match.confidence >= FACE_MATCH_CONFIDENCE_THRESHOLD) {
        return { matched: true, confidence: match.confidence };
      }

      return { matched: false, confidence: match.confidence, reason: 'FACE_MISMATCH' };

    } catch (err) {
      logger.error('Azure Face Verify failed', { error: err.message, response: err.response?.data });
      throw err;
    }
  }

  /**
   * Main verification flow for practitioner liveness.
   *
   * @param {string} practitionerId
   * @param {string} selfieDocumentId
   * @param {string} cinDocumentId
   * @param {object} db - pg client or pool
   */
  async verifyPractitionerLiveness(practitionerId, selfieDocumentId, cinDocumentId, db) {
    try {
      // 1. Fetch storage keys
      const docsResult = await db.query(
        `SELECT id, doc_type, storage_key FROM documents WHERE id IN ($1, $2)`,
        [selfieDocumentId, cinDocumentId]
      );

      let selfieKey, cinKey;
      for (const row of docsResult.rows) {
        if (row.id === selfieDocumentId) selfieKey = row.storage_key;
        if (row.id === cinDocumentId) cinKey = row.storage_key;
      }

      if (!selfieKey || !cinKey) {
        throw new Error('Required documents not found in database');
      }

      // 2. Download documents
      const selfieDoc = await this.storage.downloadDocument(selfieKey);
      const cinDoc = await this.storage.downloadDocument(cinKey);

      // 3. Check Liveness
      const livenessResult = await this.checkLiveness(selfieDoc.buffer, selfieDoc.mimeType);

      let matchResult = { matched: false, confidence: 0 };
      
      // 4. Compare faces if liveness passed
      if (livenessResult.passed && livenessResult.faceId) {
        matchResult = await this.compareFaces(livenessResult.faceId, cinDoc.buffer, cinDoc.mimeType);
      }

      // 5. Update documents table
      await db.query(
        `UPDATE documents SET
           liveness_score = $1,
           liveness_passed = $2,
           face_match_score = $3,
           face_match_passed = $4,
           liveness_checked_at = NOW()
         WHERE id = $5`,
        [
          livenessResult.score,
          livenessResult.passed,
          matchResult.confidence,
          matchResult.matched,
          selfieDocumentId
        ]
      );

      // 6. Branch based on results
      if (livenessResult.passed && matchResult.matched) {
        await db.query(
          `UPDATE practitioners SET
             liveness_verified = true,
             liveness_verified_at = NOW(),
             face_verified = true
           WHERE id = $1`,
          [practitionerId]
        );

        await writeAuditLog({
          actorType: 'system',
          action: 'LIVENESS_VERIFIED',
          targetId: practitionerId,
          metadata: { face_match_score: matchResult.confidence },
        });

        // Trigger engine step
        try {
          await this.engine.processStep(practitionerId, 'LIVENESS_VERIFIED', {});
        } catch (err) {
          logger.warn('LIVENESS_VERIFIED step failed', { error: err.message });
        }

      } else {
        // Liveness or Match failed - flag risk
        const reason = livenessResult.passed ? matchResult.reason : livenessResult.reason;
        
        await writeAuditLog({
          actorType: 'system',
          action: 'LIVENESS_FAILED',
          targetId: practitionerId,
          metadata: { reason },
        });

        // Route to reviewer queue
        await db.query(
          `INSERT INTO reviewer_queue (practitioner_id, document_id, reason)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [practitionerId, selfieDocumentId, `LIVENESS_FAILED: ${reason}`]
        );
      }

      return {
        liveness: livenessResult,
        match: matchResult
      };

    } catch (err) {
      logger.error('Error verifying practitioner liveness', { error: err.message, practitionerId });
      throw err;
    }
  }
}

module.exports = LivenessService;
