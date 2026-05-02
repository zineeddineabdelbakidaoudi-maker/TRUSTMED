# TrustMed — Complete Developer & Product Brief
### For: Backend Engineer (Verification Engine Team)
### Version: 1.0 | Project: Track B — Digital Health Trust Layer

---

## 1. What Is TrustMed?

TrustMed is an **identity and qualification verification API** built specifically for the Algerian digital health market. It functions as a trust infrastructure layer — the same way PayPal handles payments or Google handles authentication — but instead of money or login, TrustMed handles **doctor and practitioner trust**.

Any health platform (telemedicine app, medical marketplace, lab booking service) can integrate TrustMed with a single redirect. Their users are sent to the TrustMed verification portal, go through the full verification flow, and are redirected back with a signed trust token. The partner platform never touches a single document or biometric.

**The one-line summary:**  
> "Sign in with Google" — but for verifying that a doctor is real, licensed, and practicing in Algeria.

---

## 2. The Problem We Are Solving

### The Fatal Paradox of Digital Health Platforms

Algerian healthcare platforms face a structural impossibility when onboarding doctors:

- **If they verify too slowly** (manual office visits, human document reviews) → legitimate doctors get frustrated and leave, platform growth stalls, competitors win
- **If they verify too quickly** (no checks) → fraudsters slip through, patients get harmed, the platform is destroyed by one scandal

This is called the **Trust Bottleneck**. Every health platform in Algeria is either strangled by it or recklessly ignoring it.

### The Deeper Problem: No Government API Exists

Unlike Europe or the US, Algeria has no publicly accessible digital registry where a platform can query:
- "Is CNOM number 19-22-0847 a real, active doctor?"
- "Is this diploma from Université de Sétif authentic?"

This means every platform that tries to verify doctors either:
1. Calls the Ministry of Health manually (weeks of delay, doesn't scale)
2. Accepts documents at face value and hopes for the best (dangerous)
3. Builds nothing and gets destroyed by the first fraud case

**TrustMed solves this by building the verification infrastructure that the government has not built yet.**

---

## 3. The Core Insight: Legal Deterrence Over Perfect Detection

Most verification systems try to **catch** fraudsters technically. TrustMed uses a different philosophy:

> **Make fraud structurally irrational by tying it to a verified real identity with criminal liability.**

A fraudster who knows that:
- Their biometric passport data has been captured
- Their face has been matched to their chip photo
- They have signed a legal declaration with their real national ID number
- That declaration explicitly references Art. 243 Code Pénal Algérien (usurpation de titre: 1–3 years imprisonment)
- TrustMed retains a tamper-proof evidence package permanently

...will not attempt fraud. The deterrence does the verification work. We do not need to catch them in real time — we already have everything needed to destroy them legally if discovered at any point in the future.

**Real doctors have nothing to fear. Fraudsters have everything to lose.**

---

## 4. The Five Verification Methods (The Full Stack)

### Method 1 — Google Maps Ground Truth Database (Pre-built, invisible to doctor)

Before any doctor registers, the platform has already harvested every medical establishment in Algeria using the Google Places API and professional scrapers.

**Data collected per clinic:**
- Clinic/cabinet name
- Address (wilaya, commune, street)
- Known landline phone number
- Specialty category
- Number of reviews and creation date (fraud signal: new listings with 0 reviews are flagged)

**Purpose:** When a doctor claims to practice at a specific clinic, the system already knows if that clinic exists. This is the baseline existence check — it doesn't verify the doctor, it verifies the place.

**Vulnerability:** Google Maps listings are user-submitted and can be faked. This is why it is used as a supporting signal only, never as a primary gate.

---

### Method 2 — NFC Passport / CNIB Chip Verification (Identity Anchor)

Algeria issues ICAO 9303-compliant biometric passports and Carte Nationale d'Identité Biométrique (CNIB). Both contain NFC chips with cryptographic security mechanisms.

**Technical flow:**
1. Doctor photographs the MRZ (Machine Readable Zone) at the bottom of their passport/ID using their phone camera
2. The MRZ data becomes the cryptographic key that unlocks the chip (Basic Access Control / PACE protocol) — the chip cannot be read without the physical document present
3. Doctor taps their document to their phone's NFC sensor
4. System reads Data Groups from chip: full name, date of birth, document number, facial photo (DG2)
5. Passive Authentication: system verifies the chip's digital signature chain back to Algeria's Country Signing CA — any field altered since issuance fails immediately
6. Active Authentication: chip signs a random challenge with its private key (never extractable) — proves the chip is the original, not a clone
7. Liveness selfie: doctor takes a real-time photo — system compares face embedding against the biometric photo stored in the chip's DG2 (threshold: >95% similarity)

**What this proves:** The person registering is a real, living, identifiable human whose biometric identity is cryptographically confirmed. It does NOT prove they are a doctor — that comes in Method 4.

**Fallback for non-NFC phones:** Approximately 15–20% of older Algerian phones lack NFC. These users go through an enhanced manual review path with video call verification.

---

### Method 3 — Legal Liability Declaration (Deterrence Engine)

After NFC identity is confirmed, the doctor is presented with a full legal declaration screen before any document upload.

**Declaration screen behavior:**
- Cannot be scrolled past in under 45 seconds (JavaScript enforced timer)
- Auto-fills the doctor's real name and CIN number from NFC data — they cannot change it
- Doctor must actively tick a checkbox (not pre-ticked): "I accept full criminal and civil liability for any false declaration"
- References Art. 243 Code Pénal Algérien explicitly in the text

**What the system records at the moment of signing:**
```
{
  identity_hash:        SHA-256 of NFC chip UID
  full_name:            from NFC chip (unalterable)
  cin_number:           from NFC chip (unalterable)
  selfie_vector_hash:   hash of face embedding
  declaration_text:     full legal text they agreed to
  timestamp:            ISO 8601 UTC
  ip_address:           IPv4/IPv6 of the session
  device_fingerprint:   browser, OS, screen resolution, timezone
  geolocation:          wilaya-level location
  hmac_signature:       HMAC-SHA256 of all above fields using platform secret key
}
```

This record is stored in an **append-only database table** with PostgreSQL triggers that physically prevent any UPDATE or DELETE operation. It is a permanent legal dossier.

**Key insight:** This record is admissible evidence in an Algerian court. If fraud is discovered tomorrow, in 6 months, or in 5 years — TrustMed hands this package to the relevant prosecutor. The platform does not need to have detected the fraud in real time.

---

### Method 4 — Silent Background CNOM Verification (Qualification Proof)

This is the most technically sophisticated step. It runs entirely in the background — the doctor experiences nothing. After documents are uploaded, an automated pipeline activates silently.

**Pipeline stages:**

**Stage A — OCR Extraction (Azure Document Intelligence)**
- Analyzes uploaded diploma, CNOM inscription card, and cabinet agrément
- Extracts: full name, CNOM number, specialty code, graduation year, issuing university
- Doctor types nothing manually — all fields are extracted automatically
- Confidence score assigned to each field
- Arabic and French dual-language processing

**Stage B — CNOM Format Validation (instant)**
- CNOM numbers follow a known structure: `[Wilaya Code 2 digits]-[Year 2 digits]-[Sequence 4 digits]-[Specialty Suffix]`
- Example: `19-22-0847-MG` = Wilaya 19 (Sétif), year 2022, sequence 847, Médecine Générale
- Invalid format → immediate anomaly flag, routed to human review
- Valid format → proceeds to scraper

**Stage C — Headless Web Scraper (Playwright/Puppeteer)**
- Silently queries CNOM and regional SORM web directories using the extracted CNOM number
- Targets include: sormdalger.com, sorm-blida.dz, crom-tiziouzou.dz, sorm-cne.dz, and all 48 wilaya SORM portals
- Mimics human browsing behavior (rotated user agents, respectful rate limiting)
- Extracts: registered name, specialty, wilaya, current status (active/suspended)

**Stage D — Cross-Match Against NFC Identity**
- Scraped name vs. NFC chip name: fuzzy match required (≥88% similarity, handles Arabic diacritics and transliteration variations)
- Scraped CNOM number vs. OCR-extracted CNOM: exact match required
- Scraped specialty vs. diploma specialty: must align

**Outcomes:**
- All three match → badge silently upgrades to "CNOM Confirmed" — doctor just sees a new badge appear
- Partial match or scraper timeout → profile stays PROVISIONAL, anomaly routed to internal review queue — doctor experiences nothing, profile stays active
- Hard mismatch → ANOMALY_FLAGGED → profile frozen, compliance team alerted

---

### Method 5 — Phone OTP to Clinic Landline (Physical Presence Proof)

A profile verified through Methods 1–4 is activated in PROVISIONAL mode (text consultations only). To unlock the full profile, the platform calls the clinic's known landline.

**Critical design decision:** The system calls the phone number from the Google Maps database — NOT the mobile number the doctor provided. This means a fraudster must physically control the real clinic's landline, which is operationally very difficult.

**Flow:**
1. System finds the clinic in the pre-built Google Maps database using the doctor's claimed address
2. Displays to doctor: "We will call this number: +213 XX XX XX XX — is this correct?"
3. Call is scheduled at a randomized delay (15–45 minutes, unpredictable — makes interception harder)
4. Automated voice call delivers a 6-digit OTP spoken in both Arabic and French
5. Doctor enters OTP in portal
6. On success → full profile unlocked, badge upgrades to "Fully Verified ✅"

**On three consecutive failures:** Routed to human reviewer, who may accept an alternative (video call showing clinic interior with license visible on wall).

---

## 5. The Trust Score System

Every practitioner has a live Trust Score (0–100) calculated from all verified signals:

| Signal | Points | Condition |
|--------|--------|-----------|
| NFC Identity Anchor | +30 | Passive + Active Authentication passed, liveness matched |
| Legal Declaration Signed | +15 | Signed with real NFC-confirmed identity, HMAC sealed |
| CNOM Scraper Confirmed | +35 | Three-way cross-match passed |
| Phone OTP Verified | +14 | Clinic landline OTP answered correctly |
| Clean Document Check | +6 | No fraud flags raised by pattern analysis |
| **Maximum** | **100** | All signals confirmed |

**Badge levels by score:**

| Score | Badge | Profile Capabilities |
|-------|-------|---------------------|
| 0–29 | None | Not visible to patients |
| 30–44 | Identity Verified | Internal only |
| 45–79 | CNOM Confirmed | Text consultations only |
| 80–93 | CNOM Confirmed + | Text + video consultations |
| 94–100 | Fully Verified ✅ | All features unlocked |

---

## 6. How the API Works (OAuth2 Authorization Code Flow)

TrustMed functions as an Identity Provider (IdP) using the OAuth2 Authorization Code Flow — the same protocol used by "Sign in with Google" or "Pay with PayPal."

### The Integration Flow

```
Step 1 — Partner redirects doctor to TrustMed:
  GET https://verify.trustmed.dz/oauth/authorize
    ?client_id=PARTNER_APP_ID
    &redirect_uri=https://partner-platform.dz/callback
    &scope=identity+cnom+clinic
    &state=RANDOM_CSRF_TOKEN
    &response_type=code

Step 2 — Doctor completes verification on TrustMed portal
  (NFC → Declaration → Documents → CNOM scraper → Phone OTP)

Step 3 — TrustMed redirects back to partner:
  https://partner-platform.dz/callback
    ?code=ONE_TIME_AUTH_CODE (expires in 60 seconds)
    &state=SAME_CSRF_TOKEN

Step 4 — Partner backend exchanges code for token (server-to-server):
  POST https://api.trustmed.dz/oauth/token
    { client_id, client_secret, code, redirect_uri }

Step 5 — TrustMed returns:
  {
    access_token: "eyJhbGci...",
    token_type: "Bearer",
    expires_in: 3600,
    practitioner_id: "TM-19-2022-0847",
    verification_status: "CNOM_CONFIRMED",
    trust_score: 94,
    badge_level: "FULLY_VERIFIED",
    specialty: "Cardiologie",
    wilaya: "Sétif",
    verified_at: "2026-05-02T01:34:00Z"
  }
```

### API Endpoints (Full List)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/oauth/authorize` | GET | Initiates verification flow, validates partner credentials |
| `/oauth/token` | POST | Exchanges auth code for access token |
| `/v1/practitioner/me` | GET | Returns full verification profile (Bearer token required) |
| `/v1/badge/verify/:id` | GET | Public endpoint — validates a badge for patients |
| `/v1/webhook/configure` | POST | Partner registers their webhook URL |
| `/v1/partner/register` | POST | Register a new partner application |

### Security Rules (Non-Negotiable)

- `client_secret` stored as bcrypt hash (saltRounds=12), never in plaintext
- `auth_code` expires in 60 seconds, single use only — deleted after exchange
- `redirect_uri` validated as exact string match against partner whitelist — no wildcards
- `state` parameter passed through untouched (CSRF protection — partner validates it matches)
- JWT signed RS256 asymmetric keys, expires in 1 hour
- All inputs validated with Zod before touching the database
- Rate limiting: 10 requests/minute/IP on `/oauth/token`
- Every database action writes to immutable audit_log

---

## 7. Database Architecture

Eight tables form the complete data model. Two of them (legal_declarations and audit_log) are **append-only** — PostgreSQL triggers physically prevent UPDATE and DELETE operations on them, making them permanent legal records.

### Table Relationships

```
partners (1) ──────────────────── (many) verification_sessions
practitioners (1) ─────────────── (many) verification_sessions
practitioners (1) ─────────────── (many) legal_declarations
practitioners (1) ─────────────── (many) documents
practitioners (1) ─────────────── (many) cnom_verifications
practitioners (1) ─────────────── (many) phone_verifications
practitioners (1) ─────────────── (many) audit_log rows
partners      (1) ─────────────── (many) audit_log rows
```

### Verification Status Flow

```
IDENTITY_PENDING
    ↓ (NFC + liveness passed)
IDENTITY_CONFIRMED
    ↓ (declaration signed + documents uploaded)
PROVISIONAL  ←── doctor gets initial token here, profile goes live (limited)
    ↓ (CNOM scraper confirms match)
CNOM_CONFIRMED  ←── badge upgrades silently, partner notified via webhook
    ↓ (phone OTP to clinic verified)
FULLY_VERIFIED  ←── full profile unlocked, all features enabled

At any point:
    → FLAGGED  (anomaly detected, internal review)
    → SUSPENDED  (fraud confirmed or admin action)
```

---

## 8. Microservices Architecture

The backend is organized as independent microservices communicating via a message queue (RabbitMQ). Each service has a single responsibility and can be scaled independently.

### Services

| Service | Responsibility | Key Tech |
|---------|---------------|----------|
| `auth` | OAuth2 server, JWT generation, partner registry | Node.js, Express, jsonwebtoken |
| `verification` | State machine, trust score, status transitions | Node.js |
| `ocr` | Document processing, field extraction | Python, Azure Document Intelligence |
| `scraper` | Headless CNOM portal queries | Node.js, Playwright |
| `nfc` | Passport chip validation, ICAO 9303 | Node.js, dedicated library |
| `otp` | Clinic phone call scheduling and verification | Node.js, Twilio Voice API |
| `legal-vault` | Append-only evidence records, HMAC signing | Node.js, PostgreSQL |
| `webhook` | Partner notification dispatch, HMAC-signed payloads | Node.js |
| `gateway` | Single entry point, rate limiting, routing | Kong or custom Express |

### Infrastructure Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Database | PostgreSQL 16 | Primary data store |
| Cache / Session | Redis 7 | Auth code TTL, rate limiting state |
| Message Queue | RabbitMQ 3 | Async job processing (OCR, scraper) |
| Document Storage | MinIO (S3-compatible) | Encrypted document files |
| Container Orchestration | Docker Compose (dev) → Kubernetes (prod) | Service management |
| Monitoring | Prometheus + Grafana | Metrics and alerting |

---

## 9. The Ongoing Trust System (Post-Verification)

Verification is not a one-time event. TrustMed maintains trust continuously:

- **Monthly spot-audits:** 8% of all active profiles are re-verified silently each month
- **90-day CNOM re-check:** The scraper re-pings CNOM directories quarterly (catches suspensions, license non-renewals)
- **License expiry alerts:** Automated SMS and email to practitioners 60 days before any document expires
- **Patient complaint trigger:** Any verified patient complaint activates an immediate provisional freeze and human review within 24 hours
- **Fraud prosecution:** Confirmed fraud cases → legal dossier handed to prosecutors. Platform publicly pursues every confirmed case to maintain deterrence credibility.

---

## 10. Partner Integration Tiers

| Tier | What Partners Get | Target Customer |
|------|------------------|-----------------|
| **Starter** | Redirect flow + basic identity token + developer docs | Small clinics, new startups |
| **Pro** | Full verification token + webhook status updates + badge embed widget | Mid-size platforms (Doctome-scale) |
| **Enterprise** | White-label portal (TrustMed flow, partner branding) + SLA guarantee + dedicated scraper priority + custom scopes | Large hospital networks, ministry pilots |

---

## 11. The Badge Embed Widget

Partners can display TrustMed verification status on their own platform with a single line of code:

```html
<script src="https://cdn.trustmed.dz/badge.js"
        data-practitioner-id="TM-19-2022-0847">
</script>
```

This renders a verified badge showing: badge level, specialty, last verification date, and a link to the public TrustMed certificate. The partner stores no verification data — all truth lives in TrustMed.

---

## 12. Phase Build Plan

### Phase 1 — The Foundation (Week 1–2)
- Project structure and Docker Compose setup
- All database tables with migrations (including append-only triggers)
- OAuth2 server: `/oauth/authorize`, `/oauth/token`, `/v1/practitioner/me`
- Partner registry (register partners, store bcrypt-hashed secrets)
- JWT RS256 generation and validation
- Full audit logging on every action

### Phase 2 — The Verification Engine (Week 2–3)
- State machine (`VerificationEngine` class) handling all 5 status transitions
- Trust score calculator (weighted, all 5 signals)
- Legal Vault service (HMAC-signed, append-only record creation)
- RabbitMQ queue setup + consumer for `PROCESS_DOCUMENTS` jobs
- Webhook dispatcher (HMAC-signed POST to partner URLs on status changes)

### Phase 3 — Intelligence Services (Week 3–5)
- OCR Service (Azure Document Intelligence, Arabic/French, CNOM format validator)
- CNOM Scraper Service (Playwright, all 48 wilaya SORM portals, fuzzy name match)
- NFC Validator Service (ICAO 9303 Passive + Active Authentication)
- OTP Dialer Service (Twilio Voice, randomized delay, bilingual message)

### Phase 4 — Hardening & Integration (Week 5–6)
- Rate limiting, input validation (Zod), RBAC
- End-to-end integration test: full doctor verification flow
- Penetration test: OAuth CSRF, code replay, token leakage
- Load testing: scraper + OCR under concurrent load
- API documentation for frontend team

---

## 13. Current Trust Score Assessment

The system as designed achieves an estimated **93/100** trust reliability:

| Gap | Points Lost | Resolution Path |
|----|-------------|-----------------|
| CNOM portal data inconsistency across wilayas | -3 | Add human review fallback for sparse regions |
| Stolen identity with valid biometric doc (extremely rare) | -2 | Liveness check + behavioral signals mitigate this |
| Phone OTP physical interception window | -2 | Closed by formal CNOM MOU (future phase) |

Reaching 99/100 requires a formal data-sharing agreement with CNOM — achievable once the platform has scale and demonstrated track record. The infrastructure is designed to plug in a direct API call the moment that agreement exists, replacing the headless scraper with zero other changes.

---

*Document prepared for the TrustMed backend engineering team. All architecture decisions reflect the constraints of the Algerian healthcare regulatory environment as of 2026.*
