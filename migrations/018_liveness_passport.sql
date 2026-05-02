-- 018: Liveness, face match, and PASSPORT doc type

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS liveness_score       NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS liveness_passed      BOOLEAN,
  ADD COLUMN IF NOT EXISTS face_match_score     NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS face_match_passed    BOOLEAN,
  ADD COLUMN IF NOT EXISTS liveness_checked_at  TIMESTAMPTZ;

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS liveness_verified     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS liveness_verified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS face_verified         BOOLEAN NOT NULL DEFAULT false;

-- Add PASSPORT to doc_type enum
DO $$ BEGIN
  ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'PASSPORT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
