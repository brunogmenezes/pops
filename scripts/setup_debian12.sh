#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# POPS | Setup rápido para Debian 12
# Executar como root/sudo: sudo bash scripts/setup_debian12.sh
# ============================================================

APP_DIR="/opt/pops"
APP_USER="www-data"

echo "[1/6] Instalando pacotes base..."
apt-get update
apt-get install -y ca-certificates curl gnupg2 lsb-release build-essential git

echo "[2/6] Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "[3/6] Instalando PostgreSQL..."
apt-get install -y postgresql postgresql-contrib
systemctl enable postgresql
systemctl start postgresql

echo "[4/6] Preparando diretório da aplicação..."
mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "[5/6] Copiando projeto (ajuste se necessário)..."
# Se o código já estiver no servidor, pule este bloco.
# Exemplo via git:
# sudo -u "$APP_USER" git clone <SEU_REPOSITORIO> "$APP_DIR"

echo "[6/6] Próximos comandos (rode manualmente):"
cat <<'EOF'

# A) Entrar na pasta do projeto
cd /opt/pops

# B) Criar .env baseado no exemplo
cp .env.example .env
# editar .env e definir DATABASE_URL, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD

# C) Criar banco/tabelas
sudo -u postgres psql -d postgres -f /opt/pops/scripts/criar_banco_e_tabelas.sql

# D) Instalar dependências e iniciar
npm ci
npm run dev

# Produção (alternativa):
# NODE_ENV=production npm start

EOF

echo "Setup base do Debian 12 concluído."
