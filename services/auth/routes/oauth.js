const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../../../shared/db/pool');
const { signToken } = require('../../../shared/crypto/jwt');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');
const validate = require('../middleware/validate');
const rateLimiter = require('../middleware/rateLimiter');
const { authorizeSchema, tokenSchema } = require('../schemas/auth.schemas');

const router = express.Router();

// ════════════════════════════════════════════════════════════════
// GET /oauth/authorize — Initiate OAuth2 Authorization Code Flow
// ════════════════════════════════════════════════════════════════
router.get('/authorize', validate(authorizeSchema, 'query'), async (req, res) => {
  const { client_id, redirect_uri, scope, state, response_type } = req.validated;

  try {
    // 1. Look up partner by client_id
    const partnerResult = await pool.query(
      'SELECT id, redirect_uris, allowed_scopes, is_active FROM partners WHERE client_id = $1',
      [client_id]
    );

    if (partnerResult.rows.length === 0) {
      logger.warn('Unknown client_id in authorize request', { client_id });
      return res.status(400).json({
        error: 'invalid_client',
        message: 'Unknown client_id',
      });
    }

    const partner = partnerResult.rows[0];

    if (!partner.is_active) {
      return res.status(400).json({
        error: 'inactive_client',
        message: 'This partner application has been deactivated',
      });
    }

    // 2. Validate redirect_uri — exact string match against whitelist
    if (!partner.redirect_uris.includes(redirect_uri)) {
      logger.warn('Invalid redirect_uri', { client_id, redirect_uri, allowed: partner.redirect_uris });
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        message: 'redirect_uri is not registered for this client',
      });
    }

    // 3. Validate requested scopes
    const requestedScopes = scope.split(/[\s+]+/).filter(Boolean);
    const invalidScopes = requestedScopes.filter((s) => !partner.allowed_scopes.includes(s));
    if (invalidScopes.length > 0) {
      return res.status(400).json({
        error: 'invalid_scope',
        message: `Invalid scopes: ${invalidScopes.join(', ')}`,
      });
    }

    // 4. Generate auth_code (crypto.randomBytes(32).toString('hex'))
    const authCode = crypto.randomBytes(32).toString('hex');
    const authCodeExp = new Date(Date.now() + 60 * 1000); // 60 seconds

    // 5. Create verification session
    const sessionResult = await pool.query(
      `INSERT INTO verification_sessions 
       (partner_id, auth_code, auth_code_exp, state, redirect_uri, scopes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
       RETURNING id`,
      [partner.id, authCode, authCodeExp, state, redirect_uri, requestedScopes]
    );

    const sessionId = sessionResult.rows[0].id;

    // 6. Audit log
    await writeAuditLog({
      actorId: partner.id,
      actorType: 'partner',
      action: 'OAUTH_AUTHORIZE',
      targetId: sessionId,
      metadata: { client_id, scopes: requestedScopes },
      ipAddress: req.ip,
    });

    // 7. Redirect to verification portal
    const portalUrl = process.env.VERIFICATION_PORTAL_URL || 'http://localhost:3000/verify';
    const redirectTo = `${portalUrl}?session_id=${sessionId}&client_id=${client_id}`;

    logger.info('Authorization session created', { sessionId, client_id });

    return res.redirect(302, redirectTo);
  } catch (err) {
    logger.error('Error in /oauth/authorize', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'server_error',
      message: 'Internal server error',
    });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /oauth/token — Exchange auth code for JWT access token
// ════════════════════════════════════════════════════════════════
router.post('/token', rateLimiter(10, 60), validate(tokenSchema, 'body'), async (req, res) => {
  const { client_id, client_secret, code, redirect_uri } = req.validated;

  try {
    // 1. Look up partner and validate client_secret (bcrypt compare)
    const partnerResult = await pool.query(
      'SELECT id, client_secret, redirect_uris, is_active FROM partners WHERE client_id = $1',
      [client_id]
    );

    if (partnerResult.rows.length === 0) {
      return res.status(400).json({
        error: 'invalid_client',
        message: 'Unknown client_id',
      });
    }

    const partner = partnerResult.rows[0];

    if (!partner.is_active) {
      return res.status(400).json({
        error: 'inactive_client',
        message: 'This partner application has been deactivated',
      });
    }

    const secretMatch = await bcrypt.compare(client_secret, partner.client_secret);
    if (!secretMatch) {
      logger.warn('Invalid client_secret', { client_id });
      await writeAuditLog({
        actorId: partner.id,
        actorType: 'partner',
        action: 'TOKEN_EXCHANGE_FAILED',
        metadata: { reason: 'invalid_client_secret', client_id },
        ipAddress: req.ip,
      });
      return res.status(400).json({
        error: 'invalid_client',
        message: 'Invalid client credentials',
      });
    }

    // 2. Look up verification session by auth_code
    //    Check: auth_code_exp > NOW() AND used_at IS NULL
    const sessionResult = await pool.query(
      `SELECT id, practitioner_id, partner_id, redirect_uri, scopes, status
       FROM verification_sessions
       WHERE auth_code = $1
         AND auth_code_exp > NOW()
         AND used_at IS NULL`,
      [code]
    );

    if (sessionResult.rows.length === 0) {
      // Check if code exists but is expired or already used
      const existsResult = await pool.query(
        'SELECT id, used_at, auth_code_exp FROM verification_sessions WHERE auth_code = $1',
        [code]
      );

      let reason = 'invalid_code';
      if (existsResult.rows.length > 0) {
        const session = existsResult.rows[0];
        if (session.used_at) reason = 'code_already_used';
        else if (new Date(session.auth_code_exp) <= new Date()) reason = 'code_expired';
      }

      logger.warn('Invalid auth code exchange attempt', { client_id, reason });
      await writeAuditLog({
        actorId: partner.id,
        actorType: 'partner',
        action: 'TOKEN_EXCHANGE_FAILED',
        metadata: { reason, client_id },
        ipAddress: req.ip,
      });
      return res.status(400).json({
        error: 'invalid_grant',
        message: reason === 'code_already_used'
          ? 'Authorization code has already been used'
          : reason === 'code_expired'
            ? 'Authorization code has expired'
            : 'Invalid authorization code',
      });
    }

    const session = sessionResult.rows[0];

    // 3. Validate partner_id matches
    if (session.partner_id !== partner.id) {
      return res.status(400).json({
        error: 'invalid_grant',
        message: 'Authorization code was not issued to this client',
      });
    }

    // 4. Validate redirect_uri exact match
    if (session.redirect_uri !== redirect_uri) {
      return res.status(400).json({
        error: 'invalid_grant',
        message: 'redirect_uri does not match the original request',
      });
    }

    // 5. Mark auth_code as used (set used_at = NOW())
    await pool.query(
      'UPDATE verification_sessions SET used_at = NOW(), status = $1 WHERE id = $2',
      ['COMPLETED', session.id]
    );

    // 6. Get practitioner data for JWT payload
    let practitionerData = {
      sub: session.practitioner_id,
      trust_score: 0,
      badge_level: 'NONE',
      verification_status: 'IDENTITY_PENDING',
      risk_score: 0,
    };

    if (session.practitioner_id) {
      const practResult = await pool.query(
        'SELECT id, trustmed_id, trust_score, badge_level, verification_status, risk_score, trust_confidence FROM practitioners WHERE id = $1',
        [session.practitioner_id]
      );
      if (practResult.rows.length > 0) {
        const p = practResult.rows[0];
        practitionerData = {
          sub: p.id,
          trustmed_id: p.trustmed_id,
          trust_score: p.trust_score,
          badge_level: p.badge_level,
          verification_status: p.verification_status,
          risk_score: p.risk_score || 0,
          trust_confidence: p.trust_confidence || 'HIGH',
        };
      }
    }

    // 7. Generate JWT (RS256, 1hr expiry)
    const jwtPayload = {
      sub: practitionerData.sub,
      partner_id: partner.id,
      scopes: session.scopes,
      trust_score: practitionerData.trust_score,
      badge_level: practitionerData.badge_level,
      trust_confidence: practitionerData.trust_confidence,
    };

    // Include risk data only if partner requested 'risk' scope
    if (session.scopes.includes('risk')) {
      const riskScore = practitionerData.risk_score;
      jwtPayload.risk_score = riskScore;
      jwtPayload.risk_level = riskScore >= 60 ? 'HIGH' : riskScore >= 30 ? 'MEDIUM' : 'LOW';
    }

    const accessToken = signToken(jwtPayload);
    const tokenExp = new Date(Date.now() + 3600 * 1000); // 1 hour

    // 8. Store access_token in session
    await pool.query(
      'UPDATE verification_sessions SET access_token = $1, token_exp = $2 WHERE id = $3',
      [accessToken, tokenExp, session.id]
    );

    // 9. Audit log
    await writeAuditLog({
      actorId: partner.id,
      actorType: 'partner',
      action: 'TOKEN_EXCHANGE_SUCCESS',
      targetId: session.practitioner_id,
      metadata: {
        client_id,
        session_id: session.id,
        scopes: session.scopes,
      },
      ipAddress: req.ip,
    });

    logger.info('Token exchange successful', {
      sessionId: session.id,
      client_id,
      practitioner_id: session.practitioner_id,
    });

    // 10. Return token response
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      practitioner_id: practitionerData.trustmed_id || null,
      verification_status: practitionerData.verification_status,
      trust_score: practitionerData.trust_score,
      badge_level: practitionerData.badge_level,
    });
  } catch (err) {
    logger.error('Error in /oauth/token', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'server_error',
      message: 'Internal server error',
    });
  }
});

module.exports = router;
