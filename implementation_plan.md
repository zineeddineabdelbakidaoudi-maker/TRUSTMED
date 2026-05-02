# TrustMed Backend — Phase 1 & Phase 2 Implementation Plan

Build the complete TrustMed verification engine backend with OAuth2, PostgreSQL, RabbitMQ, Redis, and full security hardening.

## Proposed Changes

### Project Structure

```
c:\Users\zinouuuuu\Documents\TRUSTMEDZ\
├── docker-compose.yml
├── .env.example
├── .env
├── README.md
├── package.json
├── services/
│   ├── auth/                    # OAuth2 server + JWT + partner registry
│   │   ├── index.js             # Express app entry point
│   │   ├── routes/
│   │   │   ├── oauth.js         # GET /oauth/authorize, POST /oauth/token
│   │   │   ├── practitioner.js  # GET /v1/practitioner/me
│   │   │   └── partner.js       # POST /v1/partner/register
│   │   ├── middleware/
│   │   │   ├── rateLimiter.js   # 10 req/min on /oauth/token
│   │   │   ├── authenticate.js  # JWT Bearer validation
│   │   │   └── validate.js      # Zod validation middleware
│   │   └── schemas/
│   │       └── auth.schemas.js  # Zod schemas for all auth inputs
│   ├── verification/            # State machine + trust score
│   │   ├── index.js
│   │   ├── VerificationEngine.js
│   │   └── TrustScoreCalculator.js
│   ├── legal-vault/             # Append-only legal records
│   │   ├── index.js
│   │   └── LegalVaultService.js
│   └── webhook/                 # Webhook dispatcher
│       ├── index.js
│       └── WebhookDispatcher.js
├── shared/
│   ├── db/
│   │   ├── pool.js              # PostgreSQL connection pool
│   │   └── audit.js             # Audit log helper
│   ├── queue/
│   │   ├── connection.js        # RabbitMQ connection
│   │   ├── publisher.js         # Publish messages
│   │   └── consumer.js          # PROCESS_DOCUMENTS consumer
│   ├── crypto/
│   │   ├── jwt.js               # RS256 JWT sign/verify
│   │   ├── keys/                # Generated RSA keypair
│   │   │   ├── private.pem
│   │   │   └── public.pem
│   │   └── hmac.js              # HMAC-SHA256 helpers
│   └── logger.js                # Winston structured logger
├── migrations/
│   ├── 001_create_extensions.sql
│   ├── 002_create_enums.sql
│   ├── 003_create_partners.sql
│   ├── 004_create_practitioners.sql
│   ├── 005_create_verification_sessions.sql
│   ├── 006_create_legal_declarations.sql
│   ├── 007_create_documents.sql
│   ├── 008_create_cnom_verifications.sql
│   ├── 009_create_phone_verifications.sql
│   ├── 010_create_audit_log.sql
│   └── 011_create_append_only_triggers.sql
├── migrate.js                   # Migration runner
├── seed.js                      # Test data seeder
└── generate-keys.js             # RSA keypair generator
```

---

### Phase 1 — Foundation

#### [NEW] docker-compose.yml
- `app`: Node.js 20-alpine, port 8000, depends on postgres/redis/rabbitmq
- `postgres`: PostgreSQL 16, port 5432, persistent volume
- `redis`: Redis 7-alpine, port 6379
- `rabbitmq`: RabbitMQ 3-management, ports 5672/15672

#### [NEW] Database Migrations (migrations/*.sql)
All 8 tables with exact schema from requirements:
- `partners` — UUID PK, bcrypt client_secret, TEXT[] redirect_uris/allowed_scopes
- `practitioners` — UUID PK, TM-WW-YY-NNNN trustmed_id with CHECK constraint, ENUM verification_status
- `verification_sessions` — auth_code with 60s TTL, FK to practitioners + partners
- `legal_declarations` — append-only with trigger, HMAC signature, JSONB fields
- `documents` — doc_type, storage_key, OCR results, fraud_flags
- `cnom_verifications` — scraped data, match_score, result ENUM
- `phone_verifications` — OTP hash, attempt_count, status
- `audit_log` — BIGSERIAL, append-only trigger, JSONB metadata

#### [NEW] OAuth2 Server (services/auth/)
- **GET /oauth/authorize**: Validates client_id, redirect_uri (exact match), scope, state. Creates verification_session with auth_code. Redirects to verification portal.
- **POST /oauth/token**: Validates client_id + client_secret (bcrypt compare), auth_code (60s TTL, single use), redirect_uri match. Returns JWT (RS256, 1hr expiry) with {sub, partner_id, scopes, trust_score, badge_level}.
- **GET /v1/practitioner/me**: Bearer token authentication. Returns full practitioner profile.
- **POST /v1/partner/register**: Registers new partner, bcrypt-hashes client_secret.

#### [NEW] JWT RS256 (shared/crypto/)
- `generate-keys.js`: Creates 2048-bit RSA keypair
- `jwt.js`: Sign with private key, verify with public key
- `hmac.js`: HMAC-SHA256 for legal vault and webhooks

#### [NEW] Middleware
- Rate limiter: Redis-backed, 10 req/min/IP on /oauth/token
- Zod validation: Schema-based input validation for all endpoints
- JWT authentication: Bearer token verification

---

### Phase 2 — Verification Engine

#### [NEW] VerificationEngine (services/verification/)
State machine processing 5 steps in order:
1. `NFC_COMPLETE` → IDENTITY_CONFIRMED, +30 trust
2. `DECLARATION_SIGNED` → stays IDENTITY_CONFIRMED, +15 trust, creates legal vault record
3. `DOCUMENTS_UPLOADED` → PROVISIONAL, +6 trust, publishes PROCESS_DOCUMENTS to RabbitMQ
4. `CNOM_CONFIRMED` → CNOM_CONFIRMED, +35 trust, fires webhook
5. `PHONE_OTP_VERIFIED` → FULLY_VERIFIED, +14 trust, fires webhook

#### [NEW] TrustScoreCalculator
Weighted scoring: NFC=30, DECLARATION=15, CNOM=35, PHONE=14, CLEAN_DOCS=6 → max 100
Badge level calculation based on score thresholds.

#### [NEW] LegalVaultService (services/legal-vault/)
- Append-only record creation
- HMAC-SHA256 signing of all record fields with platform secret
- Verification of existing signatures

#### [NEW] RabbitMQ Consumer (shared/queue/)
- Connects to RabbitMQ, creates `document_processing` queue
- Consumes `PROCESS_DOCUMENTS` jobs and logs them (OCR stub for Phase 3)

#### [NEW] WebhookDispatcher (services/webhook/)
- POST to partner's webhook_url on status changes
- HMAC-SHA256 signed payloads
- Retry logic with exponential backoff

---

## Security Implementation

| Requirement | Implementation |
|---|---|
| client_secret storage | bcrypt hash, saltRounds=12 |
| auth_code generation | `crypto.randomBytes(32).toString('hex')` |
| auth_code TTL | 60 seconds, single use, deleted after exchange |
| redirect_uri validation | Exact string match against partner whitelist |
| state parameter | Passed through untouched (CSRF) |
| JWT signing | RS256, 1hr expiry, {sub, partner_id, scopes, trust_score, badge_level} |
| Input validation | Zod schemas on all endpoints |
| Rate limiting | Redis-backed, 10 req/min/IP on /oauth/token |
| Structured logging | Winston with timestamp, level, service, message |
| Audit trail | Every DB action → audit_log (append-only) |
| Legal vault | Append-only table, HMAC-SHA256, PG triggers block UPDATE/DELETE |

---

## Verification Plan

### Automated Tests
1. `docker-compose up --build` — all 4 containers healthy
2. `node migrate.js` — all migrations succeed, 8 tables created
3. `node seed.js` — test partner + practitioner seeded
4. Curl tests for all OAuth endpoints (documented in README)
5. Verify append-only triggers block UPDATE/DELETE
6. Rate limiting: 11 requests in 1 minute → 429 on 11th
7. Zod validation: malformed inputs → 400 with error messages
8. VerificationEngine: all 5 steps with correct state transitions and trust scores
9. RabbitMQ: PROCESS_DOCUMENTS job visible in management UI
10. Webhook: fires on CNOM_CONFIRMED and FULLY_VERIFIED
