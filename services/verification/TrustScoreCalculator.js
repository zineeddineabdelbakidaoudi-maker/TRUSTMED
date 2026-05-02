/**
 * TrustScoreCalculator — Probabilistic Trust Engine (v3)
 *
 * Redesigned weighted scoring with per-signal confidence and hidden variance.
 * Maximum total: 100.
 *
 * Partners see a score. They do NOT see the formula or weights.
 */
const crypto = require('crypto');

const WEIGHTS = {
  NFC_COMPLETE:                 17,
  DECLARATION_SIGNED:            5,
  DOCUMENTS_UPLOADED:            0,
  DOCUMENT_CLEAN:                0,
  CNOM_CONFIRMED:               15,
  PHONE_OTP_VERIFIED:           10,
  INSTITUTIONAL_EMAIL_VERIFIED: 15,
  PEER_VOUCHING_COMPLETE:       25,
  LIVENESS_VERIFIED:            13,
};

const MAX_SCORE = 100;
const HIDDEN_WEIGHT_VARIANCE = parseFloat(process.env.HIDDEN_WEIGHT_VARIANCE || '0.05');

const BADGE_THRESHOLDS = [
  { min: 94, max: 100, badge: 'FULLY_VERIFIED' },
  { min: 80, max: 93,  badge: 'CNOM_CONFIRMED_PLUS' },
  { min: 45, max: 79,  badge: 'CNOM_CONFIRMED' },
  { min: 30, max: 44,  badge: 'IDENTITY_VERIFIED' },
  { min: 0,  max: 29,  badge: 'NONE' },
];

class TrustScoreCalculator {
  /**
   * Get the point value for a verification step.
   */
  static getStepPoints(step) {
    if (!(step in WEIGHTS)) {
      throw new Error(`Unknown verification step: ${step}`);
    }
    return WEIGHTS[step];
  }

  /**
   * Calculate the new base trust score after applying a step.
   */
  static calculateNewBaseScore(currentBaseScore, step) {
    const delta = TrustScoreCalculator.getStepPoints(step);
    return Math.min(currentBaseScore + delta, MAX_SCORE);
  }

  /**
   * Legacy computeFinalScore — still used by VerificationEngine for step processing.
   */
  static computeFinalScore(baseScore, riskScore, riskFlags = []) {
    let multiplier = 1.0;
    const hasHigh = riskFlags.some(f => f.severity === 'HIGH');
    const hasMedium = riskFlags.some(f => f.severity === 'MEDIUM');
    const hasLow = riskFlags.some(f => f.severity === 'LOW');

    if (hasHigh) { multiplier = 0.70; }
    else if (hasMedium) { multiplier = 0.90; }
    else if (hasLow) { multiplier = 0.97; }

    const final_score = Math.round(baseScore * multiplier);
    let trust_confidence = 'HIGH';
    if (multiplier < 0.90) { trust_confidence = 'LOW'; }
    else if (multiplier < 1.0) { trust_confidence = 'MEDIUM'; }

    return {
      final_score: Math.min(final_score, MAX_SCORE),
      trust_confidence,
    };
  }

  /**
   * Generate a deterministic pseudo-random number from a practitioner UUID.
   * Same UUID → same perturbation every time (non-gameable, non-random-per-call).
   * @private
   */
  static _seededRandom(practitionerId, signalName) {
    const hash = crypto.createHash('sha256').update(`${practitionerId}:${signalName}`).digest();
    // Use first 4 bytes as a uint32 and normalize to [0, 1)
    const uint32 = hash.readUInt32BE(0);
    return uint32 / 0xFFFFFFFF;
  }

  /**
   * Full probabilistic scoring model.
   *
   * @param {Array} signals - Array of { name, base_weight, achieved, confidence }
   * @param {Array} riskFlags - Risk flags array
   * @param {object} practitioner - Practitioner row (needs id)
   * @returns {{ final_score, base_score, trust_confidence, signal_confidences, trust_distribution }}
   */
  static computeProbabilisticScore(signals, riskFlags = [], practitioner = {}) {
    const practitionerId = practitioner.id || 'default';
    const signalConfidences = {};
    let rawSum = 0;
    let varianceAdjustedSum = 0;

    for (const signal of signals) {
      if (!signal.achieved) continue;

      const confidence = Math.min(1.0, Math.max(0, signal.confidence || 1.0));
      signalConfidences[signal.name] = parseFloat(confidence.toFixed(4));

      const baseContribution = signal.base_weight * confidence;
      rawSum += baseContribution;

      // Apply hidden variance: deterministic per (practitioner, signal)
      const rand = TrustScoreCalculator._seededRandom(practitionerId, signal.name);
      const perturbation = (rand - 0.5) * 2 * HIDDEN_WEIGHT_VARIANCE * signal.base_weight;
      varianceAdjustedSum += baseContribution + perturbation;
    }

    const baseScore = Math.round(Math.min(rawSum, MAX_SCORE));

    // Apply risk multiplier
    let multiplier = 1.0;
    const hasHigh = riskFlags.some(f => f.severity === 'HIGH');
    const hasMedium = riskFlags.some(f => f.severity === 'MEDIUM');
    if (hasHigh) { multiplier = 0.70; }
    else if (hasMedium) { multiplier = 0.90; }

    const finalScore = Math.round(Math.min(varianceAdjustedSum * multiplier, MAX_SCORE));
    const clampedScore = Math.max(0, Math.min(finalScore, MAX_SCORE));

    // Confidence label
    let trustConfidence = 'HIGH';
    if (multiplier < 0.90) { trustConfidence = 'LOW'; }
    else if (multiplier < 1.0) { trustConfidence = 'MEDIUM'; }

    // Uncertainty distribution (p5, p50, p95)
    const variance = HIDDEN_WEIGHT_VARIANCE * rawSum;
    const trustDistribution = {
      p5: Math.max(0, Math.round(clampedScore - 2 * variance)),
      p50: clampedScore,
      p95: Math.min(MAX_SCORE, Math.round(clampedScore + 2 * variance)),
    };

    return {
      final_score: clampedScore,
      base_score: baseScore,
      trust_confidence: trustConfidence,
      signal_confidences: signalConfidences,
      trust_distribution: trustDistribution,
    };
  }

  /**
   * Build signals array from a practitioner's completed steps.
   *
   * @param {object} practitioner - Full practitioner row
   * @param {object} contextData - Additional context { liveness_score, cnom_match_score, otp_attempts, has_institutional_confirmation, effective_vouch_strength, vouch_diversity_score }
   * @returns {Array} signals
   */
  static buildSignals(practitioner, contextData = {}) {
    const completedSteps = practitioner.completed_steps || [];

    return [
      {
        name: 'NFC_COMPLETE',
        base_weight: WEIGHTS.NFC_COMPLETE,
        achieved: completedSteps.includes('NFC_COMPLETE'),
        confidence: completedSteps.includes('LIVENESS_VERIFIED') ? 1.0 : 0.7,
      },
      {
        name: 'PEER_VOUCHING_COMPLETE',
        base_weight: WEIGHTS.PEER_VOUCHING_COMPLETE,
        achieved: completedSteps.includes('PEER_VOUCHING_COMPLETE'),
        confidence: Math.min(1.0, (contextData.effective_vouch_strength || 0.5)) * (contextData.vouch_diversity_score || 0.5),
      },
      {
        name: 'LIVENESS_VERIFIED',
        base_weight: WEIGHTS.LIVENESS_VERIFIED,
        achieved: completedSteps.includes('LIVENESS_VERIFIED'),
        confidence: contextData.liveness_score || 0.85,
      },
      {
        name: 'INSTITUTIONAL_EMAIL_VERIFIED',
        base_weight: WEIGHTS.INSTITUTIONAL_EMAIL_VERIFIED,
        achieved: completedSteps.includes('INSTITUTIONAL_EMAIL_VERIFIED'),
        confidence: contextData.has_institutional_confirmation ? 0.9 : 0.6,
      },
      {
        name: 'CNOM_CONFIRMED',
        base_weight: WEIGHTS.CNOM_CONFIRMED,
        achieved: completedSteps.includes('CNOM_CONFIRMED'),
        confidence: contextData.cnom_match_score || 0.9,
      },
      {
        name: 'PHONE_OTP_VERIFIED',
        base_weight: WEIGHTS.PHONE_OTP_VERIFIED,
        achieved: completedSteps.includes('PHONE_OTP_VERIFIED'),
        confidence: (contextData.otp_attempts || 1) <= 1 ? 1.0 : (contextData.otp_attempts <= 2 ? 0.85 : 0.70),
      },
      {
        name: 'DECLARATION_SIGNED',
        base_weight: WEIGHTS.DECLARATION_SIGNED,
        achieved: completedSteps.includes('DECLARATION_SIGNED'),
        confidence: 1.0,
      },
    ];
  }

  /**
   * Determine badge level based on trust score.
   */
  static getBadgeLevel(score) {
    for (const threshold of BADGE_THRESHOLDS) {
      if (score >= threshold.min && score <= threshold.max) {
        return threshold.badge;
      }
    }
    return 'NONE';
  }

  static getWeights() { return { ...WEIGHTS }; }
  static getMaxScore() { return MAX_SCORE; }
}

module.exports = TrustScoreCalculator;
