-- 009: Phone verifications table
CREATE TABLE phone_verifications (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  practitioner_id   UUID NOT NULL REFERENCES practitioners(id),
  phone_number      VARCHAR(20) NOT NULL,
  otp_hash          VARCHAR(255),          -- bcrypt hash of OTP
  otp_exp           TIMESTAMPTZ,
  attempt_count     SMALLINT NOT NULL DEFAULT 0,
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  called_at         TIMESTAMPTZ,
  verified_at       TIMESTAMPTZ
);

CREATE INDEX idx_phone_practitioner ON phone_verifications (practitioner_id);
