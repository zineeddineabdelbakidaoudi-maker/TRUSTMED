/**
 * POST /api/vision/analyze — Real-time AI document analysis
 * 
 * Accepts an image upload and runs it through the VisionVerificationService
 * (Gemini + OpenAI consensus) to determine if it is:
 *   1. A real medical diploma (not engineering, law, etc.)
 *   2. Authentic (not a forgery / photoshopped)
 * 
 * Also supports face comparison between selfie and ID card photos.
 */
const express = require('express');
const multer = require('multer');
const logger = require('../../../shared/logger');
const VisionVerificationService = require('../VisionVerificationService');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max
});

// POST /api/vision/analyze — Analyze a single document
router.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file', message: 'Upload a file in the "file" field' });
    }

    const docType = req.body.doc_type || 'DIPLOMA';
    const { buffer, mimetype } = req.file;

    logger.info('Vision AI analysis requested', { docType, size: buffer.length, mime: mimetype });

    const vision = new VisionVerificationService();

    if (docType === 'DIPLOMA') {
      const result = await vision.evaluateDiploma(buffer, mimetype);
      
      return res.json({
        doc_type: docType,
        is_authentic: result.is_authentic,
        score: result.score,
        consensus: result.consensus_reason,
        details: result.details,
      });
    }

    if (docType === 'CNOM_CARD') {
      const result = await vision.evaluateCnomCard(buffer, mimetype);
      
      return res.json({
        doc_type: docType,
        is_authentic: result.is_authentic,
        score: result.score,
        consensus: result.consensus_reason,
        details: result.details,
      });
    }

    // For SELFIE or CIN — just confirm it has a face using Gemini
    if (docType === 'SELFIE' || docType === 'CIN') {
      const result = await vision.detectFace(buffer, mimetype);
      return res.json({
        doc_type: docType,
        has_face: result.has_face,
        score: result.score,
        details: result.details,
      });
    }

    return res.status(400).json({ error: 'unsupported_doc_type', message: `Unsupported doc_type: ${docType}` });
  } catch (err) {
    logger.error('Vision AI analysis failed', { error: err.message });
    return res.status(500).json({ error: 'vision_error', message: err.message });
  }
});

// POST /api/vision/compare-faces — Compare selfie vs ID card face
router.post('/compare-faces', upload.fields([
  { name: 'selfie', maxCount: 1 },
  { name: 'id_card', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!req.files?.selfie?.[0] || !req.files?.id_card?.[0]) {
      return res.status(400).json({ 
        error: 'missing_files', 
        message: 'Upload both "selfie" and "id_card" files' 
      });
    }

    const selfie = req.files.selfie[0];
    const idCard = req.files.id_card[0];

    logger.info('Face comparison requested', { 
      selfieSize: selfie.size, 
      idSize: idCard.size 
    });

    const vision = new VisionVerificationService();
    const result = await vision.compareFacesWithAI(
      selfie.buffer, selfie.mimetype,
      idCard.buffer, idCard.mimetype
    );

    return res.json(result);
  } catch (err) {
    logger.error('Face comparison failed', { error: err.message });
    return res.status(500).json({ error: 'comparison_error', message: err.message });
  }
});

module.exports = router;
