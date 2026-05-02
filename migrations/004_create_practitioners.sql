-- 004: Practitioners table
CREATE TABLE practitioners (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trustmed_id           VARCHAR(20) NOT NULL UNIQUE,
  nfc_identity_hash     VARCHAR(64) UNIQUE,        -- SHA-256 hex
  full_name             VARCHAR(255) NOT NULL,
  cin_number            VARCHAR(30) NOT NULL UNIQUE,
  specialty             VARCHAR(100),
  wilaya_code           SMALLINT,
  cnom_number           VARCHAR(30) UNIQUE,
  verification_status   verification_status_enum NOT NULL DEFAULT 'IDENTITY_PENDING',
  trust_score           SMALLINT NOT NULL DEFAULT 0,
  badge_level           VARCHAR(30) NOT NULL DEFAULT 'NONE',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_trustmed_id_format
    CHECK (trustmed_id ~ '^TM-[0-9]{2}-[0-9]{4}-[0-9]{4}$'),

  CONSTRAINT chk_trust_score_range
    CHECK (trust_score >= 0 AND trust_score <= 100),

  CONSTRAINT chk_cnom_number_format
    CHECK (cnom_number IS NULL OR cnom_number ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' OR cnom_number ~ '^[0-9]{2}-[0-9]{5}$')
);

CREATE INDEX idx_practitioners_trustmed_id ON practitioners (trustmed_id);
CREATE INDEX idx_practitioners_cin ON practitioners (cin_number);
CREATE INDEX idx_practitioners_cnom ON practitioners (cnom_number);
