-- 013: Create admin_users table for Phase 4 Admin Dashboard

CREATE TABLE admin_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          TEXT NOT NULL DEFAULT 'REVIEWER'
                CHECK (role IN ('REVIEWER', 'ADMIN')),
  full_name     VARCHAR(255) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- Seed one admin (password: TrustMed@2026 — CHANGE IN PRODUCTION)
INSERT INTO admin_users (email, password_hash, role, full_name)
VALUES (
  'admin@trustmed.dz',
  '$2b$12$EvYlPoj2HDB0t.eIGiRE0uIebotnY/yG7N/qXcbhNPJ6Lisk0ZcDS',
  'ADMIN',
  'TrustMed Admin'
);
