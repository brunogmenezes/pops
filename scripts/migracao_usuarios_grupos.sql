-- ============================================================
-- POPS | Migração para suporte a grupos e permissões
-- ============================================================
-- Execute com um usuário com permissão de DDL (postgres/superuser)
-- Exemplo:
-- psql -h <HOST> -U postgres -d pops -f scripts/migracao_usuarios_grupos.sql

CREATE TABLE IF NOT EXISTS user_groups (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  can_import BOOLEAN NOT NULL DEFAULT false,
  can_create BOOLEAN NOT NULL DEFAULT false,
  can_edit BOOLEAN NOT NULL DEFAULT false,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS group_id INTEGER;

DO
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_group_id_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_group_id_fkey
      FOREIGN KEY (group_id)
      REFERENCES user_groups(id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_users_group_id ON users (group_id);

-- garante que o admin inicial tenha perfil admin
UPDATE users
SET is_admin = true
WHERE lower(email) = lower('admin@pops.local');

SELECT 'Migração concluída com sucesso' AS status;
