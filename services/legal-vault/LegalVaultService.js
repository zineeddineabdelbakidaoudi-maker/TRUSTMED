const pool = require('../../shared/db/pool');
const hmac = require('../../shared/crypto/hmac');
const logger = require('../../shared/logger');

/**
 * LegalVaultService — Manages append-only legal declaration records.
 *
 * Every record is HMAC-SHA256 signed with the platform secret.
 * The legal_declarations table has PostgreSQL triggers that physically
 * prevent any UPDATE or DELETE operations.
 */
class LegalVaultService {
  /**
   * Create a new legal declaration record.
   * Signs all fields with HMAC-SHA256 before insertion.
   *
   * @param {object} params
   * @param {string} params.practitionerId   - UUID
   * @param {string} params.declarationText  - Full legal text
   * @param {string} params.cinNumber        - CIN from NFC chip
   * @param {string|null} params.selfieVectorHash
   * @param {string|null} params.ipAddress
   * @param {object|null} params.deviceFingerprint
   * @param {object|null} params.geolocation
   * @param {object} [pgClient]              - Optional pg client for transactions
   * @returns {object} Created declaration record
   */
  async createDeclaration(params, pgClient) {
    const {
      practitionerId,
      declarationText,
      cinNumber,
      selfieVectorHash,
      ipAddress,
      deviceFingerprint,
      geolocation,
    } = params;

    const signedAt = new Date().toISOString();

    // Build the HMAC payload — concatenation of all fields
    const hmacPayload = [
      practitionerId,
      declarationText,
      cinNumber,
      selfieVectorHash || '',
      ipAddress || '',
      JSON.stringify(deviceFingerprint || {}),
      JSON.stringify(geolocation || {}),
      signedAt,
    ].join('|');

    const signature = hmac.sign(hmacPayload);

    const query = `
      INSERT INTO legal_declarations
        (practitioner_id, declaration_text, cin_number, selfie_vector_hash,
         ip_address, device_fingerprint, geolocation, hmac_signature, signed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, practitioner_id, hmac_signature, signed_at
    `;

    const values = [
      practitionerId,
      declarationText,
      cinNumber,
      selfieVectorHash || null,
      ipAddress || null,
      deviceFingerprint ? JSON.stringify(deviceFingerprint) : null,
      geolocation ? JSON.stringify(geolocation) : null,
      signature,
      signedAt,
    ];

    const db = pgClient || pool;
    const result = await db.query(query, values);
    const record = result.rows[0];

    logger.info('Legal declaration created', {
      declarationId: record.id,
      practitionerId: record.practitioner_id,
      signedAt: record.signed_at,
    });

    return record;
  }

  /**
   * Verify the HMAC signature of an existing legal declaration.
   *
   * @param {string} declarationId - UUID of the declaration
   * @returns {object} { valid: boolean, declaration: object }
   */
  async verifyDeclaration(declarationId) {
    const result = await pool.query(
      `SELECT * FROM legal_declarations WHERE id = $1`,
      [declarationId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Declaration not found: ${declarationId}`);
    }

    const decl = result.rows[0];

    const hmacPayload = [
      decl.practitioner_id,
      decl.declaration_text,
      decl.cin_number,
      decl.selfie_vector_hash || '',
      decl.ip_address || '',
      JSON.stringify(decl.device_fingerprint || {}),
      JSON.stringify(decl.geolocation || {}),
      decl.signed_at.toISOString(),
    ].join('|');

    const valid = hmac.verify(hmacPayload, decl.hmac_signature);

    logger.info('Legal declaration verification', {
      declarationId,
      valid,
    });

    return { valid, declaration: decl };
  }
}

module.exports = LegalVaultService;
