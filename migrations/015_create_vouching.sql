-- 015: Peer vouching system + new practitioner columns

-- New ENUM values for verification_status
DO $$ BEGIN
  ALTER TYPE verification_status_enum ADD VALUE IF NOT EXISTS 'PHONE_VERIFIED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE verification_status_enum ADD VALUE IF NOT EXISTS 'VOUCHING_PENDING';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Vouches table
CREATE TABLE IF NOT EXISTS practitioner_vouches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id      UUID NOT NULL REFERENCES practitioners(id),
  subject_id      UUID NOT NULL REFERENCES practitioners(id),
  voucher_score   INTEGER NOT NULL,
  voucher_badge   TEXT NOT NULL,
  vouch_note      TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
  withdrawn_at    TIMESTAMPTZ,
  withdrawn_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT no_self_vouch CHECK (voucher_id != subject_id),
  CONSTRAINT unique_vouch UNIQUE (voucher_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_vouches_subject ON practitioner_vouches (subject_id, status);
CREATE INDEX IF NOT EXISTS idx_vouches_voucher ON practitioner_vouches (voucher_id, status);

-- New practitioner columns
ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS vouch_count                      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS institutional_email              VARCHAR(255),
  ADD COLUMN IF NOT EXISTS institutional_email_verified     BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS institutional_email_verified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS risk_score                       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_flags                       JSONB DEFAULT '[]';
