/**
 * FraudDetector — 8-check fraud analysis for extracted document fields.
 *
 * Scoring: start at 100, subtract penalties for each failed check.
 * Recommendation: AUTO_APPROVE (>=70, no HIGH), HUMAN_REVIEW (30-69 or MEDIUM), FREEZE (<30 or HIGH).
 */
const { distance } = require('fastest-levenshtein');
const logger = require('../../shared/logger');

// Known generic/placeholder serial numbers used in template forgeries
const SUSPICIOUS_SERIALS = [
  '1234567', '0000000', '9999999', '1111111', '7654321',
  '0123456', '1234', '12345', '123456', '12345678',
  '00000', '99999', '11111',
];

// Editing software signatures found in image binary headers
const MANIPULATION_SIGNATURES = [
  'Adobe Photoshop',
  'GIMP',
  'Pixelmator',
  'Affinity Photo',
  'CorelDRAW',
  'Paint.NET',
  'Canva',
  'photoshop',
  'www.inkscape.org',
];

class FraudDetector {
  /**
   * Run all 8 fraud checks on extracted document fields.
   *
   * @param {object} extractedFields     - Fields from OcrService
   * @param {string} docType             - CIN|DIPLOMA|CNOM_CARD|AGREMENT
   * @param {object} practitionerProfile - Row from practitioners table
   * @param {Buffer|null} imageBuffer    - Raw image buffer for metadata analysis
   * @returns {{ fraud_score: number, flags: Array, recommendation: string }}
   */
  detectFraud(extractedFields, docType, practitionerProfile, imageBuffer = null) {
    const flags = [];
    let score = 100;

    // CHECK 1 — Name Match
    const nameResult = this._checkNameMatch(extractedFields, practitionerProfile);
    if (nameResult) {
      flags.push(nameResult);
      score -= nameResult.score_penalty;
    }

    // CHECK 2 — Date Logic
    const dateResult = this._checkDateLogic(extractedFields, docType);
    if (dateResult) {
      flags.push(dateResult);
      score -= dateResult.score_penalty;
    }

    // CHECK 3 — CNOM Number Format
    const cnomResult = this._checkCnomFormat(extractedFields, docType);
    if (cnomResult) {
      flags.push(cnomResult);
      score -= cnomResult.score_penalty;
    }

    // CHECK 4 — Azure Confidence
    const confidenceResult = this._checkConfidence(extractedFields);
    if (confidenceResult) {
      flags.push(confidenceResult);
      score -= confidenceResult.score_penalty;
    }

    // CHECK 5 — Cross-Document Consistency
    const crossResult = this._checkCrossDocument(extractedFields, docType, practitionerProfile);
    if (crossResult) {
      flags.push(crossResult);
      score -= crossResult.score_penalty;
    }

    // CHECK 6 — MRZ Validation
    const mrzResult = this._checkMrzValidation(extractedFields, docType);
    if (mrzResult) {
      flags.push(mrzResult);
      score -= mrzResult.score_penalty;
    }

    // CHECK 7 — Image Metadata / Manipulation Tool Detection
    if (imageBuffer) {
      const metaResult = this._checkMetadata(imageBuffer);
      if (metaResult) {
        flags.push(metaResult);
        score -= metaResult.score_penalty;
      }
    }

    // CHECK 8 — Suspicious Patterns (generic serial numbers, placeholder data)
    const patternResult = this._checkSuspiciousPatterns(extractedFields, docType);
    if (patternResult) {
      flags.push(patternResult);
      score -= patternResult.score_penalty;
    }

    // Clamp score to 0-100
    score = Math.max(0, Math.min(100, score));

    // Determine recommendation
    const hasHighSeverity = flags.some((f) => f.severity === 'HIGH');
    const hasMediumSeverity = flags.some((f) => f.severity === 'MEDIUM');
    let recommendation;

    if (score < 30 || hasHighSeverity) {
      recommendation = 'FREEZE';
    } else if (score < 70 || hasMediumSeverity) {
      recommendation = 'HUMAN_REVIEW';
    } else {
      recommendation = 'AUTO_APPROVE';
    }

    logger.info('Fraud detection complete', {
      docType,
      score,
      flagCount: flags.length,
      recommendation,
      practitionerId: practitionerProfile.id,
    });

    return { fraud_score: score, flags, recommendation };
  }

  /**
   * CHECK 1 — Name Match (Levenshtein similarity >= 0.75)
   * @private
   */
  _checkNameMatch(fields, profile) {
    const extractedName = (fields.full_name || fields.graduate_name || '').toLowerCase().trim();
    const profileName = (profile.full_name || '').toLowerCase().trim();

    if (!extractedName || !profileName) return null;

    const similarity = this._computeSimilarity(extractedName, profileName);

    if (similarity < 0.75) {
      return {
        check: 'NAME_MISMATCH',
        severity: 'HIGH',
        score_penalty: 40,
        details: {
          extracted_name: extractedName,
          profile_name: profileName,
          similarity: parseFloat(similarity.toFixed(3)),
        },
      };
    }
    return null;
  }

  /**
   * CHECK 2 — Date Logic (valid ranges and not expired)
   * @private
   */
  _checkDateLogic(fields, docType) {
    const currentYear = new Date().getFullYear();
    const now = new Date();

    // Check graduation year
    if (fields.graduation_year) {
      const year = parseInt(fields.graduation_year, 10);
      if (isNaN(year) || year < 1960 || year > currentYear) {
        return {
          check: 'DATE_INVALID',
          severity: 'MEDIUM',
          score_penalty: 20,
          details: { field: 'graduation_year', value: fields.graduation_year, reason: 'out_of_range' },
        };
      }
    }

    // Check expiry dates (CIN/CNOM_CARD) — must be in the future
    if ((docType === 'CIN' || docType === 'CNOM_CARD') && fields.expiry_date) {
      const expiry = new Date(fields.expiry_date);
      if (!isNaN(expiry.getTime()) && expiry < now) {
        return {
          check: 'DATE_INVALID',
          severity: 'MEDIUM',
          score_penalty: 20,
          details: { field: 'expiry_date', value: fields.expiry_date, reason: 'expired' },
        };
      }
    }

    return null;
  }

  /**
   * CHECK 3 — CNOM Number Format: /^\d{2}-\d{2}-\d{4}$/ with wilaya 01-58
   * @private
   */
  _checkCnomFormat(fields, docType) {
    if (docType !== 'CNOM_CARD' && docType !== 'CIN') return null;

    const cnom = fields.cnom_number;
    if (!cnom) return null;

    const pattern = /^\d{2}-\d{2}-\d{4}$/;
    if (!pattern.test(cnom)) {
      return {
        check: 'CNOM_FORMAT_INVALID',
        severity: 'HIGH',
        score_penalty: 35,
        details: { cnom_number: cnom, reason: 'format_mismatch' },
      };
    }

    const wilaya = parseInt(cnom.split('-')[0], 10);
    if (wilaya < 1 || wilaya > 58) {
      return {
        check: 'CNOM_FORMAT_INVALID',
        severity: 'HIGH',
        score_penalty: 35,
        details: { cnom_number: cnom, wilaya, reason: 'invalid_wilaya_code' },
      };
    }

    return null;
  }

  /**
   * CHECK 4 — Azure confidence check (any key field < 0.60)
   * @private
   */
  _checkConfidence(fields) {
    // confidence_scores may be on the parent object passed from OcrService
    const scores = fields.confidence_scores || fields;

    for (const [key, val] of Object.entries(scores)) {
      if (typeof val === 'number' && val < 0.60 && key !== 'overall') {
        return {
          check: 'LOW_CONFIDENCE',
          severity: 'MEDIUM',
          score_penalty: 15,
          details: { field: key, confidence: val },
        };
      }
    }
    return null;
  }

  /**
   * CHECK 5 — Cross-document consistency
   * @private
   */
  _checkCrossDocument(fields, docType, profile) {
    // Wilaya check on AGREMENT
    if (docType === 'AGREMENT' && fields.wilaya_code && profile.wilaya_code) {
      const docWilaya = parseInt(fields.wilaya_code, 10);
      if (docWilaya !== profile.wilaya_code) {
        return {
          check: 'CROSS_DOC_MISMATCH',
          severity: 'HIGH',
          score_penalty: 30,
          details: {
            field: 'wilaya_code',
            document_value: docWilaya,
            profile_value: profile.wilaya_code,
          },
        };
      }
    }

    // Cross-name check: CIN name vs profile name
    if ((docType === 'CIN' || docType === 'DIPLOMA') && fields.full_name) {
      const docName = (fields.full_name || fields.graduate_name || '').toLowerCase().trim();
      const profileName = (profile.full_name || '').toLowerCase().trim();

      if (docName && profileName) {
        const similarity = this._computeSimilarity(docName, profileName);
        if (similarity < 0.75) {
          return {
            check: 'CROSS_DOC_MISMATCH',
            severity: 'HIGH',
            score_penalty: 30,
            details: {
              field: 'full_name',
              document_name: docName,
              profile_name: profileName,
              similarity: parseFloat(similarity.toFixed(3)),
            },
          };
        }
      }
    }

    return null;
  }

  /**
   * CHECK 6 — MRZ Validation (for PASSPORT)
   * @private
   */
  _checkMrzValidation(fields, docType) {
    if (docType !== 'PASSPORT' || !fields.mrz_line1 || !fields.mrz_line2) return null;

    const line2 = fields.mrz_line2.replace(/\s+/g, '');
    if (line2.length !== 44) {
      return null; // Skip if it's not a standard 44-char TD3 MRZ
    }

    const getCharValue = (c) => {
      if (c >= '0' && c <= '9') return parseInt(c, 10);
      if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
      if (c === '<') return 0;
      return 0;
    };
    
    const computeCheckDigit = (str) => {
      const weights = [7, 3, 1];
      let sum = 0;
      for (let i = 0; i < str.length; i++) {
        sum += getCharValue(str[i]) * weights[i % 3];
      }
      return sum % 10;
    };

    let fails = [];

    const pNum = line2.substring(0, 9);
    const pCheck = line2[9];
    if (computeCheckDigit(pNum).toString() !== pCheck && pCheck !== '<') fails.push('passport_number');

    const dob = line2.substring(13, 19);
    const dobCheck = line2[19];
    if (computeCheckDigit(dob).toString() !== dobCheck && dobCheck !== '<') fails.push('dob');

    const exp = line2.substring(21, 27);
    const expCheck = line2[27];
    if (computeCheckDigit(exp).toString() !== expCheck && expCheck !== '<') fails.push('expiry');

    if (fails.length > 0) {
      return {
        check: 'MRZ_CHECKSUM_INVALID',
        severity: 'HIGH',
        score_penalty: 40,
        details: { failed_fields: fails, mrz_line2: line2 }
      };
    }

    return null;
  }

  /**
   * CHECK 7 — Image Metadata / Manipulation Tool Detection.
   * Scans the raw binary of an image for editing software signatures
   * embedded in EXIF, XMP, or IPTC metadata blocks.
   * @private
   */
  _checkMetadata(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) return null;

    try {
      // Scan a reasonable portion of the file header (first 64KB covers EXIF/XMP)
      const scanLength = Math.min(buffer.length, 65536);
      const headerStr = buffer.toString('binary', 0, scanLength);

      const detectedTools = [];

      for (const sig of MANIPULATION_SIGNATURES) {
        if (headerStr.toLowerCase().includes(sig.toLowerCase())) {
          detectedTools.push(sig);
        }
      }

      if (detectedTools.length > 0) {
        logger.warn('Manipulation tool detected in image metadata', { tools: detectedTools });
        return {
          check: 'MANIPULATION_TOOL_DETECTED',
          severity: 'HIGH',
          score_penalty: 50,
          details: {
            detected_tools: detectedTools,
            reason: 'Image was edited with professional manipulation software',
          },
        };
      }

      // Secondary check: look for suspiciously stripped metadata
      const hasExif = headerStr.includes('Exif');
      const hasJfif = headerStr.includes('JFIF');
      const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;

      if (isJpeg && !hasExif && !hasJfif) {
        return {
          check: 'METADATA_STRIPPED',
          severity: 'MEDIUM',
          score_penalty: 15,
          details: {
            reason: 'JPEG has no EXIF or JFIF metadata — possibly stripped to hide editing history',
          },
        };
      }
    } catch (err) {
      logger.warn('Metadata check failed (non-blocking)', { error: err.message });
    }

    return null;
  }

  /**
   * CHECK 8 — Suspicious Patterns in extracted fields.
   * Flags generic serial numbers, placeholder names, and impossible data combinations.
   * @private
   */
  _checkSuspiciousPatterns(fields, docType) {
    const suspiciousFindings = [];

    // 8a: Check all numeric fields against known placeholder serials
    const numericFields = ['id_number', 'passport_number', 'cnom_number', 'agrement_number'];
    const rawText = fields.raw_text || '';

    for (const field of numericFields) {
      if (fields[field]) {
        const cleanVal = fields[field].replace(/[-\/\s]/g, '');
        for (const sus of SUSPICIOUS_SERIALS) {
          if (cleanVal.includes(sus)) {
            suspiciousFindings.push({ field, value: fields[field], matched_pattern: sus });
          }
        }
      }
    }

    // 8b: Scan raw_text for serial number patterns (catches OCR'd serial numbers like "No.1234567")
    const serialMatch = rawText.match(/(?:No\.?|N°|number|numéro)\s*[:\.]?\s*(\d{4,8})/i);
    if (serialMatch) {
      const serial = serialMatch[1];
      for (const sus of SUSPICIOUS_SERIALS) {
        if (serial === sus) {
          suspiciousFindings.push({ field: 'document_serial', value: serial, matched_pattern: sus });
        }
      }
    }

    // 8c: Flag sequential/round/repeated serial numbers
    if (rawText) {
      const allSerials = [...rawText.matchAll(/(?:No\.?|N°)\s*[:\.]?\s*(\d{5,8})/gi)];
      if (allSerials.length > 0) {
        const serialVal = allSerials[0][1];
        if (/^(\d)\1+$/.test(serialVal) || /^0*1234/.test(serialVal)) {
          suspiciousFindings.push({ field: 'serial_pattern', value: serialVal, matched_pattern: 'sequential_or_repeated' });
        }
      }
    }

    // 8d: Check for placeholder names
    const name = (fields.full_name || fields.graduate_name || '').toLowerCase();
    const placeholderNames = ['john doe', 'jane doe', 'test', 'sample', 'placeholder', 'xxxx', 'nom prenom', 'nom et prenom'];
    for (const placeholder of placeholderNames) {
      if (name.includes(placeholder)) {
        suspiciousFindings.push({ field: 'name', value: name, matched_pattern: placeholder });
      }
    }

    if (suspiciousFindings.length > 0) {
      return {
        check: 'SUSPICIOUS_PATTERN',
        severity: 'HIGH',
        score_penalty: 35,
        details: {
          findings: suspiciousFindings,
          reason: 'Document contains generic/placeholder data commonly found in template forgeries',
        },
      };
    }

    return null;
  }

  /**
   * Compute Levenshtein-based similarity (0.0 to 1.0).
   * @private
   */
  _computeSimilarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    return 1.0 - distance(a, b) / maxLen;
  }

  /**
   * Compute practitioner-level risk signals from multiple anomaly checks.
   * Risk Score is SEPARATE from Trust Score. Higher = more suspicious.
   *
   * @param {string} practitionerId - UUID
   * @param {object} db             - pg pool instance
   * @returns {{ risk_score: number, risk_flags: Array, risk_level: string }}
   */
  static async computeRiskSignals(practitionerId, db) {
    const riskFlags = [];

    try {
      // SIGNAL 1 — Same IP as another practitioner & Fingerprint Abuse
      const latestAuditResult = await db.query(
        `SELECT metadata->>'ip_address' as ip_address, metadata->>'fingerprint_hash' as fingerprint_hash
         FROM audit_log
         WHERE target_id = $1 OR actor_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [practitionerId]
      );
      
      if (latestAuditResult.rows.length > 0) {
        const latest = latestAuditResult.rows[0];
        if (latest.ip_address) {
          const sharedIpResult = await db.query(
            `SELECT COUNT(DISTINCT target_id) AS cnt FROM audit_log
             WHERE metadata->>'ip_address' = $1 AND target_id != $2 AND action = 'DOCUMENT_PROCESSED'`,
            [latest.ip_address, practitionerId]
          );
          if (parseInt(sharedIpResult.rows[0].cnt, 10) > 0) {
            riskFlags.push({ signal: 'SHARED_IP', severity: 'HIGH', risk_points: 30 });
          }
        }
        
        if (latest.fingerprint_hash) {
          const DeviceFingerprintService = require('../../risk/DeviceFingerprintService');
          const fpResult = await DeviceFingerprintService.checkFingerprintAbuse(latest.fingerprint_hash, practitionerId, db);
          if (fpResult.risk_flag) {
            riskFlags.push(fpResult.risk_flag);
          }
        }
      }

      // SIGNAL 2 — Submission velocity (all docs within 60 seconds)
      const velocityResult = await db.query(
        `SELECT MIN(created_at) AS first_doc, MAX(created_at) AS last_doc, COUNT(*) AS doc_count
         FROM documents WHERE practitioner_id = $1`,
        [practitionerId]
      );
      if (velocityResult.rows.length > 0) {
        const row = velocityResult.rows[0];
        const docCount = parseInt(row.doc_count, 10);
        if (docCount >= 3 && row.first_doc && row.last_doc) {
          const diffMs = new Date(row.last_doc) - new Date(row.first_doc);
          if (diffMs < 60000) {
            riskFlags.push({ signal: 'HIGH_VELOCITY_UPLOAD', severity: 'MEDIUM', risk_points: 20 });
          }
        }
      }

      // SIGNAL 3 — OCR low confidence on ANY document
      const lowConfResult = await db.query(
        `SELECT COUNT(*) AS cnt FROM documents
         WHERE practitioner_id = $1 AND fraud_score IS NOT NULL AND fraud_score < 70`,
        [practitionerId]
      );
      if (parseInt(lowConfResult.rows[0].cnt, 10) > 0) {
        riskFlags.push({ signal: 'LOW_OCR_CONFIDENCE', severity: 'MEDIUM', risk_points: 15 });
      }

      // SIGNAL 4 — CNOM wilaya vs phone prefix mismatch
      // Algerian mobile numbers (05x, 06x, 07x) are NOT wilaya-specific — SKIPPED
      riskFlags.push({ signal: 'PHONE_WILAYA_CHECK', severity: 'SKIPPED', risk_points: 0, note: 'Algerian mobiles are not wilaya-specific' });

      // SIGNAL 5 — Multiple failed OTP attempts
      const otpResult = await db.query(
        `SELECT MAX(attempt_count) AS max_attempts FROM phone_verifications
         WHERE practitioner_id = $1`,
        [practitionerId]
      );
      if (otpResult.rows.length > 0 && otpResult.rows[0].max_attempts !== null) {
        const maxAttempts = parseInt(otpResult.rows[0].max_attempts, 10);
        if (maxAttempts >= 2) {
          riskFlags.push({ signal: 'OTP_MULTIPLE_ATTEMPTS', severity: 'LOW', risk_points: 10 });
        }
      }

      // SIGNAL 6 — Documents uploaded before registration cooldown (< 5 min)
      const cooldownResult = await db.query(
        `SELECT p.created_at AS registered_at, MIN(d.created_at) AS first_doc_at
         FROM practitioners p
         LEFT JOIN documents d ON d.practitioner_id = p.id
         WHERE p.id = $1
         GROUP BY p.created_at`,
        [practitionerId]
      );
      if (cooldownResult.rows.length > 0 && cooldownResult.rows[0].first_doc_at) {
        const regAt = new Date(cooldownResult.rows[0].registered_at);
        const firstDoc = new Date(cooldownResult.rows[0].first_doc_at);
        const diffMs = firstDoc - regAt;
        if (diffMs < 5 * 60 * 1000) {
          riskFlags.push({ signal: 'INSTANT_DOCUMENT_UPLOAD', severity: 'MEDIUM', risk_points: 15 });
        }
      }
    } catch (err) {
      logger.error('Error computing risk signals', { error: err.message, practitionerId });
    }

    // Scoring
    const activeFlags = riskFlags.filter(f => f.severity !== 'SKIPPED');
    const riskScore = Math.min(100, activeFlags.reduce((sum, f) => sum + f.risk_points, 0));

    let riskLevel;
    if (riskScore >= 60) {
      riskLevel = 'HIGH';
    } else if (riskScore >= 30) {
      riskLevel = 'MEDIUM';
    } else {
      riskLevel = 'LOW';
    }

    return {
      risk_score: riskScore,
      risk_flags: riskFlags,
      risk_level: riskLevel,
    };
  }
}

module.exports = FraudDetector;

