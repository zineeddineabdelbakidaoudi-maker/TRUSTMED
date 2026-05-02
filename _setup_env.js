/**
 * Generates RSA keys and writes a complete .env file with correct base64 keys.
 * Run once: node _setup_env.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Verify the keypair works with jsonwebtoken
const jwt = require('jsonwebtoken');
const testToken = jwt.sign({ test: true }, privateKey, { algorithm: 'RS256' });
jwt.verify(testToken, publicKey, { algorithms: ['RS256'] });
console.log('✅ Keypair verified successfully');

const privB64 = Buffer.from(privateKey, 'utf8').toString('base64');
const pubB64 = Buffer.from(publicKey, 'utf8').toString('base64');

// Verify roundtrip
const privBack = Buffer.from(privB64, 'base64').toString('utf8');
const pubBack = Buffer.from(pubB64, 'base64').toString('utf8');
const testToken2 = jwt.sign({ test: 'roundtrip' }, privBack, { algorithm: 'RS256' });
jwt.verify(testToken2, pubBack, { algorithms: ['RS256'] });
console.log('✅ Base64 roundtrip verified');

const envContent = `# ─── Server ───────────────────────────────────────
PORT=8000
NODE_ENV=development
VERIFICATION_PORTAL_URL=http://localhost:3000/verify

# ─── PostgreSQL ───────────────────────────────────
PGHOST=localhost
PGPORT=5432
PGUSER=trustmed
PGPASSWORD=change_me_in_production
PGDATABASE=trustmed

# ─── Redis ────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ─── RabbitMQ ─────────────────────────────────────
RABBITMQ_URL=amqp://guest:guest@localhost:5672

# ─── JWT RS256 Keys (base64-encoded PEM strings) ──
JWT_PRIVATE_KEY=${privB64}
JWT_PUBLIC_KEY=${pubB64}

# ─── HMAC Secret ──────────────────────────────────
HMAC_SECRET=${crypto.randomBytes(32).toString('hex')}

# ─── Webhook ──────────────────────────────────────
WEBHOOK_TIMEOUT_MS=5000
WEBHOOK_MAX_RETRIES=3

# ─── Security & Hardening ─────────────────────────
AZURE_FACE_API_KEY=dummy_key
AZURE_FACE_API_ENDPOINT=https://dummy.cognitiveservices.azure.com
LIVENESS_CONFIDENCE_THRESHOLD=0.85
FACE_MATCH_CONFIDENCE_THRESHOLD=0.80
GRAPH_ANOMALY_CLUSTER_SIZE=5
GRAPH_ANOMALY_DENSITY_THRESHOLD=0.80
INSTITUTIONAL_DOMAIN_WEIGHTS={"chu":30,"univ":20,"clinique":10,"hopital":15}

# --- V3: Adversarial-Grade Trust Infrastructure ----
TRUST_VELOCITY_MAX_PER_DAY=25
TRUST_VELOCITY_WINDOW_DAYS=3
VOUCH_AGE_WEIGHT_SCALE=30
DIVERSITY_MIN_CLUSTERS=2
STAKE_AMOUNT_DZD=500
SHADOW_BAN_RISK_THRESHOLD=75
BEHAVIORAL_BASELINE_DAYS=30
RISK_MOMENTUM_WINDOW_HOURS=24
HIDDEN_WEIGHT_VARIANCE=0.05
`;

fs.writeFileSync(path.join(__dirname, '.env'), envContent, 'utf8');
console.log('✅ .env file written with verified keypair');
