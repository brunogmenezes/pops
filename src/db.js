const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL não definido no ambiente');
}

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  keepAlive: true,
  keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_DELAY_MS || 10000),
});

pool.on('error', (error) => {
  console.error('Erro inesperado no pool PostgreSQL:', error);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initDatabase() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS user_groups (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        can_import BOOLEAN NOT NULL DEFAULT false,
        can_create BOOLEAN NOT NULL DEFAULT false,
        can_edit BOOLEAN NOT NULL DEFAULT false,
        can_delete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'dark';
    `);

    await query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
    `);

    await query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS group_id INTEGER;
    `);

    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'users_group_id_fkey'
        ) THEN
          ALTER TABLE users
          ADD CONSTRAINT users_group_id_fkey
          FOREIGN KEY (group_id) REFERENCES user_groups (id)
          ON UPDATE CASCADE
          ON DELETE SET NULL;
        END IF;
      END;
      $$;
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS datacenters (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT,
        district TEXT,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(name, latitude, longitude)
      );
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_datacenters_city ON datacenters (city);
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_datacenters_district ON datacenters (district);
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_users_group_id ON users (group_id);
    `);
  } catch (error) {
    if (error && error.code === '42501') {
      console.warn(
        'Aviso: sem permissão de DDL para criar/alterar schema. Continuando com as tabelas já existentes.'
      );
      return;
    }
    throw error;
  }
}

async function ensureAdminUser() {
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();

  if (!adminEmail || !adminPassword) {
    return;
  }

  const existing = await query('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (existing.rowCount > 0) {
    try {
      await query('UPDATE users SET is_admin = true WHERE id = $1', [existing.rows[0].id]);
    } catch (error) {
      if (error?.code !== '42703') {
        throw error;
      }
    }
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  try {
    await query('INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, true)', [
      adminEmail,
      passwordHash,
    ]);
  } catch (error) {
    if (error?.code === '42703') {
      await query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [adminEmail, passwordHash]);
    } else {
      throw error;
    }
  }
  console.log('Usuário admin inicial criado com sucesso.');
}

module.exports = {
  pool,
  query,
  initDatabase,
  ensureAdminUser,
};
