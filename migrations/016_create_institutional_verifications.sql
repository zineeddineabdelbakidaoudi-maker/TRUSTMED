-- 016: Institutional email verifications table

CREATE TABLE IF NOT EXISTS institutional_verifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id   UUID NOT NULL REFERENCES practitioners(id),
  institutional_email VARCHAR(255) NOT NULL,
  domain            VARCHAR(255) NOT NULL,
  token_hash        VARCHAR(64) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'VERIFIED', 'EXPIRED')),
  expires_at        TIMESTAMPTZ NOT NULL,
  verified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inst_verified
  ON institutional_verifications (practitioner_id) WHERE status = 'VERIFIED';

CREATE INDEX IF NOT EXISTS idx_inst_token
  ON institutional_verifications (token_hash) WHERE status = 'PENDING';
