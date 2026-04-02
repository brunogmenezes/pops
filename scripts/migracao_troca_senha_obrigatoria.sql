-- ============================================================
-- POPS | Migração de troca obrigatória de senha no login
-- ============================================================
-- Execute com um usuário com permissão de DDL (postgres/superuser)
-- Exemplo:
-- psql -h <HOST> -U postgres -d pops -f scripts/migracao_troca_senha_obrigatoria.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_must_change_password ON users (must_change_password);

SELECT 'Migração de troca obrigatória de senha concluída com sucesso' AS status;
