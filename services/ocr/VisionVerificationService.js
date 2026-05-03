const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../../shared/logger');

/**
 * Multi-Model Vision Verification Service
 * ─────────────────────────────────────────
 * Cross-references a medical diploma image across up to 3 AI vision models:
 *   1. Groq  (Llama-4-Scout 17B — Vision)
 *   2. Gemini (Gemini 1.5 Pro — Vision)
 *   3. OpenAI (GPT-4o — Vision)
 *
 * Uses a consensus mechanism (majority vote) for final determination.
 *
 * FEW-SHOT TRAINING:
 *   Place example images in ./training_samples/:
 *     real/   → verified authentic medical diplomas
 *     fake/   → known forgeries / template diplomas
 *   The service will automatically load them and inject them into each prompt.
 */

// ─── Training Samples Directory ──────────────────────────────
const TRAINING_DIR = path.join(__dirname, '..', '..', 'training_samples');

class VisionVerificationService {
  constructor() {
    this.groqKey = process.env.GROQ_API_KEY;
    this.geminiKey = process.env.GEMINI_API_KEY;
    this.openAiKey = process.env.OPENAI_API_KEY;

    // Pre-load training samples at construction time
    this._trainingExamples = this._loadTrainingSamples();
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC: Evaluate a diploma image across all configured models
  // ═══════════════════════════════════════════════════════════

  /**
   * @param {Buffer} buffer
   * @param {string} mimeType
   * @returns {Promise<{ is_authentic: boolean, score: number, consensus_reason: string, details: object }>}
   */
  async evaluateDiploma(buffer, mimeType) {
    const base64Image = buffer.toString('base64');

    // Fire all configured API requests concurrently
    const promises = [
      this._callGroq(base64Image, mimeType),
      this._callGemini(base64Image, mimeType),
      this._callOpenAI(base64Image, mimeType),
    ];

    const results = await Promise.allSettled(promises);

    let authenticCount = 0;
    let fakeCount = 0;
    const modelDetails = {};

    results.forEach((res, index) => {
      const modelName = ['Groq_Llama4Scout', 'Gemini', 'OpenAI_GPT4o'][index];
      if (res.status === 'fulfilled' && res.value) {
        modelDetails[modelName] = res.value;
        if (res.value.is_authentic) {
          authenticCount++;
        } else {
          fakeCount++;
        }
      } else {
        const errMsg = res.reason ? res.reason.message : 'No API key or call failed';
        modelDetails[modelName] = { error: errMsg };
        logger.warn(`Vision model ${modelName} unavailable`, { error: errMsg });
      }
    });

    const totalVotes = authenticCount + fakeCount;

    if (totalVotes === 0) {
      throw new Error('All Vision AI models failed to respond.');
    }

    // Consensus scoring
    let score;
    if (totalVotes === 1) {
      // Only 1 model responded — use its verdict but with lower confidence
      score = authenticCount === 1 ? 70 : 30;
    } else if (authenticCount === fakeCount) {
      // Tie — conservative approach: flag for human review
      score = 50;
    } else if (authenticCount > fakeCount) {
      // Majority says real
      score = fakeCount === 0 ? 100 : 75;
    } else {
      // Majority says fake
      score = authenticCount === 0 ? 0 : 25;
    }

    const result = {
      is_authentic: score >= 70,
      score,
      consensus_reason: `${totalVotes} model(s) voted: ${authenticCount} Authentic vs ${fakeCount} Fake`,
      details: modelDetails,
    };

    logger.info('Vision AI consensus reached', {
      score,
      authentic: authenticCount,
      fake: fakeCount,
      total: totalVotes,
    });

    return result;
  }

  // ═══════════════════════════════════════════════════════════
  //  SYSTEM PROMPT — Medical Diploma Forensics (Algeria)
  // ═══════════════════════════════════════════════════════════

  _getSystemPrompt() {
    return `You are an expert forensic document examiner specializing EXCLUSIVELY in Algerian Medical Diplomas (Docteur en Médecine).

IMPORTANT RULES:
1. You ONLY accept and verify MEDICAL diplomas (Docteur en Médecine, Docteur en Pharmacie, Docteur en Chirurgie Dentaire).
2. If the document is NOT a medical diploma (e.g. Engineering, Computer Science, Law, Bachelor's Degree, Master's in non-medical field), you MUST immediately reject it with is_authentic=false and reason="NOT_MEDICAL_DIPLOMA".
3. If the document IS a medical diploma, analyze it for authenticity using the criteria below.

AUTHENTICITY CRITERIA FOR ALGERIAN MEDICAL DIPLOMAS:
- REAL diplomas are issued by Algerian Faculties of Medicine (Faculté de Médecine) and bear the seal of the Ministry of Higher Education.
- REAL diplomas are typically in Arabic and/or French, printed on official watermarked paper, with wet ink signatures and embossed/stamped university seals.
- REAL diplomas have natural scan artifacts: slight rotation, uneven lighting, paper texture visible.

FRAUD PATTERNS TO DETECT:
1. TEMPLATE FORGERY: The document looks like a digital template with perfectly aligned text, no scan distortion, and clean white background. Common among translated diploma forgeries from translation agencies.
2. GENERIC SERIAL NUMBERS: Placeholder serial numbers like "1234567", "0000000", or "No.1157596" reused across multiple documents.
3. DIGITAL SIGNATURES: Signatures that appear flat, pixelated, or identical to known digital stamp PNGs without natural ink bleed.
4. WRONG FIELD OF STUDY: The diploma says "Engineering", "Computer Science", "Informatics", "Law", "Commerce", or any non-medical field — this is NOT a valid medical diploma.
5. INCONSISTENT SEALS: University seals that look like pasted PNG layers with white artifact edges instead of naturally overlapping the paper.
6. TRANSLATION TEMPLATES: Documents from unofficial translators (e.g., "Asma ZEGADI", "Fatma CHOUKI") that use the same exact layout for every diploma — these are commonly used to forge credentials.

Return your response STRICTLY as a JSON object with this exact schema, and absolutely nothing else:
{
  "is_authentic": boolean,
  "confidence_score": number (0 to 100),
  "is_medical_diploma": boolean,
  "reason": "Brief explanation"
}`;
  }

  // ═══════════════════════════════════════════════════════════
  //  FEW-SHOT TRAINING — Load real/fake examples from disk
  // ═══════════════════════════════════════════════════════════

  _loadTrainingSamples() {
    const examples = { real: [], fake: [] };

    try {
      const realDir = path.join(TRAINING_DIR, 'real');
      const fakeDir = path.join(TRAINING_DIR, 'fake');

      if (fs.existsSync(realDir)) {
        const realFiles = fs.readdirSync(realDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
        for (const file of realFiles.slice(0, 2)) { // Max 2 real examples
          const buf = fs.readFileSync(path.join(realDir, file));
          const ext = path.extname(file).toLowerCase().replace('.', '');
          examples.real.push({
            base64: buf.toString('base64'),
            mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            filename: file,
          });
        }
      }

      if (fs.existsSync(fakeDir)) {
        const fakeFiles = fs.readdirSync(fakeDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
        for (const file of fakeFiles.slice(0, 2)) { // Max 2 fake examples
          const buf = fs.readFileSync(path.join(fakeDir, file));
          const ext = path.extname(file).toLowerCase().replace('.', '');
          examples.fake.push({
            base64: buf.toString('base64'),
            mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            filename: file,
          });
        }
      }

      const totalExamples = examples.real.length + examples.fake.length;
      if (totalExamples > 0) {
        logger.info('Loaded training samples for Vision AI', {
          real: examples.real.length,
          fake: examples.fake.length,
        });
      }
    } catch (err) {
      logger.warn('Could not load training samples (non-blocking)', { error: err.message });
    }

    return examples;
  }

  /**
   * Build few-shot message array for OpenAI/Groq-style APIs.
   * @private
   */
  _buildFewShotMessages(base64Image, mimeType) {
    const messages = [
      { role: 'system', content: this._getSystemPrompt() },
    ];

    // Inject REAL examples
    for (const ex of this._trainingExamples.real) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `TRAINING EXAMPLE — This is a REAL, AUTHENTIC Algerian medical diploma (${ex.filename}). Study its characteristics: natural paper texture, wet ink signatures, embossed seals, and official formatting.` },
          { type: 'image_url', image_url: { url: `data:${ex.mimeType};base64,${ex.base64}` } },
        ],
      });
      messages.push({
        role: 'assistant',
        content: '{"is_authentic": true, "confidence_score": 95, "is_medical_diploma": true, "reason": "Training example — confirmed authentic medical diploma with natural scan artifacts and official seals."}',
      });
    }

    // Inject FAKE examples
    for (const ex of this._trainingExamples.fake) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `TRAINING EXAMPLE — This is a FAKE, FORGED diploma (${ex.filename}). Study its fraud indicators: digital template layout, flat signatures, placeholder serial numbers, or non-medical field of study.` },
          { type: 'image_url', image_url: { url: `data:${ex.mimeType};base64,${ex.base64}` } },
        ],
      });
      messages.push({
        role: 'assistant',
        content: '{"is_authentic": false, "confidence_score": 95, "is_medical_diploma": false, "reason": "Training example — confirmed forgery with template layout and digital artifacts."}',
      });
    }

    // The actual image to analyze
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Now analyze this newly uploaded document. Determine: (1) Is it a medical diploma? (2) Is it authentic or forged? Return ONLY the JSON object.' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
      ],
    });

    return messages;
  }

  // ═══════════════════════════════════════════════════════════
  //  MODEL 1: Groq — Llama 4 Scout (Vision)
  // ═══════════════════════════════════════════════════════════

  async _callGroq(base64Image, mimeType) {
    if (!this.groqKey) return null;
    try {
      const messages = this._buildFewShotMessages(base64Image, mimeType);

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          response_format: { type: 'json_object' },
          messages,
          temperature: 0.1,
          max_tokens: 500,
        },
        {
          headers: { 'Authorization': `Bearer ${this.groqKey}` },
          timeout: 30000,
        }
      );

      const content = response.data.choices[0].message.content;
      logger.info('Groq Llama-4-Scout responded', { raw: content.substring(0, 200) });
      return JSON.parse(content);
    } catch (e) {
      logger.error('Groq Vision API error', { error: e.message, status: e.response?.status, data: e.response?.data });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  MODEL 2: Gemini 1.5 Pro (Vision)
  // ═══════════════════════════════════════════════════════════

  async _callGemini(base64Image, mimeType) {
    if (!this.geminiKey) return null;
    try {
      // Build parts array with few-shot examples
      const parts = [{ text: this._getSystemPrompt() }];

      for (const ex of this._trainingExamples.real) {
        parts.push({ text: `TRAINING — REAL authentic medical diploma (${ex.filename}):` });
        parts.push({ inline_data: { mime_type: ex.mimeType, data: ex.base64 } });
      }
      for (const ex of this._trainingExamples.fake) {
        parts.push({ text: `TRAINING — FAKE forged diploma (${ex.filename}):` });
        parts.push({ inline_data: { mime_type: ex.mimeType, data: ex.base64 } });
      }

      parts.push({ text: 'Now analyze this newly uploaded document. Is it a real medical diploma or a forgery? Return ONLY the JSON object.' });
      parts.push({ inline_data: { mime_type: mimeType, data: base64Image } });

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${this.geminiKey}`,
        {
          contents: [{ parts }],
          generationConfig: { response_mime_type: 'application/json' },
        },
        { timeout: 60000 }
      );

      const content = response.data.candidates[0].content.parts[0].text;
      logger.info('Gemini responded', { raw: content.substring(0, 200) });
      return JSON.parse(content);
    } catch (e) {
      logger.error('Gemini Vision API error', { error: e.message, status: e.response?.status });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  MODEL 3: OpenAI GPT-4o (Vision)
  // ═══════════════════════════════════════════════════════════

  async _callOpenAI(base64Image, mimeType) {
    if (!this.openAiKey) return null;
    try {
      const messages = this._buildFewShotMessages(base64Image, mimeType);

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          response_format: { type: 'json_object' },
          messages,
          temperature: 0.1,
          max_tokens: 500,
        },
        {
          headers: { 'Authorization': `Bearer ${this.openAiKey}` },
          timeout: 60000,
        }
      );

      const content = response.data.choices[0].message.content;
      logger.info('OpenAI GPT-4o responded', { raw: content.substring(0, 200) });
      return JSON.parse(content);
    } catch (e) {
      logger.error('OpenAI Vision API error', { error: e.message, status: e.response?.status });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  FACE DETECTION — Uses Gemini to detect if image has a face
  // ═══════════════════════════════════════════════════════════

  async detectFace(buffer, mimeType) {
    const base64Image = buffer.toString('base64');

    const prompt = `Analyze this image. Does it contain exactly ONE clear human face?
Return ONLY a JSON object with this schema:
{
  "has_face": boolean,
  "face_count": number,
  "quality": "HIGH" | "MEDIUM" | "LOW",
  "reason": "Brief explanation"
}`;

    try {
      if (this.geminiKey) {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${this.geminiKey}`,
          {
            contents: [{ parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Image } },
            ]}],
            generationConfig: { response_mime_type: 'application/json' },
          },
          { timeout: 30000 }
        );

        const content = response.data.candidates[0].content.parts[0].text;
        const parsed = JSON.parse(content);
        return {
          has_face: parsed.has_face,
          score: parsed.has_face ? (parsed.quality === 'HIGH' ? 95 : parsed.quality === 'MEDIUM' ? 75 : 50) : 0,
          details: parsed,
        };
      }
    } catch (e) {
      logger.error('Face detection failed', { error: e.message });
    }

    return { has_face: false, score: 0, details: { error: 'No AI model available' } };
  }

  // ═══════════════════════════════════════════════════════════
  //  FACE COMPARISON — Uses Gemini to compare selfie vs ID photo
  // ═══════════════════════════════════════════════════════════

  async compareFacesWithAI(selfieBuffer, selfieMime, idBuffer, idMime) {
    const selfieB64 = selfieBuffer.toString('base64');
    const idB64 = idBuffer.toString('base64');

    const prompt = `You are a biometric face verification expert. Compare the two images below.
Image 1 is a SELFIE. Image 2 is a NATIONAL ID CARD or PASSPORT photo.

Determine if they show the SAME person. Account for differences in angle, lighting, age, and image quality.

Return ONLY a JSON object with this schema:
{
  "same_person": boolean,
  "confidence": number (0-100),
  "selfie_has_face": boolean,
  "id_has_face": boolean,
  "reason": "Brief explanation"
}`;

    try {
      if (this.geminiKey) {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${this.geminiKey}`,
          {
            contents: [{ parts: [
              { text: prompt },
              { text: 'IMAGE 1 — SELFIE:' },
              { inline_data: { mime_type: selfieMime, data: selfieB64 } },
              { text: 'IMAGE 2 — ID CARD / PASSPORT:' },
              { inline_data: { mime_type: idMime, data: idB64 } },
            ]}],
            generationConfig: { response_mime_type: 'application/json' },
          },
          { timeout: 45000 }
        );

        const content = response.data.candidates[0].content.parts[0].text;
        const parsed = JSON.parse(content);

        logger.info('Face comparison result', { same_person: parsed.same_person, confidence: parsed.confidence });

        return {
          matched: parsed.same_person,
          confidence: parsed.confidence,
          selfie_has_face: parsed.selfie_has_face,
          id_has_face: parsed.id_has_face,
          reason: parsed.reason,
        };
      }
    } catch (e) {
      logger.error('Face comparison failed', { error: e.message });
    }

    return { matched: false, confidence: 0, reason: 'No AI model available for face comparison' };
  }
}

module.exports = VisionVerificationService;

