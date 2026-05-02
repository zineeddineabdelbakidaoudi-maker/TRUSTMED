# TrustMed — Medical Practitioner Verification Engine

> "Sign in with Google" — but for verifying that a doctor is real, licensed, and practicing in Algeria.

TrustMed is an identity and qualification verification API for the Algerian digital health market. Third-party platforms redirect practitioners to TrustMed for verification via OAuth2 Authorization Code Flow, and receive signed trust tokens in return.

---

## Quick Start

### Prerequisites

- **Docker** & **Docker Compose** (v2+)
- **Node.js** 20+ (for running scripts outside Docker)

### 1. Clone & Configure

```bash
cp .env.example .env
```

### 2. Generate RSA Keys

```bash
node generate-keys.js
```

Copy the two base64 strings printed to console into your `.env` file as `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`.

### 3. Start Infrastructure

```bash
docker-compose up -d postgres redis rabbitmq
```

Wait a few seconds for services to become healthy.

### 4. Install Dependencies

```bash
npm install
```

### 5. Run Database Migrations

```bash
node migrate.js
```

This creates all 8 tables, ENUMs, indexes, and append-only triggers.

### 6. Seed Test Data

```bash
node seed.js
```

Creates a test partner (`test_client_001`) and practitioner (`TM-19-26-0847`).

### 7. Start the API Server

```bash
node server.js
```

Server starts on `http://localhost:8000`.

### Full Docker Start (Alternative)

```bash
docker-compose up --build
```

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/oauth/authorize` | GET | Initiate OAuth2 authorization flow |
| `/oauth/token` | POST | Exchange auth code for JWT access token |
| `/v1/practitioner/me` | GET | Get practitioner profile (Bearer auth) |
| `/v1/partner/register` | POST | Register a new partner application |

---

## Testing with curl

### Health Check

```bash
curl http://localhost:8000/health
```

### Register a Partner

```bash
curl -X POST http://localhost:8000/v1/partner/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "TestApp",
    "client_id": "my_test_app",
    "client_secret": "my_secure_secret_123",
    "redirect_uris": ["http://localhost:3001/callback"],
    "allowed_scopes": ["identity", "cnom"],
    "webhook_url": "http://localhost:3001/webhook"
  }'
```

### OAuth2 Authorize (Redirect Flow)

```bash
curl -v "http://localhost:8000/oauth/authorize?client_id=test_client_001&redirect_uri=http://localhost:3001/callback&scope=identity+cnom&state=abc123csrf&response_type=code"
```

**Expected:** 302 redirect to verification portal with `session_id`.

#### Invalid client_id:

```bash
curl "http://localhost:8000/oauth/authorize?client_id=UNKNOWN&redirect_uri=http://localhost:3001/callback&scope=identity&state=abc123csrf&response_type=code"
```

**Expected:** 400 `{"error":"invalid_client"}`

#### Invalid redirect_uri:

```bash
curl "http://localhost:8000/oauth/authorize?client_id=test_client_001&redirect_uri=http://evil.com/steal&scope=identity&state=abc123csrf&response_type=code"
```

**Expected:** 400 `{"error":"invalid_redirect_uri"}`

### Token Exchange

After running `node seed.js`, use the auth_code printed to console:

```bash
curl -X POST http://localhost:8000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=test_client_001&client_secret=secret123&code=AUTH_CODE_FROM_SEED&redirect_uri=http://localhost:3001/callback"
```

**Expected:** JWT access_token with practitioner data.

#### Expired code test:

Wait 60+ seconds after seeding, then retry. **Expected:** 400 `{"error":"invalid_grant","message":"Authorization code has expired"}`

#### Replay attack test:

Use the same code twice. **Expected:** 400 `{"error":"invalid_grant","message":"Authorization code has already been used"}`

### Practitioner Profile

```bash
curl http://localhost:8000/v1/practitioner/me \
  -H "Authorization: Bearer JWT_TOKEN_FROM_ABOVE"
```

**Expected:** Practitioner profile filtered by JWT scopes.

### Rate Limiting Test

```bash
for i in $(seq 1 11); do
  echo "Request $i:"
  curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8000/oauth/token \
    -d "client_id=test&client_secret=test&code=test&redirect_uri=http://test.com"
  echo ""
done
```

**Expected:** Requests 1-10 return 400 (bad credentials), request 11 returns 429.

---

## Database Schema

8 tables with UUID primary keys:

| Table | Purpose |
|---|---|
| `partners` | Registered partner applications |
| `practitioners` | Doctor/practitioner profiles |
| `verification_sessions` | OAuth2 sessions with auth codes |
| `legal_declarations` | **Append-only** signed legal records |
| `documents` | Uploaded documents for OCR |
| `cnom_verifications` | CNOM scraper results |
| `phone_verifications` | Phone OTP records |
| `audit_log` | **Append-only** audit trail |

### Append-Only Enforcement

`legal_declarations` and `audit_log` have PostgreSQL triggers that raise exceptions on UPDATE or DELETE:

```sql
-- Test it:
UPDATE legal_declarations SET declaration_text='x' WHERE id='...';
-- ERROR: Updates to legal_declarations are forbidden.

DELETE FROM legal_declarations WHERE id='...';
-- ERROR: Deletes from legal_declarations are forbidden.
```

---

## Verification Engine

The `VerificationEngine` class processes 6 steps:

| Step | Status Change | Trust Score | Side Effect |
|---|---|---|---|
| `NFC_COMPLETE` | → IDENTITY_CONFIRMED | +30 | — |
| `DECLARATION_SIGNED` | (no change) | +15 | Legal vault record |
| `DOCUMENTS_UPLOADED` | → PROVISIONAL | +0 | RabbitMQ job |
| `DOCUMENT_CLEAN` | (no change) | +6 | — |
| `CNOM_CONFIRMED` | → CNOM_CONFIRMED | +35 | Webhook |
| `PHONE_OTP_VERIFIED` | → FULLY_VERIFIED | +14 | Webhook |

**Maximum trust score: 100**

---

## Project Structure

```
TRUSTMEDZ/
├── server.js                    # Express entry point
├── docker-compose.yml           # Docker stack
├── migrate.js                   # Database migration runner
├── seed.js                      # Test data seeder
├── generate-keys.js             # RSA keypair generator
├── services/
│   ├── auth/                    # OAuth2 + JWT + partner registry
│   │   ├── routes/
│   │   ├── middleware/
│   │   └── schemas/
│   ├── verification/            # State machine + trust score
│   ├── legal-vault/             # Append-only legal records
│   └── webhook/                 # HMAC-signed webhook dispatch
├── shared/
│   ├── db/                      # PostgreSQL pool + audit
│   ├── queue/                   # RabbitMQ connection + consumer
│   ├── crypto/                  # JWT RS256 + HMAC-SHA256
│   └── logger.js                # Winston structured logging
└── migrations/                  # SQL migration files (001-011)
```

---

## Security

- **client_secret**: bcrypt hashed (saltRounds=12)
- **auth_code**: `crypto.randomBytes(32).toString('hex')`, 60s TTL, single use via `used_at`
- **redirect_uri**: exact string match against partner whitelist
- **JWT**: RS256 asymmetric signing, 1hr expiry
- **Rate limiting**: 10 req/min/IP on `/oauth/token` (Redis-backed)
- **Input validation**: Zod schemas on all endpoints
- **Audit trail**: append-only `audit_log` table
- **Legal vault**: HMAC-SHA256 signed, UPDATE/DELETE blocked by triggers
- **RSA keys**: base64 in .env only, never stored as files

---

## License

Proprietary — TrustMed Project, Track B — Digital Health Trust Layer.
