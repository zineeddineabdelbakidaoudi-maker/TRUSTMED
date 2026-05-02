-- 010: Audit log table (APPEND-ONLY — trigger in 011)
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      UUID,
  actor_type    VARCHAR(30),
  action        VARCHAR(100) NOT NULL,
  target_id     UUID,
  metadata      JSONB,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_actor ON audit_log (actor_id);
CREATE INDEX idx_audit_action ON audit_log (action);
CREATE INDEX idx_audit_target ON audit_log (target_id);
CREATE INDEX idx_audit_created ON audit_log (created_at);
