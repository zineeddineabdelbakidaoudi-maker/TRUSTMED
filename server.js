require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('./shared/logger');
const oauthRoutes = require('./services/auth/routes/oauth');
const practitionerRoutes = require('./services/auth/routes/practitioner');
const partnerRoutes = require('./services/auth/routes/partner');
const documentsRoutes = require('./services/auth/routes/documents');
const phoneRoutes = require('./services/auth/routes/phone');
const { requireAdmin } = require('./services/admin/middleware/adminAuth');
const { loginRouter: adminLoginRouter } = require('./services/admin/middleware/adminAuth');
const adminQueueRoutes = require('./services/admin/routes/queue');
const adminCasesRoutes = require('./services/admin/routes/cases');
const adminPractitionerRoutes = require('./services/admin/routes/practitioners');
const cnomRoutes = require('./services/cnom/routes/cnom');
const badgeRoutes = require('./services/badge/routes/badge');
const { connectQueue } = require('./shared/queue/connection');
const { startConsumer } = require('./shared/queue/consumer');

const app = express();

// ── Security headers ──
app.use(helmet());
app.use(cors());

// ── Body parsing ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Trust proxy (for correct req.ip behind reverse proxies) ──
app.set('trust proxy', 1);

// ── Routes ──
app.use('/oauth', oauthRoutes);
app.use('/v1/practitioner', practitionerRoutes);
app.use('/v1/practitioner', require('./services/auth/routes/consent'));
app.use('/v1/practitioner', documentsRoutes);
app.use('/v1/practitioner', phoneRoutes);
app.use('/v1/practitioner', require('./services/vouching/routes/vouch'));
app.use('/v1/practitioner', require('./services/institutional/routes/institutional'));
app.use('/v1/institutional', require('./services/institutional/routes/institutional'));
app.use('/v1/partner', partnerRoutes);
app.use('/admin', adminLoginRouter);
app.use('/admin/queue', requireAdmin, adminQueueRoutes);
app.use('/admin/cases', requireAdmin, adminCasesRoutes);
app.use('/admin/practitioners', adminPractitionerRoutes);
app.use('/api/cnom', cnomRoutes);
app.use('/api/admin/practitioners', adminPractitionerRoutes);
app.use('/v1/badge', badgeRoutes);
app.use('/v1', badgeRoutes); // for /v1/verify/:id
app.use('/v1/verify', require('./services/auth/middleware/authenticate'), require('./services/auth/routes/recheck'));

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'trustmed', timestamp: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'trustmed', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ── Global error handler ──
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'server_error', message: 'Internal server error' });
});

// ── Start server ──
const PORT = parseInt(process.env.PORT, 10) || 8000;

async function start() {
  try {
    // Connect to RabbitMQ and start consumer
    await connectQueue();
    await startConsumer();
    logger.info('RabbitMQ connected and consumer started');
  } catch (err) {
    logger.warn('RabbitMQ unavailable — starting without queue', { error: err.message });
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`TrustMed API server running on port ${PORT}`, { port: PORT, env: process.env.NODE_ENV });
  });
}

start();

module.exports = app;
