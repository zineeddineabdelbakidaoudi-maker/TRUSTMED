-- 023_predictive_risk.sql
CREATE TABLE IF NOT EXISTS behavioral_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID NOT NULL REFERENCES practitioners(id),
  event_type      TEXT NOT NULL,
  event_metadata  JSONB DEFAULT '{}',
  session_id      VARCHAR(64),
  fingerprint_hash VARCHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_behav_events_pract_created ON behavioral_events (practitioner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_behav_events_type_created ON behavioral_events (event_type, created_at DESC);

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS risk_momentum      NUMERIC(8,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_banned      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_banned_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS behavioral_score   INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS system_baselines (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT NOW()
);
