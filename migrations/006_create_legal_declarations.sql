-- 006: Legal declarations table (APPEND-ONLY — trigger in 011)
CREATE TABLE legal_declarations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  practitioner_id       UUID NOT NULL REFERENCES practitioners(id),
  declaration_text      TEXT NOT NULL,
  cin_number            VARCHAR(30) NOT NULL,
  selfie_vector_hash    VARCHAR(64),
  ip_address            INET,
  device_fingerprint    JSONB,
  geolocation           JSONB,
  hmac_signature        VARCHAR(128) NOT NULL,
  signed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ld_practitioner ON legal_declarations (practitioner_id);
