-- 022_economic_defense.sql
CREATE TABLE IF NOT EXISTS verification_stakes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID NOT NULL REFERENCES practitioners(id),
  amount_dzd      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'HELD'
                  CHECK (status IN ('HELD','RELEASED','BURNED')),
  held_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at     TIMESTAMPTZ,
  burned_at       TIMESTAMPTZ,
  burn_reason     TEXT,
  payment_ref     VARCHAR(255)
);

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS stake_status  TEXT DEFAULT 'NONE'
                           CHECK (stake_status IN ('NONE','HELD','RELEASED','BURNED')),
  ADD COLUMN IF NOT EXISTS stake_held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS can_progress_after TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS progressive_friction_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID NOT NULL REFERENCES practitioners(id),
  friction_level  TEXT NOT NULL CHECK (friction_level IN ('NONE','DELAY','REVIEW','PAYMENT')),
  reason          TEXT,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
