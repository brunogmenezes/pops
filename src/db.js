const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL não definido no ambiente');
}

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initDatabase() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
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
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  await query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [adminEmail, passwordHash]);
  console.log('Usuário admin inicial criado com sucesso.');
}

module.exports = {
  pool,
  query,
  initDatabase,
  ensureAdminUser,
};
