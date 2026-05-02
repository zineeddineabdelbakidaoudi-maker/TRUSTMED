-- 024_probabilistic.sql
ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS trust_distribution  JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS signal_confidences  JSONB DEFAULT '{}';
