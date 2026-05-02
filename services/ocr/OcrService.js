/**
 * OcrService — Azure Document Intelligence wrapper with Tesseract.js fallback.
 *
 * Analyzes uploaded documents using Azure's prebuilt models,
 * extracts structured fields per document type, and provides
 * a Tesseract.js fallback for when Azure is unavailable.
 */
const axios = require('axios');
const logger = require('../../shared/logger');

const AZURE_ENDPOINT = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '';
const AZURE_KEY = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || '';
const MAX_POLLS = 30;
const POLL_DELAY_MS = 2000;

// Model mapping by document type
const MODEL_MAP = {
  CIN: 'prebuilt-idDocument',
  PASSPORT: 'prebuilt-idDocument',
  CNOM_CARD: 'prebuilt-idDocument',
  DIPLOMA: 'prebuilt-document',
  AGREMENT: 'prebuilt-document',
};

class OcrService {
  /**
   * Analyze a document using Azure Document Intelligence.
   *
   * @param {Buffer} buffer   - Decrypted document buffer
   * @param {string} mimeType - MIME type
   * @param {string} docType  - CIN|DIPLOMA|CNOM_CARD|AGREMENT|SELFIE
   * @returns {object} { extracted_fields, confidence_scores, raw_azure_response }
   */
  async analyzeDocument(buffer, mimeType, docType) {
    // Selfies don't go through OCR
    if (docType === 'SELFIE') {
      return {
        extracted_fields: {},
        confidence_scores: {},
        raw_azure_response: null,
        type: 'SELFIE',
        note: 'liveness_check_required',
      };
    }

    if (!AZURE_ENDPOINT || !AZURE_KEY) {
      logger.warn('Azure credentials not configured, using fallback OCR');
      return this.fallbackOcr(buffer, mimeType);
    }

    const model = MODEL_MAP[docType] || 'prebuilt-document';

    try {
      // POST to Azure: start analysis
      const analyzeUrl = `${AZURE_ENDPOINT}/documentintelligence/documentModels/${model}:analyze?api-version=2024-02-29-preview`;

      const startResponse = await axios.post(analyzeUrl, buffer, {
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_KEY,
          'Content-Type': mimeType,
        },
        maxContentLength: 20 * 1024 * 1024,
        timeout: 30000,
      });

      // Get the operation location for polling
      const operationLocation = startResponse.headers['operation-location'];
      if (!operationLocation) {
        throw new Error('Azure did not return operation-location header');
      }

      // Poll for results
      let result = null;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_DELAY_MS));

        const pollResponse = await axios.get(operationLocation, {
          headers: { 'Ocp-Apim-Subscription-Key': AZURE_KEY },
          timeout: 10000,
        });

        if (pollResponse.data.status === 'succeeded') {
          result = pollResponse.data;
          break;
        }
        if (pollResponse.data.status === 'failed') {
          throw new Error(`Azure analysis failed: ${JSON.stringify(pollResponse.data.error)}`);
        }
        // still running — continue polling
      }

      if (!result) {
        throw new Error('Azure analysis timed out after max polls');
      }

      // Extract structured fields based on document type
      const extracted = this._extractFields(result, docType);

      logger.info('Azure OCR analysis complete', { docType, fieldsFound: Object.keys(extracted.extracted_fields).length });

      return extracted;
    } catch (err) {
      logger.error('Azure OCR failed, falling back to Tesseract', {
        error: err.message,
        docType,
      });
      return this.fallbackOcr(buffer, mimeType);
    }
  }

  /**
   * Fallback OCR using Tesseract.js.
   *
   * @param {Buffer} buffer   - Document buffer
   * @param {string} mimeType - MIME type
   * @returns {object}
   */
  async fallbackOcr(buffer, mimeType) {
    try {
      const Tesseract = require('tesseract.js');
      const { data } = await Tesseract.recognize(buffer, 'fra+ara+eng', {
        logger: () => {}, // suppress tesseract logs
      });

      logger.info('Tesseract fallback OCR complete', { confidence: data.confidence });

      return {
        extracted_fields: { raw_text: data.text },
        confidence_scores: { overall: data.confidence / 100 },
        raw_azure_response: null,
        source: 'TESSERACT_FALLBACK',
        confidence: 'LOW',
      };
    } catch (err) {
      logger.error('Tesseract fallback also failed', { error: err.message });
      return {
        extracted_fields: {},
        confidence_scores: {},
        raw_azure_response: null,
        source: 'NONE',
        confidence: 'FAILED',
        error: err.message,
      };
    }
  }

  /**
   * Extract structured fields from Azure response based on document type.
   * @private
   */
  _extractFields(azureResult, docType) {
    const analyzeResult = azureResult.analyzeResult || {};
    const documents = analyzeResult.documents || [];
    const fields = documents.length > 0 ? documents[0].fields || {} : {};

    const extracted = {};
    const confidence = {};

    switch (docType) {
      case 'CIN':
        extracted.full_name = this._getFieldValue(fields, ['FirstName', 'LastName'], 'concat');
        extracted.date_of_birth = this._getFieldValue(fields, ['DateOfBirth']);
        extracted.id_number = this._getFieldValue(fields, ['DocumentNumber']);
        extracted.expiry_date = this._getFieldValue(fields, ['DateOfExpiration']);
        extracted.nationality = this._getFieldValue(fields, ['CountryRegion']);
        confidence.full_name = this._getFieldConfidence(fields, ['FirstName', 'LastName']);
        confidence.id_number = this._getFieldConfidence(fields, ['DocumentNumber']);
        confidence.expiry_date = this._getFieldConfidence(fields, ['DateOfExpiration']);
        break;

      case 'PASSPORT':
        extracted.full_name = this._getFieldValue(fields, ['FirstName', 'LastName'], 'concat');
        extracted.date_of_birth = this._getFieldValue(fields, ['DateOfBirth']);
        extracted.passport_number = this._getFieldValue(fields, ['DocumentNumber']);
        extracted.expiry_date = this._getFieldValue(fields, ['DateOfExpiration']);
        extracted.nationality = this._getFieldValue(fields, ['CountryRegion']);
        
        const mrz = fields['MachineReadableZone'];
        if (mrz && mrz.valueObject) {
          extracted.mrz_line1 = mrz.valueObject.Line1 ? mrz.valueObject.Line1.valueString : null;
          extracted.mrz_line2 = mrz.valueObject.Line2 ? mrz.valueObject.Line2.valueString : null;
        } else if (mrz && mrz.content) {
          const mrzLines = mrz.content.split('\n').map(l => l.trim()).filter(l => l);
          if (mrzLines.length >= 2) {
            extracted.mrz_line1 = mrzLines[0];
            extracted.mrz_line2 = mrzLines[1];
          }
        }
        
        confidence.full_name = this._getFieldConfidence(fields, ['FirstName', 'LastName']);
        confidence.passport_number = this._getFieldConfidence(fields, ['DocumentNumber']);
        break;

      case 'DIPLOMA':
        extracted.institution_name = this._searchContent(analyzeResult, /universit[éeè]\s+[\w\s]+/i);
        extracted.graduate_name = this._searchContent(analyzeResult, /(?:Monsieur|Madame|Mr|Mme)\s+([\w\s]+)/i);
        extracted.degree_title = this._searchContent(analyzeResult, /(?:diplôme|licence|doctorat|master)\s+[\w\s]+/i);
        extracted.graduation_year = this._searchContent(analyzeResult, /\b(19|20)\d{2}\b/);
        extracted.field_of_study = this._searchContent(analyzeResult, /(?:spécialité|filière|option)\s*:?\s*([\w\s]+)/i);
        confidence.overall = 0.65; // general models have lower confidence
        break;

      case 'CNOM_CARD':
        extracted.cnom_number = this._searchContent(analyzeResult, /\d{2}-\d{2}-\d{4}/);
        extracted.full_name = this._getFieldValue(fields, ['FirstName', 'LastName'], 'concat');
        extracted.specialty = this._searchContent(analyzeResult, /(?:spécialité|specialite)\s*:?\s*([\w\s]+)/i);
        extracted.issue_date = this._getFieldValue(fields, ['DateOfIssue']);
        extracted.expiry_date = this._getFieldValue(fields, ['DateOfExpiration']);
        confidence.cnom_number = extracted.cnom_number ? 0.85 : 0;
        confidence.full_name = this._getFieldConfidence(fields, ['FirstName', 'LastName']);
        break;

      case 'AGREMENT':
        extracted.agrement_number = this._searchContent(analyzeResult, /(?:agrément|agrement)\s*(?:n[°o]?)?\s*:?\s*([\w\/-]+)/i);
        extracted.establishment_name = this._searchContent(analyzeResult, /(?:cabinet|clinique|établissement)\s*:?\s*([\w\s]+)/i);
        extracted.wilaya_code = this._searchContent(analyzeResult, /(?:wilaya|code)\s*:?\s*(\d{2})/i);
        extracted.issue_date = this._searchContent(analyzeResult, /\b\d{2}[\/\-]\d{2}[\/\-](19|20)\d{2}\b/);
        confidence.overall = 0.60;
        break;

      default:
        // Generic extraction — return raw content
        extracted.raw_text = (analyzeResult.content || '').substring(0, 5000);
        confidence.overall = 0.50;
    }

    return {
      extracted_fields: extracted,
      confidence_scores: confidence,
      raw_azure_response: azureResult,
    };
  }

  /** @private Get a field value from Azure document fields */
  _getFieldValue(fields, keys, mode) {
    if (mode === 'concat') {
      return keys
        .map((k) => (fields[k] && fields[k].valueString) || '')
        .filter(Boolean)
        .join(' ')
        .trim() || null;
    }
    for (const key of keys) {
      if (fields[key]) {
        return fields[key].valueString || fields[key].valueDate || fields[key].content || null;
      }
    }
    return null;
  }

  /** @private Get minimum confidence across fields */
  _getFieldConfidence(fields, keys) {
    const confidences = keys
      .map((k) => fields[k] && fields[k].confidence)
      .filter((c) => c != null);
    return confidences.length > 0 ? Math.min(...confidences) : 0;
  }

  /** @private Search through raw content for a regex pattern */
  _searchContent(analyzeResult, pattern) {
    const content = analyzeResult.content || '';
    const match = content.match(pattern);
    if (match) return match[1] || match[0];
    return null;
  }
}

module.exports = OcrService;
