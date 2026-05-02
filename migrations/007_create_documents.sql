-- 007: Documents table
CREATE TABLE documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  practitioner_id   UUID NOT NULL REFERENCES practitioners(id),
  doc_type          VARCHAR(50) NOT NULL,
  storage_key       VARCHAR(500) NOT NULL,
  ocr_result        JSONB,
  pattern_score     NUMERIC,
  fraud_flags       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_practitioner ON documents (practitioner_id);
CREATE INDEX idx_documents_status ON documents (status);
