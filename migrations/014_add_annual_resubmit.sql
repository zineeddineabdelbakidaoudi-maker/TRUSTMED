-- 014: Add annual resubmission logic and RETIRED status

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS agrement_expiry         DATE,
  ADD COLUMN IF NOT EXISTS annual_resubmit_due_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_resubmit_at        TIMESTAMPTZ;

-- Add RETIRED to verification_status_enum
ALTER TYPE verification_status_enum ADD VALUE IF NOT EXISTS 'RETIRED';

-- Update cnom_verifications CHECK constraint to include RETIRED
ALTER TABLE cnom_verifications DROP CONSTRAINT IF EXISTS cnom_verifications_result_check;
ALTER TABLE cnom_verifications ADD CONSTRAINT cnom_verifications_result_check CHECK (result IN ('CONFIRMED', 'PROVISIONAL', 'MISMATCH', 'RETIRED'));
