-- 012: Phase 3 schema additions
-- Adds columns for document storage metadata, fraud scoring, CNOM tracking,
-- and creates the reviewer_queue table for human review workflow.

-- ── Documents table: add storage metadata + fraud score ──
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS checksum_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS fraud_score NUMERIC;

-- ── Practitioners table: add last CNOM check timestamp ──
ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS last_cnom_check TIMESTAMPTZ;

-- ── Reviewer queue: human review workflow for flagged documents ──
CREATE TABLE IF NOT EXISTS reviewer_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id   UUID NOT NULL REFERENCES practitioners(id),
  document_id       UUID NOT NULL REFERENCES documents(id),
  reason            TEXT NOT NULL,
  assigned_to       UUID,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'ASSIGNED', 'RESOLVED')),
  resolution        TEXT CHECK (resolution IN ('APPROVED', 'REJECTED', 'MORE_INFO')),
  resolution_notes  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reviewer_queue_status_created
  ON reviewer_queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_reviewer_queue_practitioner
  ON reviewer_queue (practitioner_id);
