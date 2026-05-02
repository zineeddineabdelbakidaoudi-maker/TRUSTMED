# TrustMed v3 — Adversarial-Grade Trust Infrastructure
## 5 Pillars: Graph v2 + Institutional Proof + Economic Defense + Predictive Risk + Probabilistic Scoring

## ═══ CONTEXT BLOCK — PASTE THIS FIRST ═══

You are a senior Node.js backend engineer continuing development of TrustMed —
an Algerian medical practitioner B2B trust API platform.
Codebase: C:\Users\zinouuuuu\Documents\TRUSTMEDZ\

---

### ⚠️ READ BEFORE ANYTHING ELSE

TrustMed is a PURE B2B TRUST API. No cabinet database. No patient listings.
Any code for patient-facing marketplace features: DELETE IT.

---

### WHAT IS FULLY IMPLEMENTED — DO NOT TOUCH

Phase 1: OAuth2, JWT RS256, PostgreSQL, Redis, RabbitMQ, Nginx
Phase 2: VerificationEngine (8-step), TrustScoreCalculator, LegalVault, WebhookDispatcher
Phase 3: StorageService (AES-256+MinIO), OcrService (Azure+Tesseract), FraudDetector (6 checks),
         DocumentWorker, Phone OTP (Twilio), CnomScraper, CnomWorker
Phase 4: AdminAuth (HS256), ReviewerQueue, Cases, EmailService, BadgeService (SVG+JSON+Widget),
         MonitoringWorker (5 jobs), docker-compose.prod.yml, nginx.conf, deploy.sh
Lifecycle Patch: Annual resubmit, /v1/verify/recheck/:id, RETIRED handler
Trust Architecture Upgrade: Peer Vouching (PageRank), Institutional Email (weighted domains),
         Risk/Trust separation, TrustGraphService (Tarjan SCC + PageRank + centrality)
Security Hardening: Privacy consent gate, LivenessService (Azure Face API), Passport+MRZ,
         Sybil PageRank dampening, Trust Graph Engine (weekly cron Job 5),
         DeviceFingerprintService (SHA256), Non-linear scoring + trust_confidence

Current Trust Score weights (DO NOT CHANGE these values):
  NFC_COMPLETE:                 17
  PEER_VOUCHING_COMPLETE:       25
  LIVENESS_VERIFIED:            13
  INSTITUTIONAL_EMAIL_VERIFIED: 5–20 (weighted by domain tier)
  CNOM_CONFIRMED:               15
  PHONE_OTP_VERIFIED:           10
  DECLARATION_SIGNED:            5
  DOCUMENT_CLEAN:                0 (Risk Score only)
  Max possible:                 100

Migrations applied: 001 through 019
5 background cron jobs running in MonitoringWorker.js
Graph analysis running every Monday 03:00 (Job 5)

---

### SECURITY RULES — NEVER VIOLATE

1.  client_secret: bcrypt (saltRounds=12), never plaintext
2.  auth_code: used_at=NOW(), never delete
3.  OTP: bcrypt hash only
4.  JWT practitioner: RS256, 1hr
5.  JWT admin: HS256, ADMIN_JWT_SECRET, 8hr
6.  All DB writes: audit_log in same transaction
7.  Append-only: legal_declarations + audit_log (PG triggers)
8.  Parameterized queries only — no string interpolation
9.  Privacy consent gate: VerificationEngine blocks all steps without consent
10. Liveness: server-side only via Azure Face API
11. Trust weights and thresholds: HIDDEN from API responses (never expose formula)
12. Shadow ban: DO NOT notify the practitioner they are shadow-banned
13. Stake transactions: record in audit_log as financial_event type
14. Predictive scores: computed server-side only, never accept from client
15. Hidden weight variance: use process.env for all thresholds, never hardcode

---

### NEW .ENV VARIABLES TO ADD

```
TRUST_VELOCITY_MAX_PER_DAY=25
TRUST_VELOCITY_WINDOW_DAYS=3
VOUCH_AGE_WEIGHT_SCALE=30
DIVERSITY_MIN_CLUSTERS=2
STAKE_AMOUNT_DZD=500
SHADOW_BAN_RISK_THRESHOLD=75
BEHAVIORAL_BASELINE_DAYS=30
RISK_MOMENTUM_WINDOW_HOURS=24
HIDDEN_WEIGHT_VARIANCE=0.05
```

---

## PILLAR 1 — TRUST GRAPH v2 (Anti-Slow-Poisoning)

### Context
Current TrustGraphService detects fast Sybil clusters (Tarjan SCC + density).
It FAILS against: patient attackers who build relationships slowly over weeks,
fake accounts that look legitimate individually but form coordinated networks.

This pillar adds 3 temporal dimensions to the existing graph engine.

### Migration — migrations/020_graph_v2.sql

```sql
ALTER TABLE practitioner_vouches
  ADD COLUMN IF NOT EXISTS relationship_age_days INTEGER DEFAULT 0;

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS trust_velocity         NUMERIC(8,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trust_velocity_flag    BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS vouch_diversity_score  NUMERIC(5,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graph_cluster_id       INTEGER,
  ADD COLUMN IF NOT EXISTS slow_poison_risk        BOOLEAN DEFAULT false;

CREATE TABLE trust_score_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID NOT NULL REFERENCES practitioners(id),
  trust_score     INTEGER NOT NULL,
  base_score      INTEGER NOT NULL,
  risk_score      INTEGER NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_event   TEXT NOT NULL
);
CREATE INDEX ON trust_score_history (practitioner_id, recorded_at DESC);
```

### Changes to TrustGraphService.js — ADD 3 new methods

`async computeTrustVelocity(practitionerId, db)`
  SELECT trust_score, recorded_at FROM trust_score_history
  WHERE practitioner_id = $1
  AND recorded_at > NOW() - INTERVAL '$2 days'  (use TRUST_VELOCITY_WINDOW_DAYS)
  ORDER BY recorded_at ASC

  velocity = (latest_score - oldest_score) / window_days
  max_allowed = parseInt(process.env.TRUST_VELOCITY_MAX_PER_DAY || '25')

  If velocity > max_allowed:
    UPDATE practitioners SET trust_velocity = velocity, trust_velocity_flag = true
    risk_flag { signal: 'TRUST_VELOCITY_ANOMALY', severity: 'HIGH', risk_points: 40 }
    INSERT reviewer_queue reason='TRUST_VELOCITY_ANOMALY'
    Write audit_log: { action: 'VELOCITY_FLAG', practitioner_id, velocity }
  Else:
    UPDATE practitioners SET trust_velocity = velocity, trust_velocity_flag = false

  Return: { velocity, flagged: bool, max_allowed }

`async computeRelationshipAgeWeights(db)`
  UPDATE practitioner_vouches SET
    relationship_age_days = EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400

  For each ACTIVE vouch:
    age_weight = Math.log(1 + age_days / parseInt(process.env.VOUCH_AGE_WEIGHT_SCALE || '30'))
    Clamp: min 0.1, max 1.5
    UPDATE practitioner_vouches SET vouch_weight = base_weight * age_weight

  Side effect: re-compute effective_vouch_strength for all affected practitioners
  If effective_vouch_strength drops below 1.0 after age weighting:
    UPDATE practitioners SET verification_status='VOUCHING_PENDING' (only if currently FULLY_VERIFIED)
    Fire webhook: event VOUCHING_STRENGTH_UPDATED
    Write audit_log: { action: 'VOUCH_WEIGHT_RECOMPUTED' }

`async computeVouchDiversity(practitionerId, graph, db)`
  Fetch all active vouchers for this practitioner
  For each voucher: look up their graph_cluster_id
  diversity = unique cluster IDs / total vouches

  min_clusters = parseInt(process.env.DIVERSITY_MIN_CLUSTERS || '2')
  If unique clusters < min_clusters AND vouch_count >= VOUCHING_REQUIRED_COUNT:
    risk_flag { signal: 'LOW_VOUCH_DIVERSITY', severity: 'MEDIUM', risk_points: 25 }
    UPDATE practitioners SET vouch_diversity_score = diversity, slow_poison_risk = true
    Write audit_log: { action: 'LOW_DIVERSITY_FLAG', practitioner_id, diversity }
  Else:
    UPDATE practitioners SET vouch_diversity_score = diversity, slow_poison_risk = false

  Return: { diversity, unique_clusters, total_vouches, flagged: bool }

### Changes to TrustGraphService.runFullAnalysis()

After existing steps (Tarjan, PageRank, centrality), ADD:
  1. computeRelationshipAgeWeights() — updates all vouch weights
  2. For each practitioner with vouch_count > 0:
       computeVouchDiversity(id, graph)
  3. For each practitioner:
       computeTrustVelocity(id)
  Log summary: { velocity_flagged: N, diversity_flagged: N, weights_updated: N }

### Changes to VerificationEngine.js + TrustScoreCalculator.js

After EVERY trust score change:
  INSERT trust_score_history { practitioner_id, trust_score, base_score, risk_score, trigger_event }
  (trigger_event = the step name: 'NFC_COMPLETE', 'PEER_VOUCHING_COMPLETE', etc.)

---

## PILLAR 2 — INSTITUTIONAL PROOF LAYER (Hard Anchor)

### Context
Current: doctor proves email → institution gets no say.
Upgrade: institution CONFIRMS the doctor works there.
This shifts the proof direction from self-attestation → institutional attestation.

### Migration — migrations/021_institutional_proof.sql

```sql
CREATE TABLE institutional_confirmations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id     UUID NOT NULL REFERENCES practitioners(id),
  institution_email   VARCHAR(255) NOT NULL,
  institution_domain  VARCHAR(255) NOT NULL,
  domain_tier         TEXT NOT NULL,
  confirmation_token  VARCHAR(64) NOT NULL UNIQUE,
  token_hash          VARCHAR(64) NOT NULL,
  admin_email         VARCHAR(255),
  status              TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','CONFIRMED','REJECTED','EXPIRED')),
  confirmed_at        TIMESTAMPTZ,
  rejected_reason     TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON institutional_confirmations (token_hash) WHERE status='PENDING';
CREATE INDEX ON institutional_confirmations (practitioner_id, status);
```

### Changes to InstitutionalEmailService.js — ADD Level 2

`async requestInstitutionalConfirmation(practitionerId, institutionAdminEmail)`
  The institution's HR/admin (not the doctor) receives a verification request.

  Rules:
  1. Extract domain from institutionAdminEmail
  2. Check domain in whitelist
  3. institutionAdminEmail must DIFFER from practitioner's own institutional email
     (prevents doctor verifying themselves)
  4. Generate: raw_token = crypto.randomBytes(32).toString('hex')
  5. token_hash = crypto.createHash('sha256').update(raw_token).digest('hex')
  6. INSERT institutional_confirmations {
       practitioner_id, institution_email: institutionAdminEmail,
       institution_domain: domain, domain_tier,
       confirmation_token: raw_token, token_hash,
       admin_email: institutionAdminEmail,
       expires_at: NOW()+72hr
     }
  7. Send email to institutionAdminEmail:
     Subject: "TrustMed — Confirmation d'affiliation médicale requise"
     Body: "Un médecin (TM-ID: {trustmed_id}, {full_name}) déclare travailler dans votre établissement.
            Pouvez-vous confirmer cette affiliation ?
            ✅ OUI, ce médecin est affilié: {PORTAL_URL}/institutional/confirm?token={raw_token}
            ❌ NON, refuser: {PORTAL_URL}/institutional/reject?token={raw_token}
            Cette demande expire dans 72 heures."
  8. Write audit_log: { action: 'INSTITUTIONAL_CONFIRMATION_REQUESTED', practitioner_id, institution_domain }
  9. Return: { sent: true, admin_email: institutionAdminEmail, expires_in_hours: 72 }

`async confirmByInstitution(rawToken)`
  1. token_hash = sha256(rawToken)
  2. SELECT FROM institutional_confirmations WHERE token_hash=$1 AND status='PENDING' AND expires_at>NOW()
  3. UPDATE status='CONFIRMED', confirmed_at=NOW()
  4. This grants BONUS +5 trust on top of existing institutional email signal:
     UPDATE practitioners SET trust_score = trust_score + 5
     INSERT trust_score_history { trigger_event: 'INSTITUTIONAL_CONFIRMATION' }
     Fire webhook: event INSTITUTIONAL_CONFIRMED
  5. Write to legal_declarations (HMAC-vaulted): { type:'INSTITUTIONAL_CONFIRMATION', domain, admin_email_hash }
  6. Write audit_log: { action: 'INSTITUTIONAL_CONFIRMED', practitioner_id, domain }
  7. Return: { confirmed: true, practitioner_trustmed_id, bonus_trust: 5 }

`async rejectByInstitution(rawToken, reason)`
  1. token_hash = sha256(rawToken)
  2. UPDATE status='REJECTED', rejected_reason=reason
  3. MAJOR red flag: institution explicitly denies affiliation
     risk_flag { signal: 'INSTITUTION_DENIED_AFFILIATION', severity: 'HIGH', risk_points: 60 }
     UPDATE practitioners risk_score accordingly
     If risk_score >= 60: auto-freeze + compliance webhook
  4. EmailService to practitioner: 'institutional_affiliation_denied' template
  5. Write audit_log: { action: 'INSTITUTION_DENIED', practitioner_id, domain, reason }

New routes in services/institutional/routes/institutional.js:
  GET /v1/institutional/confirm-institution?token= (admin confirms)
  GET /v1/institutional/reject-institution?token=  (admin rejects)
  POST /v1/practitioner/institutional/request-confirmation
    Body: { institution_admin_email: string }
    Calls requestInstitutionalConfirmation()

New EmailService template:
'institutional_affiliation_denied':
  Subject: "🔴 TrustMed - Affiliation institutionnelle refusée"
  Body: "Dr. {full_name}, l'établissement {domain} a refusé de confirmer votre affiliation.
         Votre dossier a été transmis à notre équipe de révision.
         Contactez-nous si vous pensez qu'il s'agit d'une erreur: support@trustmed.dz"

---

## PILLAR 3 — ECONOMIC DEFENSE LAYER

### Context
Fraud is technically harder now but still cheap — no financial cost to attempt.
This pillar makes attacks economically irrational.

### Migration — migrations/022_economic_defense.sql

```sql
CREATE TABLE verification_stakes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID NOT NULL REFERENCES practitioners(id),
  amount_dzd      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'HELD'
                  CHECK (status IN ('HELD','RELEASED','BURNED')),
  held_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at     TIMESTAMPTZ,
  burned_at       TIMESTAMPTZ,
  burn_reason     TEXT,
  payment_ref     VARCHAR(255)
);

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS stake_status  TEXT DEFAULT 'NONE'
                           CHECK (stake_status IN ('NONE','HELD','RELEASED','BURNED')),
  ADD COLUMN IF NOT EXISTS stake_held_at TIMESTAMPTZ;

CREATE TABLE progressive_friction_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID NOT NULL REFERENCES practitioners(id),
  friction_level  TEXT NOT NULL CHECK (friction_level IN ('NONE','DELAY','REVIEW','PAYMENT')),
  reason          TEXT,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
```

### New file — services/economic/EconomicDefenseService.js

`computeFrictionLevel(practitioner)`
  Based on risk_score:
  0–29:   NONE     → proceed normally
  30–49:  DELAY    → add 24hr processing delay before CNOM check triggers
  50–69:  REVIEW   → mandatory admin review before any trust increase
  70–100: PAYMENT  → require stake deposit before continuing

  Return: { level, reason, delay_hours }

`async applyDelay(practitionerId, delayHours, db)`
  INSERT progressive_friction_log { friction_level: 'DELAY', reason, applied_at }
  UPDATE practitioners SET can_progress_after = NOW() + INTERVAL '${delayHours} hours'
  (Add column: can_progress_after TIMESTAMPTZ to practitioners in migration)
  VerificationEngine checks this BEFORE processing any step:
    If NOW() < can_progress_after: throw { code: 'FRICTION_DELAY', retry_after: can_progress_after }

`async recordStakeHeld(practitionerId, paymentRef, db)`
  INSERT verification_stakes { amount_dzd: STAKE_AMOUNT_DZD, payment_ref }
  UPDATE practitioners SET stake_status='HELD', stake_held_at=NOW()
  Write audit_log: { action: 'STAKE_HELD', practitioner_id, amount_dzd }

`async releaseStake(practitionerId, db)`
  Called when practitioner reaches FULLY_VERIFIED with trust_confidence='HIGH'
  UPDATE verification_stakes SET status='RELEASED', released_at=NOW()
  UPDATE practitioners SET stake_status='RELEASED'
  EmailService: 'stake_released' template
  Write audit_log: { action: 'STAKE_RELEASED', practitioner_id }

`async burnStake(practitionerId, reason, db)`
  Called when FREEZE is triggered on a staked practitioner
  UPDATE verification_stakes SET status='BURNED', burned_at=NOW(), burn_reason=reason
  UPDATE practitioners SET stake_status='BURNED'
  Write audit_log: { action: 'STAKE_BURNED', practitioner_id, reason }

### Changes to VerificationEngine.js

At the START of process() (after consent check, before step processing):
  const friction = await EconomicDefenseService.computeFrictionLevel(practitioner)
  If friction.level === 'DELAY': check can_progress_after, throw if not ready
  If friction.level === 'REVIEW': check no open PENDING review items, block if any
  If friction.level === 'PAYMENT': check stake_status === 'HELD', block if not

### Add columns to practitioners via migration 022:
  ADD COLUMN can_progress_after TIMESTAMPTZ

New EmailService templates:
'stake_released':
  Subject: "✅ TrustMed - Caution remboursée"
  Body: "Dr. {full_name}, votre caution de {amount} DZD a été libérée suite à votre
         vérification complète. Le remboursement sera traité sous 5-7 jours ouvrables."

---

## PILLAR 4 — PREDICTIVE RISK ENGINE

### Context
Current fraud detection is reactive: it detects fraud AFTER signals form.
This pillar adds early weak signal detection and shadow banning.

### Migration — migrations/023_predictive_risk.sql

```sql
CREATE TABLE behavioral_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID NOT NULL REFERENCES practitioners(id),
  event_type      TEXT NOT NULL,
  event_metadata  JSONB DEFAULT '{}',
  session_id      VARCHAR(64),
  fingerprint_hash VARCHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON behavioral_events (practitioner_id, created_at DESC);
CREATE INDEX ON behavioral_events (event_type, created_at DESC);

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS risk_momentum      NUMERIC(8,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_banned      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_banned_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS behavioral_score   INTEGER NOT NULL DEFAULT 0;
```

### New file — services/risk/PredictiveRiskService.js

`async recordBehavioralEvent(practitionerId, eventType, metadata, req, db)`
  Events to track:
  - PAGE_VISIT, DOCUMENT_UPLOAD_STARTED, DOCUMENT_UPLOAD_COMPLETED
  - FORM_SUBMIT, OTP_REQUESTED, VOUCH_GIVEN, VOUCH_RECEIVED
  - SESSION_START, SESSION_END, STEP_COMPLETED

  INSERT behavioral_events { practitioner_id, event_type, event_metadata: metadata,
    fingerprint_hash: req.fingerprint_hash, session_id: req.session_id }

`async computeBehavioralBaseline(db)`
  Computes normal patterns from the last BEHAVIORAL_BASELINE_DAYS days of verified practitioners:
  - Average time between registration and first document upload
  - Average time between document upload and OTP request
  - Average number of sessions before completion
  - Average inter-event delay

  Store as JSON in a new table system_baselines:
  CREATE TABLE system_baselines (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    computed_at TIMESTAMPTZ DEFAULT NOW()
  );

`async scoreSequenceAnomaly(practitionerId, db)`
  Fetch the practitioner's behavioral_events in order
  Compare against baseline:
    IF time_to_first_upload < baseline_avg * 0.1 (10x faster than normal):
      anomaly_score += 30 (bot-like speed)
    IF sessions_before_completion < 1 (completed in single session):
      anomaly_score += 15
    IF inter_event_delay_avg < 2 seconds:
      anomaly_score += 25 (automated)
    IF event_sequence matches known attack patterns
      (upload→immediately submit→immediately request OTP→immediately verify):
      anomaly_score += 35

  UPDATE practitioners SET behavioral_score = anomaly_score
  If anomaly_score >= 60: risk_flag { signal: 'BEHAVIORAL_AUTOMATION_DETECTED',
    severity: 'HIGH', risk_points: 45 }
  Return: { anomaly_score, flags }

`async computeRiskMomentum(practitionerId, db)`
  SELECT risk_score, recorded_at FROM trust_score_history
  WHERE practitioner_id=$1 AND recorded_at > NOW() - INTERVAL '$2 hours'
  (use RISK_MOMENTUM_WINDOW_HOURS)

  If risk increased by > 30 points in the window:
    momentum = delta / hours
    risk_flag { signal: 'HIGH_RISK_MOMENTUM', severity: 'HIGH', risk_points: 30 }
    UPDATE practitioners SET risk_momentum = momentum
  Return: { momentum, flagged: bool }

`async evaluateShadowBan(practitionerId, db)`
  Conditions for shadow ban:
  1. risk_score >= SHADOW_BAN_RISK_THRESHOLD (default 75)
  2. NOT already frozen (let them think they are proceeding)
  3. Has behavioral_score >= 60 (automated behavior detected)

  If all conditions met:
    UPDATE practitioners SET shadow_banned=true, shadow_banned_at=NOW()
    DO NOT notify the practitioner
    Write audit_log: { action: 'SHADOW_BAN_APPLIED', practitioner_id } (admin-visible only)
    The practitioner's API calls continue to succeed (fake success responses)
    BUT: VerificationEngine.process() returns fake success without actually updating DB
         WebhookDispatcher does NOT fire real webhooks
         DocumentWorker processes docs but results are discarded

`async liftShadowBan(practitionerId, adminId, reason, db)`
  UPDATE practitioners SET shadow_banned=false
  Write audit_log: { action: 'SHADOW_BAN_LIFTED', practitioner_id, admin_id, reason }

### Changes to VerificationEngine.js

After consent check, before processing:
  If practitioner.shadow_banned:
    // Return a FAKE success response that looks real
    return { success: true, trust_score: practitioner.trust_score + step_delta,
             badge_level: computeBadgeLevel(practitioner.trust_score + step_delta),
             status: 'SHADOWED' }  // status field hidden from response
    // But DO NOT write to DB, DO NOT fire webhooks

### Changes to DocumentWorker.js

After OCR + fraud detection:
  await PredictiveRiskService.recordBehavioralEvent(practitioner_id, 'DOCUMENT_UPLOAD_COMPLETED', ...)
  await PredictiveRiskService.scoreSequenceAnomaly(practitioner_id, db)
  await PredictiveRiskService.computeRiskMomentum(practitioner_id, db)
  await PredictiveRiskService.evaluateShadowBan(practitioner_id, db)

### Add to MonitoringWorker.js — Job 6

Cron: '0 1 * * *' (daily 1 AM)
  1. PredictiveRiskService.computeBehavioralBaseline(db)
  2. For all PROVISIONAL + PHONE_VERIFIED practitioners:
       PredictiveRiskService.scoreSequenceAnomaly(id, db)
       PredictiveRiskService.computeRiskMomentum(id, db)
       PredictiveRiskService.evaluateShadowBan(id, db)
  Log: { baselines_computed: bool, anomalies_found: N, shadow_bans_applied: N }

### New Admin endpoint in cases.js:

`GET /admin/practitioners/:id/shadow-ban`  (ADMIN role only)
  Returns: { shadow_banned, shadow_banned_at, behavioral_score, risk_momentum }

`POST /admin/practitioners/:id/shadow-ban/lift`  (ADMIN role only)
  Body: { reason }
  PredictiveRiskService.liftShadowBan(id, req.admin.id, reason, db)

---

## PILLAR 5 — PROBABILISTIC TRUST ENGINE

### Context
Current non-linear scoring: score × confidence multiplier (0.70/0.90/1.00).
Upgrade: full probabilistic model with per-signal confidence + hidden variance.
Partners see a score. They do NOT see the formula or weights.

### Migration — migrations/024_probabilistic.sql

```sql
ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS trust_distribution  JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS signal_confidences  JSONB DEFAULT '{}';
```

### Changes to TrustScoreCalculator.js

Replace computeFinalScore() with full probabilistic model:

`computeProbabilisticScore(signals, riskFlags, practitioner)`
  signals = array of { name, base_weight, achieved: bool, confidence: float }

  Per-signal confidence rules:
    NFC_COMPLETE:
      confidence = 1.0 if liveness_verified else 0.7
    PEER_VOUCHING_COMPLETE:
      confidence = min(1.0, effective_vouch_strength) × vouch_diversity_score
    LIVENESS_VERIFIED:
      confidence = liveness_score (0–1 from Azure)
    INSTITUTIONAL_EMAIL_VERIFIED:
      confidence = 0.6 (email only) OR 0.9 (+ institutional confirmation)
    CNOM_CONFIRMED:
      confidence = cnom_match_score (from scraper)
    PHONE_OTP_VERIFIED:
      confidence = 1.0 if first attempt else 0.85 if second attempt else 0.70
    DECLARATION_SIGNED:
      confidence = 1.0 (always 100% — boolean event)

  Weighted score = Σ(base_weight_i × achieved_i × confidence_i)

  Apply hidden variance (makes formula non-gameable):
    variance = (process.env.HIDDEN_WEIGHT_VARIANCE || 0.05)
    Each weight gets tiny random perturbation: ± (variance × base_weight × random())
    This means two identical practitioners may score 93 and 95 — indistinguishable from noise
    variance is seeded from practitioner UUID (deterministic per practitioner, not random per call)

  Apply risk multiplier:
    HIGH risk flags: × 0.70
    MEDIUM risk: × 0.90
    No flags: × 1.00

  Clamp final to [0, 100]

  Store in practitioners:
    trust_score = final_score
    base_trust_score = raw_sum (without risk multiplier or variance)
    trust_confidence = 'HIGH'|'MEDIUM'|'LOW'
    signal_confidences = { NFC: 0.95, VOUCHING: 0.88, ... } (stored for admin view only)
    trust_distribution = { p5: N, p50: N, p95: N } (uncertainty range)

API response (/v1/practitioner/me):
  Public fields: trust_score, trust_confidence, badge_level
  With 'risk' scope: + risk_score, risk_level
  Admin only: + base_trust_score, signal_confidences, trust_distribution

NEVER expose: base weights, formula, variance seed, or individual signal confidences to non-admin

---

### ALL MIGRATIONS IN ORDER

020_graph_v2.sql          (trust_score_history + graph v2 columns)
021_institutional_proof.sql (institutional_confirmations table)
022_economic_defense.sql   (verification_stakes + friction log + can_progress_after)
023_predictive_risk.sql    (behavioral_events + system_baselines + shadow_ban cols)
024_probabilistic.sql      (trust_distribution + signal_confidences)

Run: node migrate.js

---

### FULL VERIFICATION CHECKLIST

1.  node migrate.js → migrations 020–024 applied ✓
2.  node -c services/graph/TrustGraphService.js ✓ (3 new methods added)
3.  node -c services/verification/TrustScoreCalculator.js ✓ (probabilistic model)
4.  node -c services/verification/VerificationEngine.js ✓ (friction + shadow ban gate)
5.  node -c services/institutional/InstitutionalEmailService.js ✓ (Level 2 added)
6.  node -c services/institutional/routes/institutional.js ✓ (2 new routes)
7.  node -c services/economic/EconomicDefenseService.js ✓
8.  node -c services/risk/PredictiveRiskService.js ✓
9.  node -c services/ocr/DocumentWorker.js ✓ (behavioral events added)
10. node -c services/monitoring/MonitoringWorker.js ✓ (Job 6 added)
11. node -c services/admin/routes/cases.js ✓ (shadow ban admin routes)
12. node -c server.js ✓

Functional tests:
13. Trust velocity: inject 3 score events in 1 day → velocity flag ✓
14. Vouch age weights: new vouch weight < old vouch weight ✓
15. Vouch diversity: 2 vouchers from same cluster → LOW_VOUCH_DIVERSITY flag ✓
16. Institution confirmation: admin email receives link → confirms → +5 trust ✓
17. Institution rejection: admin rejects → HIGH risk +60 → auto-freeze ✓
18. EconomicDefenseService: risk_score=35 → DELAY applied → can_progress_after set ✓
19. EconomicDefenseService: risk_score=75 → PAYMENT friction level ✓
20. PredictiveRiskService: all docs uploaded in 5 seconds → BEHAVIORAL_AUTOMATION flag ✓
21. Shadow ban: shadow_banned=true → VerificationEngine returns fake success ✓
22. Shadow ban: real DB not updated when shadow_banned ✓
23. TrustScoreCalculator: same practitioner UUID → same variance perturbation (deterministic) ✓
24. Admin /admin/practitioners/:id/shadow-ban/lift → shadow_banned=false ✓
25. /v1/practitioner/me → trust_distribution NOT exposed to practitioner ✓

---

### NPM PACKAGES TO INSTALL

No new packages needed. All already installed.

---

### CODING STANDARDS

- CommonJS only (require/module.exports)
- async/await, no .then() chains
- Parameterized queries ($1,$2) only
- Every function: try/catch → shared/logger.js
- Every DB write: audit_log in same transaction
- All config from process.env — never hardcode thresholds
- node -c must pass after each file

═══ END OF CONTEXT BLOCK ═══
