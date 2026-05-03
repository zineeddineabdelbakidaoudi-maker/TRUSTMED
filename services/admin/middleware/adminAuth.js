const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../../../shared/db/pool');
const { writeAuditLog } = require('../../../shared/db/audit');
const logger = require('../../../shared/logger');

const loginRouter = express.Router();
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const JWT_EXPIRES_IN = 28800; // 8 hours in seconds

// POST /admin/login
loginRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'invalid_request', message: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, role, full_name FROM admin_users WHERE email = $1 AND is_active = true',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password' });
    }

    const admin = result.rows[0];
    const match = await bcrypt.compare(password, admin.password_hash);

    if (!match) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password' });
    }

    if (!JWT_SECRET) {
      logger.error('ADMIN_JWT_SECRET is not set in environment variables');
      return res.status(500).json({ error: 'server_error', message: 'Server configuration error' });
    }

    const access_token = jwt.sign(
      { sub: admin.id, role: admin.role, email: admin.email },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN }
    );

    await pool.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [admin.id]);

    await writeAuditLog({
      actorId: admin.id,
      actorType: 'system',
      action: 'ADMIN_LOGIN',
      targetId: admin.id,
      metadata: { role: admin.role },
      ipAddress: req.ip,
    });

    logger.info('Admin logged in', { adminId: admin.id, email: admin.email });

    return res.json({
      access_token,
      role: admin.role,
      full_name: admin.full_name,
      expires_in: JWT_EXPIRES_IN,
    });
  } catch (err) {
    logger.error('Admin login error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
  }
});

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader === 'Bearer null') {
    // DEV BYPASS: Allow access without token during local development
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('DEV BYPASS: Authenticating as mock admin');
      req.admin = { id: '00000000-0000-0000-0000-000000000000', role: 'ADMIN', email: 'admin@trustmed.dz' };
      return next();
    }
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];

  if (!JWT_SECRET) {
    logger.error('ADMIN_JWT_SECRET is not set');
    return res.status(500).json({ error: 'server_error', message: 'Server configuration error' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.admin = {
      id: payload.sub,
      role: payload.role,
      email: payload.email,
    };
    next();
  } catch (err) {
    logger.warn('Admin token verification failed', { error: err.message });
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
}

// Middleware to restrict by admin role
function requireRole(role) {
  return (req, res, next) => {
    if (!req.admin || req.admin.role !== role) {
      logger.warn('Admin access denied - role mismatch', { 
        adminId: req.admin?.id, 
        requiredRole: role, 
        actualRole: req.admin?.role 
      });
      return res.status(403).json({ error: 'forbidden', message: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = {
  loginRouter,
  requireAdmin,
  requireRole,
};
