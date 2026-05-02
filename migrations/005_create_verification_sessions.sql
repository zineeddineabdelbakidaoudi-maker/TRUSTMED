-- 005: Verification sessions table
CREATE TABLE verification_sessions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  practitioner_id   UUID REFERENCES practitioners(id),
  partner_id        UUID NOT NULL REFERENCES partners(id),
  auth_code         VARCHAR(64) UNIQUE,
  auth_code_exp     TIMESTAMPTZ,
  used_at           TIMESTAMPTZ,           -- set on code exchange, prevents replay
  access_token      VARCHAR(500) UNIQUE,
  token_exp         TIMESTAMPTZ,
  state             VARCHAR(255),          -- CSRF token, passed through untouched
  redirect_uri      VARCHAR(500) NOT NULL,
  scopes            TEXT[] NOT NULL DEFAULT '{}',
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vs_auth_code ON verification_sessions (auth_code);
CREATE INDEX idx_vs_access_token ON verification_sessions (access_token);
CREATE INDEX idx_vs_practitioner ON verification_sessions (practitioner_id);
