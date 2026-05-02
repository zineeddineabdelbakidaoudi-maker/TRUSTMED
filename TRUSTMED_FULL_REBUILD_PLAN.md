# TrustMed — Complete Full-Stack Rebuild Plan (A to Z)

> **Target Agent**: Claude Code
> **Goal**: Rebuild the ENTIRE TrustMed project from scratch — Backend + Frontend
> **OS**: Windows 11, PowerShell
> **Project Root**: `C:\Users\zinouuuuu\Documents\TRUSTMEDZ`
> **Language**: English UI only. No French. No Arabic.

---

## PART 1 — WHAT IS TRUSTMED

TrustMed is an **identity and qualification verification API** for the Algerian medical market. It works like "Sign in with Google" but for verifying that a doctor is real, licensed, and practicing in Algeria. Health platforms integrate via OAuth2 — doctors go through verification on TrustMed, get redirected back with a signed trust token.

### Core Philosophy
> Make fraud structurally irrational by tying it to a verified real identity with criminal liability.

A fraudster who knows their biometric passport data was captured, face matched, and they signed a legal declaration referencing Art. 243 Code Pénal (1-3 years imprisonment for impersonation) — will not attempt fraud.

---

## PART 2 — THE 5 VERIFICATION METHODS

### Method 1: NFC Passport/CNIB Chip (Identity Anchor)
- Doctor photographs MRZ zone → MRZ data unlocks chip (BAC/PACE protocol)
- Doctor taps document to phone NFC sensor
- System reads Data Groups: name, DOB, doc number, facial photo (DG2)
- Passive Authentication: verifies chip digital signature chain
- Active Authentication: chip signs random challenge with private key
- Liveness selfie compared against chip DG2 photo (>95% similarity)

### Method 2: Legal Liability Declaration (Deterrence Engine)
- Cannot scroll past in under 45 seconds (JS enforced timer)
- Auto-fills real name/CIN from NFC data (unalterable)
- References Art. 243 Code Pénal Algérien explicitly
- Records: identity_hash, full_name, cin_number, selfie_vector_hash, declaration_text, timestamp, IP, device_fingerprint, geolocation, HMAC-SHA256 signature
- Stored in append-only table (PostgreSQL triggers prevent UPDATE/DELETE)

### Method 3: Document Upload + OCR + Vision AI
- Uploads: Diploma, CNOM Card, Cabinet Agrément, Selfie
- Azure Document Intelligence extracts: name, CNOM number, specialty, graduation year, university
- Arabic + French dual-language OCR
- Multi-model fraud detection (Gemini, Groq, OpenAI)
- Documents encrypted with AES-256-CBC before storage in MinIO

### Method 4: Silent CNOM Scraper (Background Verification)
- Scrapes CNOM and SORM web directories using extracted CNOM number
- Covers all 48 wilaya portals + 3 third-party fallback sources
- Fuzzy name matching (Levenshtein ≥80% = CONFIRMED, ≥60% = PROVISIONAL, <60% = MISMATCH)
- Cross-matches: scraped name vs NFC name, scraped CNOM vs OCR CNOM, scraped specialty vs diploma

### Method 5: Phone OTP to Clinic Landline
- Calls the clinic landline from Google Maps database (NOT the doctor's mobile)
- Random delay 15-45 minutes (makes interception harder)
- 6-digit OTP spoken in Arabic + French
- OTP hashed with bcrypt (never stored plaintext), 5-minute expiry, max 3 attempts

---

## PART 3 — TRUST SCORE & STATUS SYSTEM

### Trust Score (0-100)
| Signal | Points |
|--------|--------|
| NFC Identity Anchor | +25-30 |
| Legal Declaration Signed | +5-15 |
| CNOM Scraper Confirmed | +15-35 |
| Phone OTP Verified | +10-14 |
| Clean Document Check | +6 |
| Institutional Email | +20 |
| Peer Vouching | +25 |

### Badge Levels
| Score | Badge |
|-------|-------|
| 0–29 | NONE |
| 30–44 | IDENTITY_VERIFIED |
| 45–79 | CNOM_CONFIRMED |
| 80–93 | CNOM_CONFIRMED_PLUS |
| 94–100 | FULLY_VERIFIED |

### Verification Status Flow
```
IDENTITY_PENDING → (NFC) → IDENTITY_CONFIRMED → (declaration + docs) → PROVISIONAL → (CNOM match) → CNOM_CONFIRMED → (phone OTP) → FULLY_VERIFIED
At any point: → FLAGGED | SUSPENDED | FROZEN | REJECTED
```

---

## PART 4 — TECHNOLOGY STACK

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ |
| Web Framework | Express 4 |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Message Queue | RabbitMQ 3 |
| Document Storage | MinIO (S3-compatible) |
| OCR | Azure Document Intelligence + Tesseract.js |
| Vision AI | Gemini + Groq + OpenAI (multi-model) |
| JWT | RS256 asymmetric keys |
| Document Encryption | AES-256-CBC |
| HMAC | SHA-256 |
| Password Hashing | bcrypt (saltRounds=12) |
| Scraping | axios + cheerio + fastest-levenshtein |
| SMS/OTP | Twilio |
| Email | SendGrid |
| Logging | Winston |
| Validation | Zod |
| Frontend | Next.js 16 (App Router) |
| Animations | Framer Motion |
| Icons | Lucide React |
| HTTP Client | Axios |

### NPM Dependencies (Backend)
```json
{
  "@azure/ai-form-recognizer": "^5.1.0",
  "@sendgrid/mail": "^8.1.6",
  "amqplib": "^0.10.4",
  "axios": "^1.7.2",
  "axios-retry": "^4.5.0",
  "bcrypt": "^5.1.1",
  "cheerio": "^1.2.0",
  "cors": "^2.8.5",
  "dotenv": "^16.4.5",
  "express": "^4.18.2",
  "fastest-levenshtein": "^1.0.16",
  "form-data": "^4.0.5",
  "helmet": "^7.1.0",
  "ioredis": "^5.4.1",
  "jsonwebtoken": "^9.0.2",
  "minio": "^8.0.7",
  "multer": "^2.1.1",
  "node-cron": "^4.2.1",
  "pg": "^8.12.0",
  "redis": "^5.12.1",
  "tesseract.js": "^7.0.0",
  "twilio": "^6.0.0",
  "uuid": "^9.0.1",
  "winston": "^3.13.0",
  "zod": "^3.23.8"
}
```

---

## PART 5 — DATABASE SCHEMA (24 Migrations)

### Core Tables

**practitioners**
```sql
CREATE TABLE practitioners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trustmed_id VARCHAR(20) NOT NULL UNIQUE, -- format: TM-XX-XXXX-XXXX
  nfc_identity_hash VARCHAR(64) UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  cin_number VARCHAR(30) NOT NULL UNIQUE,
  specialty VARCHAR(100),
  wilaya_code SMALLINT,
  cnom_number VARCHAR(30) UNIQUE,
  verification_status verification_status_enum NOT NULL DEFAULT 'IDENTITY_PENDING',
  trust_score SMALLINT NOT NULL DEFAULT 0 CHECK (0-100),
  badge_level VARCHAR(30) NOT NULL DEFAULT 'NONE',
  risk_score SMALLINT DEFAULT 0,
  risk_flags JSONB DEFAULT '[]',
  base_trust_score SMALLINT DEFAULT 0,
  trust_confidence VARCHAR(10) DEFAULT 'HIGH',
  shadow_banned BOOLEAN DEFAULT false,
  behavioral_score SMALLINT DEFAULT 100,
  risk_momentum NUMERIC(5,2) DEFAULT 0,
  stake_status VARCHAR(20) DEFAULT 'NONE',
  vouch_count SMALLINT DEFAULT 0,
  email VARCHAR(255),
  privacy_consented BOOLEAN DEFAULT false,
  privacy_consented_at TIMESTAMPTZ,
  institutional_email_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**documents**
```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  practitioner_id UUID REFERENCES practitioners(id),
  doc_type VARCHAR(20) NOT NULL, -- CIN|DIPLOMA|CNOM_CARD|AGREMENT|SELFIE
  storage_key VARCHAR(500),
  size_bytes INTEGER,
  checksum_sha256 VARCHAR(64),
  status VARCHAR(20) DEFAULT 'UPLOADED', -- UPLOADED|PROCESSING|VERIFIED|REJECTED|SUPERSEDED
  ocr_result JSONB,
  fraud_score SMALLINT DEFAULT 0,
  fraud_flags JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**verification_sessions** (OAuth2)
```sql
CREATE TABLE verification_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id UUID REFERENCES partners(id),
  practitioner_id UUID REFERENCES practitioners(id),
  auth_code VARCHAR(64) UNIQUE,
  auth_code_exp TIMESTAMPTZ,
  state VARCHAR(255),
  redirect_uri VARCHAR(1000),
  scopes TEXT[],
  status VARCHAR(20) DEFAULT 'PENDING',
  access_token TEXT,
  token_exp TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**partners**
```sql
CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  client_id VARCHAR(64) NOT NULL UNIQUE,
  client_secret VARCHAR(255) NOT NULL, -- bcrypt hash
  redirect_uris TEXT[] NOT NULL,
  allowed_scopes TEXT[] NOT NULL,
  webhook_url VARCHAR(1000),
  webhook_secret VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**legal_declarations** (APPEND-ONLY — triggers prevent UPDATE/DELETE)
```sql
CREATE TABLE legal_declarations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  practitioner_id UUID REFERENCES practitioners(id),
  declaration_text TEXT NOT NULL,
  hmac_signature VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**audit_log** (APPEND-ONLY — triggers prevent UPDATE/DELETE)
```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID,
  actor_type VARCHAR(20),
  action VARCHAR(100) NOT NULL,
  target_id UUID,
  metadata JSONB,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Other tables**: `cnom_verifications`, `phone_verifications`, `admin_users`, `reviewer_queue`, `practitioner_vouches`, `institutional_verifications`, `trust_score_history`

### Append-Only Triggers (CRITICAL SECURITY)
```sql
CREATE OR REPLACE FUNCTION prevent_update_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'UPDATE and DELETE are not allowed on this table';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_legal BEFORE UPDATE OR DELETE ON legal_declarations
  FOR EACH ROW EXECUTE FUNCTION prevent_update_delete();
CREATE TRIGGER no_update_audit BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_update_delete();
```

---

## PART 6 — BACKEND ARCHITECTURE

### Directory Structure
```
TRUSTMEDZ/
├── server.js                    ← Express entry point
├── package.json
├── .env
├── migrate.js                   ← Runs SQL migrations
├── seed.js                      ← Seeds test data
├── generate-keys.js             ← Generates RS256 key pair
├── shared/
│   ├── logger.js                ← Winston logger
│   ├── crypto/
│   │   ├── jwt.js               ← RS256 sign/verify (base64 PEM from env)
│   │   └── hmac.js              ← HMAC-SHA256 sign/verify (constant-time)
│   ├── db/
│   │   ├── pool.js              ← pg Pool (max:20, timeout:5s)
│   │   └── audit.js             ← writeAuditLog() — every DB action must call this
│   ├── queue/
│   │   ├── connection.js        ← RabbitMQ connect with 5x exponential retry
│   │   ├── consumer.js          ← Consumes PROCESS_DOCUMENTS jobs
│   │   └── publisher.js         ← Publishes jobs to queue
│   └── storage/
│       └── StorageService.js    ← MinIO + AES-256-CBC encrypt/decrypt
├── services/
│   ├── auth/
│   │   ├── routes/
│   │   │   ├── oauth.js         ← GET /oauth/authorize, POST /oauth/token
│   │   │   ├── practitioner.js  ← GET /v1/practitioner/me
│   │   │   ├── documents.js     ← POST/GET /v1/practitioner/documents
│   │   │   ├── phone.js         ← POST phone/request, phone/verify
│   │   │   ├── consent.js       ← POST /v1/practitioner/consent
│   │   │   ├── partner.js       ← Partner registration
│   │   │   └── recheck.js       ← Re-verification
│   │   ├── middleware/
│   │   │   ├── authenticate.js  ← JWT RS256 verification middleware
│   │   │   ├── rateLimiter.js   ← Rate limiting (Redis-backed)
│   │   │   └── validate.js      ← Zod validation middleware
│   │   └── schemas/
│   │       └── auth.schemas.js  ← Zod schemas for OAuth
│   ├── admin/
│   │   ├── middleware/
│   │   │   └── adminAuth.js     ← POST /admin/login + requireAdmin + requireRole
│   │   └── routes/
│   │       ├── queue.js         ← GET /admin/queue, stats, assign
│   │       └── cases.js         ← GET case detail, approve/reject/freeze/unfreeze
│   ├── verification/
│   │   ├── VerificationEngine.js ← State machine (9 steps, transitions, webhooks)
│   │   └── TrustScoreCalculator.js ← Weighted scoring + risk adjustment
│   ├── badge/
│   │   ├── BadgeService.js      ← SVG/JSON/Widget generation
│   │   └── routes/badge.js      ← GET /v1/badge/:id.svg|json, Redis cached
│   ├── cnom/
│   │   ├── CnomScraper.js       ← 48-wilaya portal scraping + 3 fallback sources
│   │   └── CnomWorker.js        ← Batch verification cron job
│   ├── ocr/                     ← Azure Document Intelligence + Tesseract
│   ├── risk/                    ← Predictive risk scoring, shadow banning
│   ├── legal-vault/             ← HMAC-signed legal declarations
│   ├── liveness/                ← Azure Face API liveness + face match
│   ├── notifications/           ← SendGrid email templates
│   ├── webhook/                 ← HMAC-signed webhook dispatch to partners
│   ├── vouching/                ← Peer vouching system
│   ├── institutional/           ← Institutional email verification
│   ├── economic/                ← Economic friction (stake system)
│   ├── graph/                   ← Social graph anomaly detection
│   └── monitoring/              ← Health checks, metrics
├── migrations/                  ← 24 SQL migration files (001-024)
└── frontend/                    ← Next.js 16 App Router
```

### API Routes (Complete)
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/oauth/authorize` | None | OAuth2 initiation |
| POST | `/oauth/token` | None | Code→JWT exchange (rate limited: 10/min) |
| GET | `/v1/practitioner/me` | Bearer JWT | Profile (scope-filtered) |
| POST | `/v1/practitioner/consent` | Bearer JWT | Privacy consent + HMAC legal record |
| POST | `/v1/practitioner/documents` | Bearer JWT | Upload (multipart, 10MB, AES encrypted) |
| GET | `/v1/practitioner/documents` | Bearer JWT | List documents |
| GET | `/v1/practitioner/documents/:id/download` | Bearer JWT | Download decrypted |
| POST | `/v1/practitioner/phone/request` | Bearer JWT | Request OTP (+213 format) |
| POST | `/v1/practitioner/phone/verify` | Bearer JWT | Verify 6-digit OTP (bcrypt compare) |
| GET | `/v1/badge/:id.svg` | None | SVG badge (Redis cached) |
| GET | `/v1/badge/:id/json` | None | Badge JSON data |
| POST | `/admin/login` | None | Admin JWT (HS256, 8h expiry) |
| GET | `/admin/queue` | Admin JWT | Paginated review queue |
| GET | `/admin/queue/stats` | Admin JWT | pending/assigned/resolved stats |
| POST | `/admin/queue/:id/assign` | Admin JWT | Self-assign case |
| GET | `/admin/cases/:id` | Admin JWT | Full case detail |
| POST | `/admin/cases/:id/approve` | Admin JWT | Approve + trigger engine |
| POST | `/admin/cases/:id/reject` | Admin JWT | Reject (notes required) |
| POST | `/admin/cases/:id/request-more-info` | Admin JWT | Request more info |
| POST | `/admin/cases/practitioners/:id/freeze` | ADMIN role | Freeze practitioner |
| POST | `/admin/cases/practitioners/:id/unfreeze` | ADMIN role | Unfreeze |
| GET | `/health` | None | Health check |

### Security Architecture (NON-NEGOTIABLE)
1. **JWT**: RS256 asymmetric keys (base64-encoded PEM in .env), 1h expiry, issuer: "trustmed"
2. **Admin JWT**: HS256, separate secret, 8h expiry
3. **Passwords**: bcrypt (saltRounds=12)
4. **OTP**: bcrypt hashed, 5-minute expiry, max 3 attempts, 60s cooldown
5. **Documents**: AES-256-CBC encrypted at rest (IV prepended to ciphertext)
6. **Legal records**: HMAC-SHA256 signed, append-only tables with DB triggers
7. **Webhooks**: HMAC-SHA256 signed payloads, constant-time verification
8. **Auth codes**: crypto.randomBytes(32), 60-second expiry, single-use
9. **Client secrets**: bcrypt hashed, never stored plaintext
10. **Redirect URIs**: exact string match (no wildcards)
11. **Rate limiting**: Redis-backed, 10 req/min on /oauth/token
12. **Input validation**: Zod on every endpoint
13. **Headers**: helmet() for security headers
14. **Audit**: every DB action writes to immutable audit_log
15. **CORS**: configured, trust proxy enabled
16. **File upload**: multer memory storage, 10MB limit, MIME whitelist

---

## PART 7 — ENVIRONMENT VARIABLES

```env
PORT=8000
NODE_ENV=development
VERIFICATION_PORTAL_URL=http://localhost:3000/verify

# PostgreSQL
PGHOST=localhost
PGPORT=5432
PGUSER=trustmed
PGPASSWORD=change_me_in_production
PGDATABASE=trustmed

# Redis
REDIS_URL=redis://localhost:6379

# RabbitMQ
RABBITMQ_URL=amqp://guest:guest@localhost:5672

# JWT RS256 Keys (base64-encoded PEM) — generate with generate-keys.js
JWT_PRIVATE_KEY=<base64>
JWT_PUBLIC_KEY=<base64>

# HMAC
HMAC_SECRET=<64-char hex>

# MinIO
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=trustmed
MINIO_SECRET_KEY=trustmed123
MINIO_BUCKET=trustmed-documents

# AES-256 Document Encryption
AES_DOCUMENT_KEY=<64-char hex>

# Twilio (OTP)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Azure OCR
AZURE_DOCUMENT_INTELLIGENCE_KEY=
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=

# Vision AI (Multi-model)
GEMINI_API_KEY=
GROQ_API_KEY=
OPENAI_API_KEY=

# CNOM Portals (48 wilayas)
CNOM_PORTAL_NATIONAL=https://www.sorm-cne.dz/annuaire
# ... (12 regional + 3 fallback sources)

# Admin
ADMIN_JWT_SECRET=<64-char hex>
SENDGRID_API_KEY=
DOMAIN=trustmed.dz

# Advanced Security
LIVENESS_CONFIDENCE_THRESHOLD=0.85
FACE_MATCH_CONFIDENCE_THRESHOLD=0.80
SHADOW_BAN_RISK_THRESHOLD=75
```

---

## PART 8 — FRONTEND SPECIFICATION

### Tech Stack
- Next.js 16 (App Router)
- Framer Motion (animations)
- Lucide React (icons)
- Axios (HTTP)
- CSS Modules (styling — NOT Tailwind, unless using @tailwindcss/postcss)

### CRITICAL RULES
1. Every page using hooks/state/animations: `'use client';` at top
2. NO `<style jsx>` — causes Server Component build errors
3. NO empty onClick handlers or setTimeout simulations
4. ALL buttons hit real backend API endpoints
5. Store JWT in localStorage, attach via Axios interceptor

### Pages
1. **`/`** — Landing page with animated hero, feature cards, CTA → /verify
2. **`/verify`** — 4-step wizard:
   - Step 1: NFC scan → POST to backend, get JWT
   - Step 2: Legal declaration → POST /v1/practitioner/consent
   - Step 3: Document upload → POST /v1/practitioner/documents (real FormData)
   - Step 4: Trust score dashboard → poll GET /v1/badge/:id/json
3. **`/admin/login`** — Email/password → POST /admin/login
4. **`/admin`** — Dashboard with sidebar, stats from GET /admin/queue/stats, table from GET /admin/queue
5. **`/admin/case/[id]`** — Case detail with approve/reject/freeze buttons

### Design System
- Dark mode only, glassmorphism cards
- Colors: background #0a0f1e, primary #10b981 (emerald), danger #ef4444
- Framer Motion: staggered fade-ins, slide transitions, hover lifts, animated progress

---

## PART 9 — BUILD ORDER

### Phase 1: Foundation
1. `npm init`, install all dependencies
2. Create shared/ modules: logger, pool, audit, jwt, hmac, storage
3. Create all 24 migration SQL files
4. Create migrate.js runner
5. Create generate-keys.js (RS256 key pair)
6. Create .env with all variables

### Phase 2: Auth & OAuth2
7. Create auth middleware (authenticate, rateLimiter, validate)
8. Create Zod schemas
9. Create OAuth routes (authorize, token)
10. Create practitioner routes (me, consent, documents, phone)
11. Create partner routes

### Phase 3: Verification Engine
12. Create TrustScoreCalculator
13. Create VerificationEngine (state machine, 9 steps)
14. Create LegalVaultService (HMAC-signed declarations)
15. Create WebhookDispatcher
16. Create RabbitMQ queue/consumer/publisher

### Phase 4: Intelligence Services
17. Create StorageService (MinIO + AES-256-CBC)
18. Create OCR service (Azure + Tesseract)
19. Create CnomScraper (48-wilaya portals + 3 fallbacks)
20. Create CnomWorker (batch cron job)
21. Create phone OTP service (Twilio)

### Phase 5: Admin & Risk
22. Create admin auth (login, requireAdmin, requireRole)
23. Create admin queue routes
24. Create admin cases routes (approve/reject/freeze)
25. Create BadgeService (SVG + JSON + widget)
26. Create risk scoring services
27. Create liveness/face match service

### Phase 6: Server Assembly
28. Create server.js — wire all routes
29. Create seed.js — test data + admin user
30. Test: `node server.js` starts without errors

### Phase 7: Frontend
31. `npx create-next-app@latest frontend`
32. Install framer-motion, lucide-react, axios
33. Create lib/api.js (Axios + interceptor)
34. Build all 5 pages with real API integration
35. Test: `npm run build` succeeds

---

## PART 10 — VERIFICATION CHECKLIST

- [ ] `node server.js` starts (graceful degradation if Redis/RabbitMQ missing)
- [ ] GET /health returns `{status: "ok"}`
- [ ] OAuth authorize → token exchange flow works
- [ ] Document upload encrypts and stores in MinIO
- [ ] Phone OTP: request → verify flow with bcrypt
- [ ] Legal declarations are HMAC-signed and append-only
- [ ] Admin login returns JWT
- [ ] Admin queue returns paginated cases
- [ ] Admin approve/reject updates practitioner status
- [ ] Badge SVG and JSON endpoints return valid data
- [ ] CNOM scraper searches portals and matches names
- [ ] Trust score calculates correctly across all 7 signals
- [ ] Audit log records every database action
- [ ] Frontend builds with zero errors
- [ ] All frontend buttons hit real backend endpoints
- [ ] Animations are smooth (framer-motion)

---

*This document contains everything needed to rebuild TrustMed from scratch. Read the existing `TrustMed_Developer_Brief.md` in the project root for additional product context. Execute phases 1-7 in order. Do not skip. Do not mock.*
