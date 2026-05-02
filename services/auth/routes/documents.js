/**
 * Document upload, listing, and download routes.
 *
 * POST /v1/practitioner/documents        — Upload a document (multipart)
 * GET  /v1/practitioner/documents        — List practitioner's documents
 * GET  /v1/practitioner/documents/:id/download — Download decrypted document
 */
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const { publishDocumentJob } = require('../../../shared/queue/publisher');
const StorageService = require('../../../shared/storage/StorageService');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const logger = require('../../../shared/logger');
const { z } = require('zod');

const router = express.Router();
const storage = new StorageService();

// Multer: memory storage, 10MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Valid document types
const DOC_TYPES = ['CIN', 'DIPLOMA', 'CNOM_CARD', 'AGREMENT', 'SELFIE'];

const uploadBodySchema = z.object({
  doc_type: z.enum(DOC_TYPES, {
    errorMap: () => ({ message: `doc_type must be one of: ${DOC_TYPES.join(', ')}` }),
  }),
});

// ════════════════════════════════════════════════════════════════
// POST /documents — Upload a document
// ════════════════════════════════════════════════════════════════
router.post(
  '/documents',
  authenticate,
  upload.single('file'),
  async (req, res) => {
    try {
      // Validate doc_type
      const bodyResult = uploadBodySchema.safeParse(req.body);
      if (!bodyResult.success) {
        return res.status(400).json({
          error: 'validation_error',
          message: bodyResult.error.issues[0].message,
        });
      }
      const { doc_type } = bodyResult.data;
      const practitionerId = req.auth.sub;

      // Validate file exists
      if (!req.file) {
        return res.status(400).json({
          error: 'missing_file',
          message: 'A file must be uploaded in the "file" field',
        });
      }

      const { buffer, mimetype, size } = req.file;

      // Upload to MinIO (validates MIME type + size, encrypts with AES-256-CBC)
      let uploadResult;
      try {
        uploadResult = await storage.uploadDocument(practitionerId, doc_type, buffer, mimetype);
      } catch (err) {
        if (err.code === 'INVALID_FILE_TYPE' || err.code === 'FILE_TOO_LARGE') {
          return res.status(400).json({ error: err.code.toLowerCase(), message: err.message });
        }
        throw err;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Mark existing ACTIVE documents of same type as SUPERSEDED
        await client.query(
          `UPDATE documents SET status = 'SUPERSEDED'
           WHERE practitioner_id = $1 AND doc_type = $2 AND status NOT IN ('SUPERSEDED', 'REJECTED')`,
          [practitionerId, doc_type]
        );

        // Insert new document record
        const docId = uuidv4();
        await client.query(
          `INSERT INTO documents
           (id, practitioner_id, doc_type, storage_key, size_bytes, checksum_sha256, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'UPLOADED')`,
          [docId, practitionerId, doc_type, uploadResult.storage_key, uploadResult.size_bytes, uploadResult.checksum_sha256]
        );

        // Audit log in same transaction
        await writeAuditLog({
          actorId: practitionerId,
          actorType: 'practitioner',
          action: 'DOCUMENT_UPLOADED',
          targetId: docId,
          metadata: { doc_type, size_bytes: uploadResult.size_bytes, checksum: uploadResult.checksum_sha256 },
          ipAddress: req.ip,
          client,
        });

        await client.query('COMMIT');

        // Publish PROCESS_DOCUMENTS job (outside transaction, non-blocking)
        setImmediate(async () => {
          try {
            await publishDocumentJob({
              practitionerId,
              documentId: docId,
              docType: doc_type,
              storageKey: uploadResult.storage_key,
            });
          } catch (err) {
            logger.error('Failed to publish document processing job', { error: err.message, docId });
          }
        });

        logger.info('Document uploaded', { docId, practitionerId, doc_type });

        return res.status(201).json({
          document_id: docId,
          doc_type,
          status: 'UPLOADED',
          uploaded_at: new Date().toISOString(),
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error('Error uploading document', { error: err.message, stack: err.stack });
      return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
    }
  }
);

// ════════════════════════════════════════════════════════════════
// GET /documents — List practitioner's documents
// ════════════════════════════════════════════════════════════════
router.get('/documents', authenticate, async (req, res) => {
  try {
    const practitionerId = req.auth.sub;

    const result = await pool.query(
      `SELECT id AS document_id, doc_type, status, ocr_result,
              fraud_score, created_at AS uploaded_at
       FROM documents
       WHERE practitioner_id = $1
       ORDER BY created_at DESC`,
      [practitionerId]
    );

    // NEVER return storage_key to the client
    return res.json({ documents: result.rows });
  } catch (err) {
    logger.error('Error listing documents', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /documents/:document_id/download — Download decrypted document
// ════════════════════════════════════════════════════════════════
router.get('/documents/:document_id/download', authenticate, async (req, res) => {
  try {
    const practitionerId = req.auth.sub;
    const { document_id } = req.params;

    // Fetch document — scoped to authenticated practitioner only
    const result = await pool.query(
      'SELECT storage_key, doc_type FROM documents WHERE id = $1 AND practitioner_id = $2',
      [document_id, practitionerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found' });
    }

    const { storage_key } = result.rows[0];
    const { buffer, mimeType } = await storage.downloadDocument(storage_key);

    // Audit log
    await writeAuditLog({
      actorId: practitionerId,
      actorType: 'practitioner',
      action: 'DOCUMENT_DOWNLOADED',
      targetId: document_id,
      metadata: { doc_type: result.rows[0].doc_type },
      ipAddress: req.ip,
    });

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${document_id}"`);
    return res.send(buffer);
  } catch (err) {
    logger.error('Error downloading document', { error: err.message });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

module.exports = router;
