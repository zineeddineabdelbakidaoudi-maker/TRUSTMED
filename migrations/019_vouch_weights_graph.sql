-- 019: Vouch weights, graph rank, domain weight, trust confidence

ALTER TABLE practitioner_vouches
  ADD COLUMN IF NOT EXISTS vouch_weight NUMERIC(5,4) DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS effective_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS effective_vouch_strength NUMERIC(5,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graph_rank NUMERIC(8,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graph_analyzed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trust_confidence TEXT DEFAULT 'HIGH' CHECK (trust_confidence IN ('HIGH','MEDIUM','LOW')),
  ADD COLUMN IF NOT EXISTS base_trust_score INTEGER DEFAULT 0;

ALTER TABLE institutional_verifications
  ADD COLUMN IF NOT EXISTS domain_weight INTEGER DEFAULT 8,
  ADD COLUMN IF NOT EXISTS domain_tier   TEXT DEFAULT 'INSTITUTION';
