-- ============================================================
-- POPS | Script de criação do banco e tabelas (PostgreSQL)
-- ============================================================
-- Como executar (PowerShell):
-- 1) Via usuário postgres:
--    psql -h localhost -U postgres -d postgres -f scripts/criar_banco_e_tabelas.sql
--
-- 2) Se preferir, entre no psql e rode:
--    \i scripts/criar_banco_e_tabelas.sql
--
-- Observação:
-- - Ajuste DB_NAME, DB_USER e DB_PASSWORD abaixo antes de executar.
-- - O app também cria tabelas automaticamente, mas este script permite
--   provisionar tudo manualmente.
-- ============================================================

-- ===== PARÂMETROS (EDITE AQUI) =====
-- Nome do banco da aplicação
\set DB_NAME 'pops'
-- Usuário da aplicação
\set DB_USER 'pops_user'
-- Senha do usuário da aplicação
\set DB_PASSWORD 'TroquePorUmaSenhaForte_2026!'

-- Conecta no banco administrativo para criar role/database
\connect postgres

-- 1) Cria usuário/role da aplicação (se não existir)
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'DB_USER', :'DB_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'DB_USER')
\gexec

-- 2) Cria banco da aplicação (se não existir)
SELECT format('CREATE DATABASE %I OWNER %I', :'DB_NAME', :'DB_USER')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'DB_NAME')
\gexec

-- 3) Conecta no banco da aplicação
\connect :DB_NAME

-- 4) Tabela de usuários
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 5) Tabela de datacenters
CREATE TABLE IF NOT EXISTS datacenters (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  district TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (name, latitude, longitude)
);

CREATE INDEX IF NOT EXISTS idx_datacenters_city ON datacenters (city);
CREATE INDEX IF NOT EXISTS idx_datacenters_district ON datacenters (district);

-- 6) Tabela de sessões (compatível com express-session + connect-pg-simple)
CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar NOT NULL COLLATE "default",
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

DO
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_sessions_pkey'
  ) THEN
    ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (sid);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions (expire);

-- 7) Permissões para o usuário da aplicação
GRANT CONNECT ON DATABASE :DB_NAME TO :DB_USER;
GRANT USAGE ON SCHEMA public TO :DB_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :DB_USER;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :DB_USER;

-- 8) Verificação rápida
SELECT 'Banco/tabelas criados com sucesso.' AS status;
SELECT COUNT(*) AS total_datacenters FROM datacenters;
