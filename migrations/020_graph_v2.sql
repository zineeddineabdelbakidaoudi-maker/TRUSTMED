-- 020_graph_v2.sql
ALTER TABLE practitioner_vouches
  ADD COLUMN IF NOT EXISTS relationship_age_days INTEGER DEFAULT 0;

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS trust_velocity         NUMERIC(8,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trust_velocity_flag    BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS vouch_diversity_score  NUMERIC(5,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graph_cluster_id       INTEGER,
  ADD COLUMN IF NOT EXISTS slow_poison_risk       BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS trust_score_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID NOT NULL REFERENCES practitioners(id),
  trust_score     INTEGER NOT NULL,
  base_score      INTEGER NOT NULL,
  risk_score      INTEGER NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_event   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trust_score_hist_pract_recorded ON trust_score_history (practitioner_id, recorded_at DESC);
