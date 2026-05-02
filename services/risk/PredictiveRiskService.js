const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');

const BEHAVIORAL_BASELINE_DAYS = parseInt(process.env.BEHAVIORAL_BASELINE_DAYS || '30', 10);
const RISK_MOMENTUM_WINDOW_HOURS = parseInt(process.env.RISK_MOMENTUM_WINDOW_HOURS || '24', 10);
const SHADOW_BAN_RISK_THRESHOLD = parseInt(process.env.SHADOW_BAN_RISK_THRESHOLD || '75', 10);

class PredictiveRiskService {
  /**
   * Record a behavioral event for a practitioner.
   */
  async recordBehavioralEvent(practitionerId, eventType, metadata, req, db = pool) {
    try {
      await db.query(
        `INSERT INTO behavioral_events (practitioner_id, event_type, event_metadata, fingerprint_hash, session_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          practitionerId,
          eventType,
          JSON.stringify(metadata || {}),
          req?.fingerprint_hash || null,
          req?.session_id || null,
        ]
      );
    } catch (err) {
      logger.error('recordBehavioralEvent failed', { practitionerId, eventType, error: err.message });
    }
  }

  /**
   * Compute behavioral baselines from verified practitioners.
   */
  async computeBehavioralBaseline(db = pool) {
    try {
      // Average time from registration to first document upload
      const timeToUploadRes = await db.query(`
        SELECT AVG(EXTRACT(EPOCH FROM (d.created_at - p.created_at))) as avg_seconds
        FROM practitioners p
        JOIN documents d ON d.practitioner_id = p.id
        WHERE p.badge_level IN ('FULLY_VERIFIED', 'CNOM_CONFIRMED_PLUS')
          AND p.created_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY p.id
        ORDER BY avg_seconds ASC
        LIMIT 1
      `, [BEHAVIORAL_BASELINE_DAYS]);

      // Average sessions before completion (from behavioral_events)
      const sessionsRes = await db.query(`
        SELECT AVG(session_count) as avg_sessions FROM (
          SELECT practitioner_id, COUNT(DISTINCT session_id) as session_count
          FROM behavioral_events
          WHERE created_at > NOW() - INTERVAL '1 day' * $1
          GROUP BY practitioner_id
        ) sub
      `, [BEHAVIORAL_BASELINE_DAYS]);

      // Average inter-event delay
      const delayRes = await db.query(`
        SELECT AVG(delay_seconds) as avg_delay FROM (
          SELECT EXTRACT(EPOCH FROM (
            LEAD(created_at) OVER (PARTITION BY practitioner_id ORDER BY created_at) - created_at
          )) as delay_seconds
          FROM behavioral_events
          WHERE created_at > NOW() - INTERVAL '1 day' * $1
        ) sub
        WHERE delay_seconds IS NOT NULL AND delay_seconds > 0
      `, [BEHAVIORAL_BASELINE_DAYS]);

      const baselines = {
        avg_time_to_first_upload_seconds: parseFloat(timeToUploadRes.rows[0]?.avg_seconds) || 86400,
        avg_sessions_before_completion: parseFloat(sessionsRes.rows[0]?.avg_sessions) || 3,
        avg_inter_event_delay_seconds: parseFloat(delayRes.rows[0]?.avg_delay) || 30,
        computed_at: new Date().toISOString(),
      };

      await db.query(
        `INSERT INTO system_baselines (key, value, computed_at) VALUES ('behavioral', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, computed_at = NOW()`,
        [JSON.stringify(baselines)]
      );

      logger.info('Behavioral baselines computed', baselines);
      return baselines;
    } catch (err) {
      logger.error('computeBehavioralBaseline failed', { error: err.message });
      return null;
    }
  }

  /**
   * Score sequence anomaly for a practitioner.
   */
  async scoreSequenceAnomaly(practitionerId, db = pool) {
    try {
      // Fetch baselines
      const baselineRes = await db.query("SELECT value FROM system_baselines WHERE key = 'behavioral'");
      const baselines = baselineRes.rows.length > 0 ? baselineRes.rows[0].value : {
        avg_time_to_first_upload_seconds: 86400,
        avg_sessions_before_completion: 3,
        avg_inter_event_delay_seconds: 30,
      };

      // Fetch practitioner events
      const eventsRes = await db.query(
        `SELECT event_type, created_at, session_id FROM behavioral_events
         WHERE practitioner_id = $1 ORDER BY created_at ASC`,
        [practitionerId]
      );

      if (eventsRes.rows.length < 2) {
        return { anomaly_score: 0, flags: [] };
      }

      let anomalyScore = 0;
      const flags = [];
      const events = eventsRes.rows;

      // Check time to first upload
      const firstUpload = events.find(e => e.event_type === 'DOCUMENT_UPLOAD_COMPLETED');
      const firstEvent = events[0];
      if (firstUpload && firstEvent) {
        const timeToUpload = (new Date(firstUpload.created_at) - new Date(firstEvent.created_at)) / 1000;
        if (timeToUpload < baselines.avg_time_to_first_upload_seconds * 0.1) {
          anomalyScore += 30;
          flags.push('BOT_LIKE_SPEED');
        }
      }

      // Check single-session completion
      const uniqueSessions = new Set(events.filter(e => e.session_id).map(e => e.session_id));
      if (uniqueSessions.size <= 1 && events.length > 5) {
        anomalyScore += 15;
        flags.push('SINGLE_SESSION_COMPLETION');
      }

      // Check inter-event delay
      let totalDelay = 0;
      let delayCount = 0;
      for (let i = 1; i < events.length; i++) {
        const delay = (new Date(events[i].created_at) - new Date(events[i - 1].created_at)) / 1000;
        if (delay > 0) { totalDelay += delay; delayCount++; }
      }
      const avgDelay = delayCount > 0 ? totalDelay / delayCount : 999;
      if (avgDelay < 2) {
        anomalyScore += 25;
        flags.push('AUTOMATED_SPEED');
      }

      // Check attack pattern: rapid upload→submit→otp→verify sequence
      const typeSequence = events.map(e => e.event_type).join(',');
      if (typeSequence.includes('DOCUMENT_UPLOAD_COMPLETED,FORM_SUBMIT,OTP_REQUESTED')) {
        const uploadIdx = events.findIndex(e => e.event_type === 'DOCUMENT_UPLOAD_COMPLETED');
        const otpIdx = events.findIndex(e => e.event_type === 'OTP_REQUESTED');
        if (uploadIdx >= 0 && otpIdx > uploadIdx) {
          const span = (new Date(events[otpIdx].created_at) - new Date(events[uploadIdx].created_at)) / 1000;
          if (span < 10) {
            anomalyScore += 35;
            flags.push('ATTACK_PATTERN_DETECTED');
          }
        }
      }

      // Update practitioner
      await db.query('UPDATE practitioners SET behavioral_score = $1 WHERE id = $2', [anomalyScore, practitionerId]);

      if (anomalyScore >= 60) {
        const practRes = await db.query('SELECT risk_flags, risk_score FROM practitioners WHERE id = $1', [practitionerId]);
        if (practRes.rows.length > 0) {
          let risk_flags = practRes.rows[0].risk_flags || [];
          if (!risk_flags.some(f => f.signal === 'BEHAVIORAL_AUTOMATION_DETECTED')) {
            risk_flags.push({
              signal: 'BEHAVIORAL_AUTOMATION_DETECTED',
              severity: 'HIGH',
              risk_points: 45,
              details: { anomaly_score: anomalyScore, flags }
            });
            await db.query(
              'UPDATE practitioners SET risk_score = risk_score + 45, risk_flags = $1 WHERE id = $2',
              [JSON.stringify(risk_flags), practitionerId]
            );
          }
        }
      }

      return { anomaly_score: anomalyScore, flags };
    } catch (err) {
      logger.error('scoreSequenceAnomaly failed', { practitionerId, error: err.message });
      return { anomaly_score: 0, flags: [] };
    }
  }

  /**
   * Compute risk momentum (rapid risk increase detection).
   */
  async computeRiskMomentum(practitionerId, db = pool) {
    try {
      const res = await db.query(
        `SELECT risk_score, recorded_at FROM trust_score_history
         WHERE practitioner_id = $1 AND recorded_at > NOW() - INTERVAL '1 hour' * $2
         ORDER BY recorded_at ASC`,
        [practitionerId, RISK_MOMENTUM_WINDOW_HOURS]
      );

      if (res.rows.length < 2) {
        return { momentum: 0, flagged: false };
      }

      const oldest = res.rows[0];
      const latest = res.rows[res.rows.length - 1];
      const hoursDiff = Math.max(1, (new Date(latest.recorded_at) - new Date(oldest.recorded_at)) / 3600000);
      const delta = latest.risk_score - oldest.risk_score;
      const momentum = delta / hoursDiff;

      const flagged = delta > 30;

      if (flagged) {
        const practRes = await db.query('SELECT risk_flags FROM practitioners WHERE id = $1', [practitionerId]);
        if (practRes.rows.length > 0) {
          let risk_flags = practRes.rows[0].risk_flags || [];
          if (!risk_flags.some(f => f.signal === 'HIGH_RISK_MOMENTUM')) {
            risk_flags.push({
              signal: 'HIGH_RISK_MOMENTUM', severity: 'HIGH', risk_points: 30,
              details: { momentum, delta, hours: hoursDiff }
            });
            await db.query(
              'UPDATE practitioners SET risk_momentum = $1, risk_score = risk_score + 30, risk_flags = $2 WHERE id = $3',
              [momentum, JSON.stringify(risk_flags), practitionerId]
            );
          }
        }
      } else {
        await db.query('UPDATE practitioners SET risk_momentum = $1 WHERE id = $2', [momentum, practitionerId]);
      }

      return { momentum, flagged };
    } catch (err) {
      logger.error('computeRiskMomentum failed', { practitionerId, error: err.message });
      return { momentum: 0, flagged: false };
    }
  }

  /**
   * Evaluate and apply shadow ban if conditions met.
   */
  async evaluateShadowBan(practitionerId, db = pool) {
    try {
      const res = await db.query(
        'SELECT risk_score, behavioral_score, shadow_banned, verification_status FROM practitioners WHERE id = $1',
        [practitionerId]
      );
      if (res.rows.length === 0) return { shadow_banned: false };

      const pract = res.rows[0];

      // Already shadow banned or frozen
      if (pract.shadow_banned) return { shadow_banned: true };
      if (pract.verification_status === 'FLAGGED' || pract.verification_status === 'SUSPENDED') {
        return { shadow_banned: false };
      }

      const shouldBan = pract.risk_score >= SHADOW_BAN_RISK_THRESHOLD && pract.behavioral_score >= 60;

      if (shouldBan) {
        await db.query(
          'UPDATE practitioners SET shadow_banned = true, shadow_banned_at = NOW() WHERE id = $1',
          [practitionerId]
        );

        // DO NOT notify the practitioner
        await writeAuditLog({
          actorType: 'system',
          action: 'SHADOW_BAN_APPLIED',
          targetId: practitionerId,
          metadata: { risk_score: pract.risk_score, behavioral_score: pract.behavioral_score },
        });

        logger.warn('Shadow ban applied', { practitionerId, risk_score: pract.risk_score, behavioral_score: pract.behavioral_score });
        return { shadow_banned: true };
      }

      return { shadow_banned: false };
    } catch (err) {
      logger.error('evaluateShadowBan failed', { practitionerId, error: err.message });
      return { shadow_banned: false };
    }
  }

  /**
   * Lift a shadow ban (admin action).
   */
  async liftShadowBan(practitionerId, adminId, reason, db = pool) {
    await db.query('UPDATE practitioners SET shadow_banned = false WHERE id = $1', [practitionerId]);
    await writeAuditLog({
      actorId: adminId,
      actorType: 'admin',
      action: 'SHADOW_BAN_LIFTED',
      targetId: practitionerId,
      metadata: { reason },
    });
    logger.info('Shadow ban lifted', { practitionerId, adminId, reason });
  }
}

module.exports = PredictiveRiskService;
