-- 017: Privacy consent columns

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS privacy_consented      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS privacy_consented_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_policy_version VARCHAR(10) DEFAULT '1.0',
  ADD COLUMN IF NOT EXISTS terms_consented        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS terms_consented_at     TIMESTAMPTZ;
