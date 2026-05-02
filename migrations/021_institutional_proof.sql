-- 021_institutional_proof.sql
CREATE TABLE IF NOT EXISTS institutional_confirmations (
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

CREATE INDEX IF NOT EXISTS idx_inst_conf_token_pending ON institutional_confirmations (token_hash) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS idx_inst_conf_pract_status ON institutional_confirmations (practitioner_id, status);
