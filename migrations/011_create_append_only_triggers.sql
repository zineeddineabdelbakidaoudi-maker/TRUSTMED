-- 011: Append-only triggers for legal_declarations and audit_log
-- These triggers physically prevent UPDATE and DELETE operations.

-- ── legal_declarations: block UPDATE ──
CREATE OR REPLACE FUNCTION prevent_legal_declarations_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Updates to legal_declarations are forbidden. This table is append-only.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_legal_declarations_no_update
  BEFORE UPDATE ON legal_declarations
  FOR EACH ROW
  EXECUTE FUNCTION prevent_legal_declarations_update();

-- ── legal_declarations: block DELETE ──
CREATE OR REPLACE FUNCTION prevent_legal_declarations_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Deletes from legal_declarations are forbidden. This table is append-only.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_legal_declarations_no_delete
  BEFORE DELETE ON legal_declarations
  FOR EACH ROW
  EXECUTE FUNCTION prevent_legal_declarations_delete();

-- ── audit_log: block UPDATE ──
CREATE OR REPLACE FUNCTION prevent_audit_log_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Updates to audit_log are forbidden. This table is append-only.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_update();

-- ── audit_log: block DELETE ──
CREATE OR REPLACE FUNCTION prevent_audit_log_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Deletes from audit_log are forbidden. This table is append-only.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_delete();
