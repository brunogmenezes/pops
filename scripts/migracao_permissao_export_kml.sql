-- Migração: adiciona a permissão can_export_kml à tabela user_groups
-- Execute este script uma vez em bancos existentes.

ALTER TABLE user_groups
  ADD COLUMN IF NOT EXISTS can_export_kml BOOLEAN NOT NULL DEFAULT false;
