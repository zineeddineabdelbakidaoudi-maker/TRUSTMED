/**
 * StorageService — MinIO wrapper with AES-256-CBC encryption at rest.
 *
 * Every document is encrypted before storage and decrypted on retrieval.
 * Stored format: IV (16 bytes) || ciphertext.
 * Soft-delete: copies to deleted/ prefix before removing original.
 */
const crypto = require('crypto');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Minio = require('minio');
const logger = require('../logger');
const { writeAuditLog } = require('../db/audit');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

class StorageService {
  constructor() {
    this.client = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || 'localhost',
      port: parseInt(process.env.MINIO_PORT, 10) || 9000,
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'trustmed',
      secretKey: process.env.MINIO_SECRET_KEY || 'trustmed123',
    });
    this.bucket = process.env.MINIO_BUCKET || 'trustmed-documents';
    this.encryptionKey = process.env.AES_DOCUMENT_KEY
      ? Buffer.from(process.env.AES_DOCUMENT_KEY, 'hex')
      : crypto.randomBytes(32);
  }

  /**
   * Ensure the storage bucket exists, create if missing.
   */
  async ensureBucket() {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
      logger.info('Created MinIO bucket', { bucket: this.bucket });
    }
  }

  /**
   * Upload an encrypted document to MinIO.
   *
   * @param {string} practitionerId - UUID
   * @param {string} docType        - CIN|DIPLOMA|CNOM_CARD|AGREMENT|SELFIE
   * @param {Buffer} buffer         - Raw file buffer
   * @param {string} mimeType       - MIME type
   * @returns {{ storage_key: string, size_bytes: number, checksum_sha256: string }}
   */
  async uploadDocument(practitionerId, docType, buffer, mimeType) {
    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      const err = new Error(`Invalid file type: ${mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
      err.code = 'INVALID_FILE_TYPE';
      throw err;
    }

    // Validate file size
    if (buffer.length > MAX_FILE_SIZE) {
      const err = new Error(`File too large: ${buffer.length} bytes. Maximum: ${MAX_FILE_SIZE} bytes`);
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }

    // Compute checksum of original (pre-encryption)
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    // AES-256-CBC encrypt
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    const encrypted = Buffer.concat([iv, cipher.update(buffer), cipher.final()]);

    // Build storage key
    const ext = MIME_EXTENSIONS[mimeType] || 'bin';
    const fileId = uuidv4();
    const storageKey = `documents/${practitionerId}/${docType}/${fileId}.${ext}`;

    // Upload to MinIO
    await this.ensureBucket();
    await this.client.putObject(this.bucket, storageKey, encrypted, encrypted.length, {
      'Content-Type': 'application/octet-stream', // always encrypted bytes
      'x-amz-meta-original-mime': mimeType,
      'x-amz-meta-checksum-sha256': checksum,
      'x-amz-meta-practitioner-id': practitionerId,
      'x-amz-meta-doc-type': docType,
    });

    logger.info('Document uploaded to MinIO', {
      practitionerId,
      docType,
      storageKey,
      sizeBytes: buffer.length,
    });

    return {
      storage_key: storageKey,
      size_bytes: buffer.length,
      checksum_sha256: checksum,
    };
  }

  /**
   * Download and decrypt a document from MinIO.
   *
   * @param {string} storageKey - Object key in MinIO
   * @returns {{ buffer: Buffer, mimeType: string }}
   */
  async downloadDocument(storageKey) {
    const chunks = [];
    const stream = await this.client.getObject(this.bucket, storageKey);

    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const encrypted = Buffer.concat(chunks);

    // First 16 bytes are the IV, rest is ciphertext
    const iv = encrypted.subarray(0, 16);
    const ciphertext = encrypted.subarray(16);

    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Retrieve original MIME type from object metadata
    const stat = await this.client.statObject(this.bucket, storageKey);
    const mimeType = (stat.metaData && stat.metaData['original-mime']) || 'application/octet-stream';

    logger.info('Document downloaded from MinIO', { storageKey });

    return { buffer: decrypted, mimeType };
  }

  /**
   * Soft-delete a document: copy to deleted/ prefix, then remove original.
   * NEVER physically destroys without copying first.
   *
   * @param {string} storageKey - Object key to delete
   */
  async deleteDocument(storageKey) {
    const deletedKey = `deleted/${storageKey}`;

    // Copy to deleted/ prefix
    await this.ensureBucket();
    const copySource = `/${this.bucket}/${storageKey}`;
    await this.client.copyObject(this.bucket, deletedKey, copySource);

    // Remove original
    await this.client.removeObject(this.bucket, storageKey);

    // Audit log
    await writeAuditLog({
      actorType: 'system',
      action: 'DOCUMENT_SOFT_DELETED',
      metadata: { storageKey, deletedKey },
    });

    logger.info('Document soft-deleted', { storageKey, deletedKey });
  }
}

module.exports = StorageService;
