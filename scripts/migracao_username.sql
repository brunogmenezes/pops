-- ============================================================
-- POPS | Migração para suporte a username
-- ============================================================
-- Execute com um usuário com permissão de DDL (postgres/superuser)
-- Exemplo:
-- psql -h <HOST> -U postgres -d pops -f scripts/migracao_username.sql

-- Passo 1: Adicionar coluna username temporária
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username_temp TEXT;

-- Passo 2: Preencher username_temp com valores derivados do email
UPDATE users
SET username_temp = LOWER(SPLIT_PART(email, '@', 1))
WHERE username_temp IS NULL AND email IS NOT NULL;

-- Passo 3: Tratar usuários sem email (se existirem)
UPDATE users
SET username_temp = 'user_' || id::text
WHERE username_temp IS NULL;

-- Passo 4: Remover a constraint UNIQUE NOT NULL do email
-- Primeiro, precisamos verificar se a coluna email tem constraint NOT NULL
DO
$$
BEGIN
  -- Remover constraint NOT NULL do email
  ALTER TABLE users
    ALTER COLUMN email DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN
  NULL; -- Constraint não existe, continuar
END;
$$;

-- Passo 5: Garantir que username_temp não tenha NULLs e adicionar constraint UNIQUE
ALTER TABLE users
  ADD CONSTRAINT users_username_unique UNIQUE (username_temp);

-- Passo 6: Renomear username_temp para username
ALTER TABLE users
  RENAME COLUMN username_temp TO username;

-- Passo 7: Garantir que email tenha UNIQUE mas permita NULL
-- Remover constraint antiga de email se existir
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_email_key;

-- Adicionar nova constraint UNIQUE que permite NULL
ALTER TABLE users
  ADD CONSTRAINT users_email_unique UNIQUE (email);

-- Passo 8: Criar índice em username para performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- Passo 9: Criar índice em email (já existe mas garantir)
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

SELECT 'Migração para username concluída com sucesso' AS status;

-- Verificação
SELECT 
  column_name, 
  is_nullable, 
  data_type
FROM information_schema.columns
WHERE table_name = 'users'
  AND column_name IN ('username', 'email')
ORDER BY column_name;
