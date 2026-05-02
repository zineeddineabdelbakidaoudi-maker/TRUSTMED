-- 003: Partners table
CREATE TABLE partners (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  client_id       VARCHAR(100) NOT NULL UNIQUE,
  client_secret   VARCHAR(255) NOT NULL,   -- bcrypt hash, never plaintext
  redirect_uris   TEXT[] NOT NULL DEFAULT '{}',
  allowed_scopes  TEXT[] NOT NULL DEFAULT '{}',
  webhook_url     VARCHAR(500),
  webhook_secret  VARCHAR(255),            -- used as HMAC key for webhook signing
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_partners_client_id ON partners (client_id);
