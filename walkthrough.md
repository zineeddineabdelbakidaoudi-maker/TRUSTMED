# TrustMed — Phase 1 & Phase 2 Walkthrough

Complete implementation of the TrustMed backend verification engine.

---

## Project Structure

```
TRUSTMEDZ/
├── server.js                          # Express entry point (port 8000)
├── docker-compose.yml                 # PostgreSQL 16, Redis 7, RabbitMQ 3
├── Dockerfile                         # Node 20-alpine production image
├── migrate.js                         # Sequential SQL migration runner
├── seed.js                            # Test data (partner + practitioner)
├── generate-keys.js                   # RSA keypair → prints to console
├── _setup_env.js                      # Full .env generator with verified keys
├── .env.example                       # All variables documented
├── .gitignore                         # *.pem blocked from VCS
│
├── services/
│   ├── auth/
│   │   ├── routes/oauth.js            # GET /oauth/authorize, POST /oauth/token
│   │   ├── routes/practitioner.js     # GET /v1/practitioner/me
│   │   ├── routes/partner.js          # POST /v1/partner/register
│   │   ├── middleware/rateLimiter.js   # Redis-backed 10 req/min/IP
│   │   ├── middleware/authenticate.js  # JWT Bearer verification
│   │   ├── middleware/validate.js      # Zod validation middleware
│   │   └── schemas/auth.schemas.js     # Zod schemas for all inputs
│   ├── verification/
│   │   ├── VerificationEngine.js      # 6-step state machine
│   │   └── TrustScoreCalculator.js    # Weighted scoring (max 100)
│   ├── legal-vault/
│   │   └── LegalVaultService.js       # HMAC-signed append-only records
│   └── webhook/
│       └── WebhookDispatcher.js       # HMAC-signed POST with retry
│
├── shared/
│   ├── db/pool.js                     # PostgreSQL connection pool
│   ├── db/audit.js                    # Append-only audit_log helper
│   ├── queue/connection.js            # RabbitMQ with retry
│   ├── queue/publisher.js             # PROCESS_DOCUMENTS publisher
│   ├── queue/consumer.js              # Queue consumer (logs for Phase 2)
│   ├── crypto/jwt.js                  # RS256 from base64 env vars
│   ├── crypto/hmac.js                 # HMAC-SHA256 sign/verify
│   └── logger.js                      # Winston structured logging
│
└── migrations/                        # 11 SQL migration files
    ├── 001_create_extensions.sql
    ├── 002_create_enums.sql
    ├── 003_create_partners.sql        # Includes webhook_url, webhook_secret
    ├── 004_create_practitioners.sql    # TM-WW-YY-NNNN CHECK constraint
    ├── 005_create_verification_sessions.sql  # used_at column (no delete)
    ├── 006_create_legal_declarations.sql
    ├── 007_create_documents.sql
    ├── 008_create_cnom_verifications.sql
    ├── 009_create_phone_verifications.sql
    ├── 010_create_audit_log.sql
    └── 011_create_append_only_triggers.sql   # UPDATE/DELETE blocked
```

---

## Endpoints

### `GET /health`
**Purpose:** Health check.

**Response:**
```json
{"status":"ok","service":"trustmed","timestamp":"2026-05-02T03:00:00.000Z"}
```

---

### `GET /oauth/authorize`
**Purpose:** Initiate OAuth2 Authorization Code Flow. Partner redirects doctor here.

**Query Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `client_id` | string | ✅ | Partner's registered client_id |
| `redirect_uri` | string (URL) | ✅ | Must exactly match partner's whitelist |
| `scope` | string | ✅ | Space or `+` separated scopes |
| `state` | string | ✅ | CSRF token, passed through untouched |
| `response_type` | string | ✅ | Must be `"code"` |

**Success:** `302 Redirect` to `VERIFICATION_PORTAL_URL?session_id=UUID&client_id=...`

**Errors:**
- `400 invalid_client` — Unknown client_id
- `400 invalid_redirect_uri` — redirect_uri not in partner whitelist
- `400 invalid_scope` — Requested scope not allowed
- `400 validation_error` — Missing or malformed parameters

---

### `POST /oauth/token`
**Purpose:** Exchange authorization code for JWT access token. Rate limited: 10 req/min/IP.

**Body (x-www-form-urlencoded or JSON):**
| Param | Type | Required | Description |
|---|---|---|---|
| `client_id` | string | ✅ | Partner's client_id |
| `client_secret` | string | ✅ | Plaintext secret (compared against bcrypt hash) |
| `code` | string | ✅ | Authorization code (64-char hex) |
| `redirect_uri` | string (URL) | ✅ | Must match original authorize request |

**Success Response:**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiI...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "practitioner_id": "TM-19-26-0847",
  "verification_status": "IDENTITY_PENDING",
  "trust_score": 0,
  "badge_level": "NONE"
}
```

**JWT Payload (RS256, 1hr expiry):**
```json
{
  "sub": "practitioner-uuid",
  "partner_id": "partner-uuid",
  "scopes": ["identity", "cnom"],
  "trust_score": 94,
  "badge_level": "FULLY_VERIFIED",
  "iss": "trustmed",
  "iat": 1777693710,
  "exp": 1777697310
}
```

**Errors:**
- `400 invalid_client` — Unknown client_id or wrong secret
- `400 invalid_grant` — Code expired, already used, or wrong redirect_uri
- `429 too_many_requests` — Rate limit exceeded

**Security:** Auth codes are marked `used_at = NOW()` on exchange (preserving audit trail), never deleted. Replay attacks are prevented by checking `used_at IS NULL`.

---

### `GET /v1/practitioner/me`
**Purpose:** Returns practitioner profile filtered by JWT scopes.

**Headers:** `Authorization: Bearer <access_token>`

**Response (with scopes `identity` + `cnom`):**
```json
{
  "practitioner_id": "TM-19-26-0847",
  "verification_status": "FULLY_VERIFIED",
  "trust_score": 94,
  "badge_level": "FULLY_VERIFIED",
  "verified_at": "2026-05-02T03:30:00.000Z",
  "full_name": "Dr. Ahmed Benmoussa",
  "specialty": "Cardiologie",
  "wilaya_code": 19,
  "cnom_number": "19-22-0847"
}
```

**Errors:** `401 unauthorized` — Missing or invalid token.

---

### `POST /v1/partner/register`
**Purpose:** Register a new partner application.

**Body (JSON):**
```json
{
  "name": "Doctome.dz",
  "client_id": "doctome_prod",
  "client_secret": "super_secret_password",
  "redirect_uris": ["https://doctome.dz/callback"],
  "allowed_scopes": ["identity", "cnom"],
  "webhook_url": "https://doctome.dz/webhook",
  "webhook_secret": "webhook_hmac_key"
}
```

**Response:** `201 Created` with partner details (secret never returned).

---

## Verification Engine — State Machine

| # | Step | Status Transition | Trust Δ | Total | Side Effect |
|---|---|---|---|---|---|
| 1 | `NFC_COMPLETE` | IDENTITY_PENDING → IDENTITY_CONFIRMED | +30 | 30 | Updates NFC hash |
| 2 | `DECLARATION_SIGNED` | (no change) | +15 | 45 | Legal vault HMAC record |
| 3 | `DOCUMENTS_UPLOADED` | IDENTITY_CONFIRMED → PROVISIONAL | +0 | 45 | RabbitMQ PROCESS_DOCUMENTS job |
| 4 | `CNOM_CONFIRMED` | PROVISIONAL → CNOM_CONFIRMED | +35 | 80 | CNOM record + webhook |
| 5 | `PHONE_OTP_VERIFIED` | CNOM_CONFIRMED → FULLY_VERIFIED | +14 | 94 | Phone record + webhook |
| 6 | `DOCUMENT_CLEAN` | (no change) | +6 | 100 | Updates document status |

### Badge Levels

| Score | Badge |
|---|---|
| 0–29 | NONE |
| 30–44 | IDENTITY_VERIFIED |
| 45–79 | CNOM_CONFIRMED |
| 80–93 | CNOM_CONFIRMED_PLUS |
| 94–100 | FULLY_VERIFIED |

---

## Database — 8 Tables + 2 Append-Only Triggers

| Table | PK | Append-Only | Key Feature |
|---|---|---|---|
| `partners` | UUID | No | bcrypt client_secret, webhook_url/secret |
| `practitioners` | UUID | No | `TM-WW-YY-NNNN` CHECK, ENUM status |
| `verification_sessions` | UUID | No | `used_at` instead of delete |
| `legal_declarations` | UUID | **Yes** | HMAC-SHA256 signed, triggers block UPDATE/DELETE |
| `documents` | UUID | No | OCR results, fraud_flags JSONB |
| `cnom_verifications` | UUID | No | Result: CONFIRMED/PROVISIONAL/MISMATCH |
| `phone_verifications` | UUID | No | bcrypt OTP hash |
| `audit_log` | BIGSERIAL | **Yes** | triggers block UPDATE/DELETE |

---

## Security Checklist

| Requirement | Status |
|---|---|
| client_secret stored as bcrypt hash (saltRounds=12) | ✅ |
| auth_code: `crypto.randomBytes(32).toString('hex')` | ✅ |
| auth_code expires in 60 seconds, single use via `used_at` | ✅ |
| redirect_uri: exact string match against whitelist | ✅ |
| state parameter passed through untouched | ✅ |
| JWT: RS256 asymmetric, 1hr expiry, correct payload | ✅ |
| Input validation: Zod on all endpoints | ✅ |
| Rate limiting: 10 req/min/IP on /oauth/token | ✅ |
| Structured logging: Winston (timestamp+level+service) | ✅ |
| Audit trail: every action → append-only audit_log | ✅ |
| RSA keys: base64 in .env only, no .pem files | ✅ |
| Legal vault: HMAC-SHA256, triggers prevent UPDATE/DELETE | ✅ |
| Webhook: HMAC-SHA256 signed payloads | ✅ |

---

## Verified Tests

| Test | Result |
|---|---|
| All 23 JS files pass `node -c` syntax check | ✅ |
| TrustScoreCalculator: NFC→30, +DECL→45, +DOCS→45, +CNOM→80, +PHONE→94, +CLEAN→100 | ✅ |
| JWT RS256: sign with private key, verify with public key | ✅ |
| HMAC: sign data, verify same data = true, verify tampered = false | ✅ |
| RSA keys: base64 encode → decode → sign → verify roundtrip | ✅ |

---

## What Each User Correction Changed

1. **Trust Score Fix:** `DOCUMENTS_UPLOADED` awards 0 points. New `DOCUMENT_CLEAN` step awards +6 (triggered by OCR service later).
2. **Partners Table:** Added `webhook_url VARCHAR(500)` and `webhook_secret VARCHAR(255)`. `WebhookDispatcher` reads from partners table.
3. **Verification Sessions:** Added `used_at TIMESTAMPTZ`. Auth codes are marked used (not deleted). Query checks `auth_code_exp > NOW() AND used_at IS NULL`.
4. **RSA Keys:** No `shared/crypto/keys/` folder. `generate-keys.js` prints to console only. `.env` stores base64 strings. `*.pem` in `.gitignore`.
