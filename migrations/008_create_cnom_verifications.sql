-- 008: CNOM verifications table
CREATE TABLE cnom_verifications (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  practitioner_id     UUID NOT NULL REFERENCES practitioners(id),
  cnom_number         VARCHAR(30) NOT NULL,
  scraped_name        VARCHAR(255),
  scraped_specialty   VARCHAR(100),
  scraped_status      VARCHAR(50),
  source_url          VARCHAR(500),
  match_score         NUMERIC,
  result              VARCHAR(20) NOT NULL CHECK (result IN ('CONFIRMED','PROVISIONAL','MISMATCH')),
  scraped_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cnom_practitioner ON cnom_verifications (practitioner_id);
