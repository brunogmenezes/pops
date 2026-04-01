require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const JSZip = require('jszip');
const bcrypt = require('bcryptjs');
const { DOMParser } = require('@xmldom/xmldom');
const toGeoJSON = require('@mapbox/togeojson');

const { pool, query, initDatabase, ensureAdminUser } = require('./db');

const PgSession = require('connect-pg-simple')(session);

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const createSessionTableIfMissing = process.env.CREATE_SESSION_TABLE_IF_MISSING === 'true';
const DEFAULT_PERMISSIONS = Object.freeze({
  canImport: false,
  canCreate: false,
  canEdit: false,
  canDelete: false,
  canExportKml: false,
});

app.use(
  helmet({
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com'],
        styleSrc: ["'self'", 'https://unpkg.com', "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          'data:',
          'https://tile.openstreetmap.org',
          'https://*.tile.openstreetmap.org',
          'https://server.arcgisonline.com',
          'https://*.arcgisonline.com',
          'https://unpkg.com',
          'https://*.unpkg.com',
        ],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: createSessionTableIfMissing,
      errorLog: (error) => console.error('Erro no armazenamento de sessão (PostgreSQL):', error),
    }),
    name: 'pops.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

function getOrCreateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  return next();
}

function requireCsrf(req, res, next) {
  const requestToken = req.get('x-csrf-token');
  const sessionToken = req.session.csrfToken;

  if (!requestToken || !sessionToken || requestToken !== sessionToken) {
    return res.status(403).json({ error: 'Token CSRF inválido' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) {
    return next();
  }
  return res.status(403).json({ error: 'Acesso restrito ao administrador' });
}

function requirePermission(permissionField, label) {
  return (req, res, next) => {
    if (req.session?.isAdmin) {
      return next();
    }

    const permissions = req.session?.permissions || DEFAULT_PERMISSIONS;
    if (permissions[permissionField]) {
      return next();
    }

    return res.status(403).json({ error: `Sem permissão para ${label}` });
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    if (!req.session.userTheme && req.session.userId) {
      req.session.userTheme = await getUserThemePreference(req.session.userId);
    }

    if (!req.session.permissions || req.session.isAdmin === undefined) {
      const access = await getUserAccessContext(req.session.userId, req.session.userEmail);
      req.session.isAdmin = access.isAdmin;
      req.session.permissions = access.permissions;
      req.session.groupId = access.groupId;
      req.session.groupName = access.groupName;
    }

    return res.json({
      id: req.session.userId,
      email: req.session.userEmail,
      username: req.session.username,
      themePreference: req.session.userTheme || 'dark',
      isAdmin: Boolean(req.session.isAdmin),
      groupId: req.session.groupId || null,
      groupName: req.session.groupName || null,
      permissions: req.session.permissions || { ...DEFAULT_PERMISSIONS },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao carregar usuário autenticado' });
  }
});

app.get('/api/csrf', requireAuth, (req, res) => {
  res.json({ csrfToken: getOrCreateCsrfToken(req) });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !password || username.length > 200 || password.length > 200) {
      return res.status(400).json({ error: 'Credenciais inválidas' });
    }

    const result = await query(
      'SELECT id, username, email, password_hash FROM users WHERE username = $1 OR (email IS NOT NULL AND email = $1)',
      [username]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    req.session.userId = user.id;
    req.session.userEmail = user.email || user.username;
    req.session.username = user.username;
    req.session.userTheme = await getUserThemePreference(user.id);
    const access = await getUserAccessContext(user.id, req.session.userEmail);
    req.session.isAdmin = access.isAdmin;
    req.session.permissions = access.permissions;
    req.session.groupId = access.groupId;
    req.session.groupName = access.groupName;
    const csrfToken = getOrCreateCsrfToken(req);

    return res.json({
      ok: true,
      csrfToken,
      email: user.email || user.username,
      username: user.username,
      themePreference: req.session.userTheme,
      isAdmin: access.isAdmin,
      groupId: access.groupId,
      groupName: access.groupName,
      permissions: access.permissions,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno no login' });
  }
});

app.post('/api/preferences/theme', requireAuth, requireCsrf, async (req, res) => {
  try {
    const theme = String(req.body.theme || '').trim().toLowerCase();
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Tema inválido' });
    }

    try {
      await query('UPDATE users SET theme_preference = $1 WHERE id = $2', [theme, req.session.userId]);
      req.session.userTheme = theme;
      return res.json({ ok: true, themePreference: theme });
    } catch (dbError) {
      if (dbError?.code === '42703') {
        req.session.userTheme = theme;
        return res.json({ ok: true, themePreference: theme, persisted: false });
      }
      throw dbError;
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao salvar preferência de tema' });
  }
});

app.post('/api/logout', requireAuth, requireCsrf, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao encerrar sessão' });
    }
    res.clearCookie('pops.sid');
    return res.json({ ok: true });
  });
});

app.get('/api/admin/groups', requireAuth, requireAdmin, async (_req, res) => {
  try {
    try {
      const result = await query(
        `
          SELECT
            g.id,
            g.name,
            g.can_import,
            g.can_create,
            g.can_edit,
            g.can_delete,
            g.can_export_kml,
            g.created_at,
            COUNT(u.id)::int AS users_count
          FROM user_groups g
          LEFT JOIN users u ON u.group_id = g.id
          GROUP BY g.id, g.name, g.can_import, g.can_create, g.can_edit, g.can_delete, g.can_export_kml, g.created_at
          ORDER BY name ASC
        `
      );
      return res.json({ items: result.rows });
    } catch (error) {
      if (error?.code === '42703') {
        const fallback = await query(
          `
            SELECT
              g.id,
              g.name,
              g.can_import,
              g.can_create,
              g.can_edit,
              g.can_delete,
              false AS can_export_kml,
              g.created_at,
              0::int AS users_count
            FROM user_groups g
            ORDER BY name ASC
          `
        );
        return res.json({ items: fallback.rows });
      }
      throw error;
    }
  } catch (error) {
    if (error?.code === '42P01') {
      return res.json({ items: [] });
    }
    console.error(error);
    return res.status(500).json({ error: 'Erro ao carregar grupos' });
  }
});

app.post('/api/admin/groups', requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  try {
    const name = normalizeText(req.body.name);
    const canImport = toBoolean(req.body.canImport);
    const canCreate = toBoolean(req.body.canCreate);
    const canEdit = toBoolean(req.body.canEdit);
    const canDelete = toBoolean(req.body.canDelete);
    const canExportKml = toBoolean(req.body.canExportKml);

    if (!name) {
      return res.status(400).json({ error: 'Nome do grupo é obrigatório' });
    }

    const result = await query(
      `
        INSERT INTO user_groups (name, can_import, can_create, can_edit, can_delete, can_export_kml)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, name, can_import, can_create, can_edit, can_delete, can_export_kml, created_at
      `,
      [name, canImport, canCreate, canEdit, canDelete, canExportKml]
    );

    return res.status(201).json({ ok: true, item: result.rows[0] });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Já existe um grupo com esse nome' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Erro ao criar grupo' });
  }
});

app.put('/api/admin/groups/:id', requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de grupo inválido' });
    }

    const name = normalizeText(req.body.name);
    const canImport = toBoolean(req.body.canImport);
    const canCreate = toBoolean(req.body.canCreate);
    const canEdit = toBoolean(req.body.canEdit);
    const canDelete = toBoolean(req.body.canDelete);
    const canExportKml = toBoolean(req.body.canExportKml);

    if (!name) {
      return res.status(400).json({ error: 'Nome do grupo é obrigatório' });
    }

    const result = await query(
      `
        UPDATE user_groups
        SET name = $1,
            can_import = $2,
            can_create = $3,
            can_edit = $4,
            can_delete = $5,
            can_export_kml = $6
        WHERE id = $7
        RETURNING id, name, can_import, can_create, can_edit, can_delete, can_export_kml, created_at
      `,
      [name, canImport, canCreate, canEdit, canDelete, canExportKml, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Grupo não encontrado' });
    }

    return res.json({ ok: true, item: result.rows[0] });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Já existe um grupo com esse nome' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Erro ao editar grupo' });
  }
});

app.delete('/api/admin/groups/:id', requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de grupo inválido' });
    }

    let totalUsers = 0;
    try {
      const inUse = await query('SELECT COUNT(*)::int AS total FROM users WHERE group_id = $1', [id]);
      totalUsers = Number(inUse.rows?.[0]?.total || 0);
    } catch (error) {
      if (error?.code !== '42703') {
        throw error;
      }
    }

    if (totalUsers > 0) {
      return res.status(409).json({ error: 'Não é possível excluir: há usuários associados a este grupo' });
    }

    const result = await query('DELETE FROM user_groups WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Grupo não encontrado' });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao excluir grupo' });
  }
});

app.post('/api/admin/users', requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    const groupId = Number(req.body.groupId);

    if (!username || username.length > 200) {
      return res.status(400).json({ error: 'Usuário inválido' });
    }

    if (email && (!email.includes('@') || email.length > 200)) {
      return res.status(400).json({ error: 'E-mail inválido' });
    }

    if (!password || password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'Senha deve ter entre 8 e 200 caracteres' });
    }

    if (!Number.isInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ error: 'Grupo inválido' });
    }

    const groupExists = await query('SELECT id FROM user_groups WHERE id = $1', [groupId]);
    if (groupExists.rowCount === 0) {
      return res.status(400).json({ error: 'Grupo não encontrado' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(
      `
        INSERT INTO users (username, email, password_hash, group_id, is_admin)
        VALUES ($1, $2, $3, $4, false)
        RETURNING id, username, email, group_id, created_at
      `,
      [username, email || null, passwordHash, groupId]
    );

    return res.status(201).json({ ok: true, item: result.rows[0] });
  } catch (error) {
    if (error?.code === '42703') {
      return res.status(500).json({
        error:
          'Schema desatualizado: coluna users.username não existe. Reinicie o serviço para atualizar o banco de dados.',
      });
    }
    if (error?.code === '23505') {
      const detail = error.detail || '';
      if (detail.includes('username')) {
        return res.status(409).json({ error: 'Usuário já cadastrado' });
      }
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const result = await query(`
      SELECT
        u.id,
        u.username,
        u.email,
        u.group_id,
        u.is_admin,
        u.created_at,
        g.name AS group_name
      FROM users u
      LEFT JOIN user_groups g ON u.group_id = g.id
      ORDER BY u.username ASC
    `);
    return res.json({ items: result.rows });
  } catch (error) {
    if (error?.code === '42703') {
      return res.json({ items: [] });
    }
    console.error(error);
    return res.status(500).json({ error: 'Erro ao carregar usuários' });
  }
});

app.put('/api/admin/users/:id', requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de usuário inválido' });
    }

    const username = String(req.body.username || '').trim().toLowerCase();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    const rawGroupId = req.body.groupId;
    let groupId = null;

    if (!username || username.length > 200) {
      return res.status(400).json({ error: 'Usuário inválido' });
    }

    if (email && (email.length > 200 || !email.includes('@'))) {
      return res.status(400).json({ error: 'E-mail inválido' });
    }

    if (rawGroupId !== undefined && rawGroupId !== null && String(rawGroupId).trim() !== '') {
      groupId = Number(rawGroupId);
      if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Grupo inválido' });
      }
    }

    if (groupId) {
      const groupExists = await query('SELECT id FROM user_groups WHERE id = $1', [groupId]);
      if (groupExists.rowCount === 0) {
        return res.status(400).json({ error: 'Grupo não encontrado' });
      }
    }

    if (password) {
      if (password.length < 8 || password.length > 200) {
        return res.status(400).json({ error: 'Senha deve ter entre 8 e 200 caracteres' });
      }
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const result = await query(
      `
        UPDATE users
        SET username = $1,
            email = $2,
            group_id = $3,
            password_hash = COALESCE($4, password_hash)
        WHERE id = $5
        RETURNING id, username, email, group_id, is_admin, created_at
      `,
      [username, email || null, groupId, passwordHash, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (req.session.userId === id) {
      req.session.username = result.rows[0].username;
      req.session.userEmail = result.rows[0].email || result.rows[0].username;
    }

    return res.json({ ok: true, item: result.rows[0] });
  } catch (error) {
    if (error?.code === '23505') {
      const detail = String(error.detail || '').toLowerCase();
      if (detail.includes('username')) {
        return res.status(409).json({ error: 'Usuário já cadastrado' });
      }
      if (detail.includes('email')) {
        return res.status(409).json({ error: 'E-mail já cadastrado' });
      }
      return res.status(409).json({ error: 'Já existe um usuário com esses dados' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Erro ao editar usuário' });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de usuário inválido' });
    }

    if (req.session.userId === id) {
      return res.status(409).json({ error: 'Não é permitido excluir o próprio usuário autenticado' });
    }

    const result = await query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao excluir usuário' });
  }
});

app.get('/api/datacenters', requireAuth, async (req, res) => {
  try {
    const { whereClause, params } = buildDatacentersFilterClause(req.query);

    const sql = `
      SELECT id, name, city, district, district AS cnl, latitude, longitude, created_at
      FROM datacenters
      ${whereClause}
      ORDER BY name ASC
      LIMIT 500
    `;

    const result = await query(sql, params);
    return res.json({ items: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao buscar datacenters' });
  }
});

app.get('/api/datacenters/export.kml', requireAuth, requirePermission('canExportKml', 'exportar KML'), async (req, res) => {
  try {
    const { whereClause, params } = buildDatacentersFilterClause(req.query);
    const result = await query(
      `
        SELECT id, name, city, district, district AS cnl, latitude, longitude
        FROM datacenters
        ${whereClause}
        ORDER BY COALESCE(city, ''), name ASC
      `,
      params
    );

    const items = result.rows || [];
    if (items.length === 0) {
      return res.status(404).json({ error: 'Nenhum datacenter encontrado para exportação' });
    }

    const kml = buildDatacentersKml(items);
    const fileName = `pops-datacenters-${new Date().toISOString().slice(0, 10)}.kml`;

    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(kml);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao exportar KML' });
  }
});

app.get('/api/datacenters/stats', requireAuth, async (_req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(city)::int AS with_city,
        COUNT(DISTINCT NULLIF(BTRIM(city), ''))::int AS total_cities,
        COUNT(*) FILTER (WHERE district IS NOT NULL AND BTRIM(district) <> '')::int AS with_district,
        COUNT(*) FILTER (WHERE district IS NOT NULL AND BTRIM(district) <> '')::int AS with_cnl,
        COUNT(*) FILTER (WHERE district IS NULL OR BTRIM(district) = '')::int AS without_cnl,
        COUNT(DISTINCT city)::int AS cities
      FROM datacenters
    `);

    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao carregar estatísticas' });
  }
});

app.post('/api/datacenters', requireAuth, requireCsrf, requirePermission('canCreate', 'inserir datacenter'), async (req, res) => {
  try {
    const name = normalizeText(req.body.name);
    const city = normalizeText(req.body.city);
    const district = normalizeText(req.body.cnl || req.body.district);
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);

    if (!name) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return res.status(400).json({ error: 'Latitude inválida' });
    }

    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Longitude inválida' });
    }

    const result = await query(
      `
        INSERT INTO datacenters (name, city, district, latitude, longitude)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (name, latitude, longitude) DO NOTHING
        RETURNING id, name, city, district, district AS cnl, latitude, longitude, created_at
      `,
      [name, city || null, district || null, latitude, longitude]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Datacenter já cadastrado com mesmo nome e coordenadas' });
    }

    return res.status(201).json({ ok: true, item: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao cadastrar datacenter' });
  }
});

app.put('/api/datacenters/:id', requireAuth, requireCsrf, requirePermission('canEdit', 'editar datacenter'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const name = normalizeText(req.body.name);
    const city = normalizeText(req.body.city);
    const district = normalizeText(req.body.cnl || req.body.district);
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);

    if (!name) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return res.status(400).json({ error: 'Latitude inválida' });
    }

    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Longitude inválida' });
    }

    const result = await query(
      `
        UPDATE datacenters
        SET name = $1,
            city = $2,
            district = $3,
            latitude = $4,
            longitude = $5
        WHERE id = $6
        RETURNING id, name, city, district, district AS cnl, latitude, longitude, created_at
      `,
      [name, city || null, district || null, latitude, longitude, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Datacenter não encontrado' });
    }

    return res.json({ ok: true, item: result.rows[0] });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Já existe datacenter com mesmo nome e coordenadas' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Erro ao editar datacenter' });
  }
});

app.delete('/api/datacenters/:id', requireAuth, requireCsrf, requirePermission('canDelete', 'excluir datacenter'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const result = await query('DELETE FROM datacenters WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Datacenter não encontrado' });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao excluir datacenter' });
  }
});

app.get('/api/datacenters/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const result = await query(
      'SELECT id, name, city, district, district AS cnl, latitude, longitude, created_at FROM datacenters WHERE id = $1',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Datacenter não encontrado' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao carregar datacenter' });
  }
});

app.post('/api/import', requireAuth, requireCsrf, requirePermission('canImport', 'importar dados'), upload.single('file'), async (req, res) => {
  const mode = String(req.body.mode || 'skip_existing').trim();

  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo obrigatório (.kml ou .kmz)' });
  }

  if (mode !== 'overwrite' && mode !== 'skip_existing') {
    return res.status(400).json({ error: 'Modo inválido' });
  }

  const originalName = (req.file.originalname || '').toLowerCase();
  if (!originalName.endsWith('.kml') && !originalName.endsWith('.kmz')) {
    return res.status(400).json({ error: 'Formato inválido. Envie .kml ou .kmz' });
  }

  try {
    const parsed = await parseKmlContextFromUpload(req.file.buffer, originalName);
    const points = extractDatacenterPoints(parsed);

    if (points.length === 0) {
      return res.status(400).json({ error: 'Nenhum ponto válido encontrado no arquivo' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let deleted = 0;
      let inserted = 0;

      if (mode === 'overwrite') {
        const del = await client.query('DELETE FROM datacenters');
        deleted = del.rowCount || 0;
      }

      for (const p of points) {
        const result = await client.query(
          `
            INSERT INTO datacenters (name, city, district, latitude, longitude)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (name, latitude, longitude) DO NOTHING
          `,
          [p.name, p.city, p.district, p.latitude, p.longitude]
        );
        inserted += result.rowCount;
      }

      await client.query('COMMIT');

      const groupedByCity = points.reduce((acc, point) => {
        const city = normalizeText(point.city) || 'Sem cidade';
        acc[city] = (acc[city] || 0) + 1;
        return acc;
      }, {});

      const citySummary = Object.entries(groupedByCity)
        .map(([city, total]) => ({ city, total }))
        .sort((a, b) => b.total - a.total || a.city.localeCompare(b.city));

      return res.json({
        ok: true,
        mode,
        totalPointsInFile: points.length,
        imported: inserted,
        ignored: points.length - inserted,
        totalCitiesInFile: citySummary.length,
        citySummary,
        deletedBeforeImport: mode === 'overwrite' ? deleted : 0,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Falha ao importar arquivo KML/KMZ' });
  }
});

app.get('/api/datacenters/by-city', requireAuth, async (_req, res) => {
  try {
    const result = await query(`
      SELECT
        COALESCE(NULLIF(TRIM(city), ''), 'Sem cidade') AS city,
        COUNT(*)::int AS total
      FROM datacenters
      GROUP BY 1
      ORDER BY total DESC, city ASC
    `);

    return res.json({ items: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao agregar datacenters por cidade' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function parseKmlContextFromUpload(buffer, originalName) {
  let kmlBuffer = buffer;

  if (originalName.endsWith('.kmz')) {
    const zip = await JSZip.loadAsync(buffer);
    const kmlFileName = Object.keys(zip.files)
      .filter((name) => name.toLowerCase().endsWith('.kml'))
      .sort((a, b) => {
        const aIsDoc = a.toLowerCase().endsWith('doc.kml') ? -1 : 0;
        const bIsDoc = b.toLowerCase().endsWith('doc.kml') ? -1 : 0;
        return aIsDoc - bIsDoc || a.localeCompare(b);
      })[0];
    if (!kmlFileName) {
      throw new Error('KMZ sem arquivo KML interno');
    }
    kmlBuffer = await zip.files[kmlFileName].async('nodebuffer');
  }

  const xml = kmlBuffer.toString('utf8');
  const xmlDoc = new DOMParser().parseFromString(xml, 'text/xml');
  const geojson = toGeoJSON.kml(xmlDoc);

  return {
    xmlDoc,
    geojson,
  };
}

function extractDatacenterPoints(parsed) {
  const hierarchicalPoints = extractHierarchicalDatacenterPoints(parsed.xmlDoc);
  if (hierarchicalPoints.length > 0) {
    return hierarchicalPoints;
  }

  const geojson = parsed.geojson;
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const points = [];

  for (const feature of features) {
    if (!feature || feature.geometry?.type !== 'Point') {
      continue;
    }

    const coords = feature.geometry.coordinates || [];
    const longitude = Number(coords[0]);
    const latitude = Number(coords[1]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const props = feature.properties || {};
    const fromDescription = parseDescriptionFields(props.description || props.Description || '');

    const name = normalizeText(
      pickFirst(props, ['name', 'Name']) || fromDescription.name || 'Datacenter sem nome'
    );

    const city = normalizeText(
      pickFirst(props, ['city', 'cidade', 'municipio', 'município']) ||
        fromDescription.city ||
        deriveCityFromName(name)
    );

    const district = normalizeText(
      pickFirst(props, ['cnl', 'district', 'bairro', 'neighborhood']) || fromDescription.district || ''
    );

    points.push({
      name,
      city: city || null,
      district: district || null,
      latitude,
      longitude,
    });
  }

  return points;
}

function extractHierarchicalDatacenterPoints(xmlDoc) {
  if (!xmlDoc?.documentElement) {
    return [];
  }

  const popsRoot = findPopsRootFolder(xmlDoc);
  if (!popsRoot) {
    return [];
  }

  const cityFolders = getDirectChildElementsByLocalName(popsRoot, 'Folder').filter((folder) => {
    return normalizeFolderName(getNodeText(getFirstChildByLocalName(folder, 'name')));
  });

  if (cityFolders.length === 0) {
    return [];
  }

  const points = [];

  for (const cityFolder of cityFolders) {
    const cityName = normalizeText(getNodeText(getFirstChildByLocalName(cityFolder, 'name')));
    if (!cityName) continue;

    const placemarks = collectPlacemarks(cityFolder);
    for (const placemark of placemarks) {
      const point = buildPointFromPlacemark(placemark, cityName);
      if (point) {
        points.push(point);
      }
    }
  }

  return points;
}

function findPopsRootFolder(xmlDoc) {
  const folders = [];
  traverseElements(xmlDoc.documentElement, (element) => {
    if (getLocalName(element) === 'Folder') {
      folders.push(element);
    }
  });

  const explicitRoot = folders.find((folder) => {
    const nameEl = getFirstChildByLocalName(folder, 'name');
    return normalizeFolderName(getNodeText(nameEl)) === 'POPS JUPITER';
  });

  if (explicitRoot) {
    return explicitRoot;
  }

  return null;
}

function collectPlacemarks(folderElement) {
  const placemarks = [];
  traverseElements(folderElement, (element) => {
    if (getLocalName(element) === 'Placemark') {
      placemarks.push(element);
    }
  });
  return placemarks;
}

function buildPointFromPlacemark(placemarkElement, cityName) {
  const pointElement = getFirstChildByLocalName(placemarkElement, 'Point');
  if (!pointElement) {
    return null;
  }

  const coordinatesText = getNodeText(getFirstChildByLocalName(pointElement, 'coordinates'));
  const [longitude, latitude] = parseKmlPointCoordinates(coordinatesText);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const properties = readPlacemarkProperties(placemarkElement);
  const fromDescription = parseDescriptionFields(properties.description || '');

  const name = normalizeText(properties.name || fromDescription.name || 'Datacenter sem nome');
  const district = normalizeText(
    properties.cnl ||
      properties.district ||
      pickFirst(properties, ['cnl', 'bairro', 'neighborhood']) ||
      fromDescription.district ||
      ''
  );

  return {
    name,
    city: cityName,
    district: district || null,
    latitude,
    longitude,
  };
}

function readPlacemarkProperties(placemarkElement) {
  const props = {};
  props.name = getNodeText(getFirstChildByLocalName(placemarkElement, 'name'));
  props.description = getNodeText(getFirstChildByLocalName(placemarkElement, 'description'));

  const extendedData = getFirstChildByLocalName(placemarkElement, 'ExtendedData');
  if (!extendedData) {
    return props;
  }

  const dataNodes = getDirectChildElementsByLocalName(extendedData, 'Data');
  for (const dataNode of dataNodes) {
    const key = String(dataNode.getAttribute('name') || '').trim().toLowerCase();
    const value = getNodeText(getFirstChildByLocalName(dataNode, 'value'));
    if (key && value) {
      props[key] = value;
    }
  }

  const simpleDataNodes = getDirectChildElementsByLocalName(extendedData, 'SimpleData');
  for (const simpleNode of simpleDataNodes) {
    const key = String(simpleNode.getAttribute('name') || '').trim().toLowerCase();
    const value = getNodeText(simpleNode);
    if (key && value) {
      props[key] = value;
    }
  }

  return props;
}

function parseKmlPointCoordinates(rawCoordinates) {
  const normalized = String(rawCoordinates || '').trim();
  if (!normalized) {
    return [NaN, NaN];
  }

  const firstTuple = normalized.split(/\s+/)[0] || '';
  const parts = firstTuple.split(',');
  const longitude = Number(parts[0]);
  const latitude = Number(parts[1]);
  return [longitude, latitude];
}

function getDirectChildElementsByLocalName(node, localName) {
  if (!node?.childNodes) {
    return [];
  }

  const children = [];
  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes[i];
    if (child?.nodeType === 1 && getLocalName(child) === localName) {
      children.push(child);
    }
  }

  return children;
}

function getFirstChildByLocalName(node, localName) {
  return getDirectChildElementsByLocalName(node, localName)[0] || null;
}

function traverseElements(node, visitor) {
  if (!node || node.nodeType !== 1) {
    return;
  }

  visitor(node);

  if (!node.childNodes) {
    return;
  }

  for (let i = 0; i < node.childNodes.length; i += 1) {
    traverseElements(node.childNodes[i], visitor);
  }
}

function getNodeText(node) {
  if (!node) return '';
  return String(node.textContent || '').trim();
}

function getLocalName(node) {
  if (!node) return '';
  return String(node.localName || node.nodeName || '')
    .split(':')
    .pop();
}

function normalizeFolderName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function pickFirst(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') {
      return String(obj[key]);
    }
  }
  return '';
}

function parseDescriptionFields(description) {
  const result = {};
  if (!description) return result;

  const text = String(description)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r/g, '')
    .trim();

  const pairs = text.split(/\n+|\s*;\s*|\s*\|\s*/);
  for (const pair of pairs) {
    const [rawKey, ...rawValue] = pair.split(':');
    if (!rawKey || rawValue.length === 0) continue;

    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join(':').trim();

    if (!value) continue;

    if (['name', 'nome'].includes(key)) result.name = value;
    if (['city', 'cidade', 'municipio', 'município'].includes(key)) result.city = value;
    if (['cnl', 'district', 'bairro', 'neighborhood'].includes(key)) result.district = value;
  }

  return result;
}

function buildDatacentersFilterClause(rawQuery) {
  const city = String(rawQuery?.city || '').trim();
  const district = String(rawQuery?.cnl || rawQuery?.district || '').trim();
  const q = String(rawQuery?.q || '').trim();
  const hasCnlRaw = String(rawQuery?.hasCnl || '').trim().toLowerCase();

  const filters = [];
  const params = [];

  if (city) {
    params.push(`%${city}%`);
    filters.push(`(city ILIKE $${params.length} OR name ILIKE $${params.length})`);
  }

  if (district) {
    params.push(`%${district}%`);
    filters.push(`(district ILIKE $${params.length} OR name ILIKE $${params.length})`);
  }

  if (q) {
    params.push(`%${q}%`);
    filters.push(`(name ILIKE $${params.length} OR city ILIKE $${params.length} OR district ILIKE $${params.length})`);
  }

  if (['false', '0', 'no', 'nao', 'não'].includes(hasCnlRaw)) {
    filters.push(`(district IS NULL OR BTRIM(district) = '')`);
  } else if (['true', '1', 'yes', 'sim'].includes(hasCnlRaw)) {
    filters.push(`(district IS NOT NULL AND BTRIM(district) <> '')`);
  }

  return {
    params,
    whereClause: filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '',
  };
}

function buildDatacentersKml(items) {
  const groupedByCity = new Map();

  for (const item of items) {
    const city = normalizeText(item.city) || 'Sem cidade';
    if (!groupedByCity.has(city)) {
      groupedByCity.set(city, []);
    }
    groupedByCity.get(city).push(item);
  }

  const cityFolders = Array.from(groupedByCity.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))
    .map(([city, cityItems]) => {
      const placemarks = cityItems
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'))
        .map((item) => {
          const name = escapeXml(item.name || 'Datacenter sem nome');
          const cnl = escapeXml(item.cnl || item.district || '');
          const cityName = escapeXml(city);
          const latitude = Number(item.latitude);
          const longitude = Number(item.longitude);
          const description = cnl
            ? `<![CDATA[<b>Cidade:</b> ${cityName}<br/><b>CNL:</b> ${cnl}]]>`
            : `<![CDATA[<b>Cidade:</b> ${cityName}]]>`;

          return `
      <Placemark>
        <name>${name}</name>
        <description>${description}</description>
        <ExtendedData>
          <Data name="city"><value>${cityName}</value></Data>
          <Data name="cnl"><value>${cnl}</value></Data>
        </ExtendedData>
        <Point>
          <coordinates>${longitude},${latitude},0</coordinates>
        </Point>
      </Placemark>`;
        })
        .join('');

      return `
    <Folder>
      <name>${escapeXml(city)}</name>
      ${placemarks}
    </Folder>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>POPS JUPITER</name>
    <Folder>
      <name>POPS JUPITER</name>
      ${cityFolders}
    </Folder>
  </Document>
</kml>`;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeText(value) {
  return String(value || '').trim().slice(0, 200);
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'sim'].includes(normalized);
}

async function getUserAccessContext(userId, userEmail = '') {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const isEnvAdmin = Boolean(adminEmail) && String(userEmail || '').trim().toLowerCase() === adminEmail;

  try {
    try {
      const result = await query(
        `
          SELECT
            u.id,
            COALESCE(u.is_admin, false) AS is_admin,
            u.group_id,
            g.name AS group_name,
            COALESCE(g.can_import, false)     AS can_import,
            COALESCE(g.can_create, false)     AS can_create,
            COALESCE(g.can_edit, false)       AS can_edit,
            COALESCE(g.can_delete, false)     AS can_delete,
            COALESCE(g.can_export_kml, false) AS can_export_kml
          FROM users u
          LEFT JOIN user_groups g ON g.id = u.group_id
          WHERE u.id = $1
        `,
        [userId]
      );

      if (result.rowCount === 0) {
        return { isAdmin: isEnvAdmin, groupId: null, groupName: null, permissions: { ...DEFAULT_PERMISSIONS } };
      }

      const row = result.rows[0];
      return {
        isAdmin: isEnvAdmin || Boolean(row.is_admin),
        groupId: row.group_id || null,
        groupName: row.group_name || null,
        permissions: {
          canImport:    Boolean(row.can_import),
          canCreate:    Boolean(row.can_create),
          canEdit:      Boolean(row.can_edit),
          canDelete:    Boolean(row.can_delete),
          canExportKml: Boolean(row.can_export_kml),
        },
      };
    } catch (error) {
      if (error?.code !== '42703') throw error;

      // Fallback: banco sem a coluna can_export_kml (migração ainda não executada)
      const result = await query(
        `
          SELECT
            u.id,
            COALESCE(u.is_admin, false) AS is_admin,
            u.group_id,
            g.name AS group_name,
            COALESCE(g.can_import, false) AS can_import,
            COALESCE(g.can_create, false) AS can_create,
            COALESCE(g.can_edit, false)   AS can_edit,
            COALESCE(g.can_delete, false) AS can_delete
          FROM users u
          LEFT JOIN user_groups g ON g.id = u.group_id
          WHERE u.id = $1
        `,
        [userId]
      );

      if (result.rowCount === 0) {
        return { isAdmin: isEnvAdmin, groupId: null, groupName: null, permissions: { ...DEFAULT_PERMISSIONS } };
      }

      const row = result.rows[0];
      return {
        isAdmin: isEnvAdmin || Boolean(row.is_admin),
        groupId: row.group_id || null,
        groupName: row.group_name || null,
        permissions: {
          canImport:    Boolean(row.can_import),
          canCreate:    Boolean(row.can_create),
          canEdit:      Boolean(row.can_edit),
          canDelete:    Boolean(row.can_delete),
          canExportKml: false,
        },
      };
    }
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return {
        isAdmin: isEnvAdmin,
        groupId: null,
        groupName: null,
        permissions: { ...DEFAULT_PERMISSIONS },
      };
    }
    throw error;
  }
}

async function getUserThemePreference(userId) {
  try {
    const result = await query('SELECT theme_preference FROM users WHERE id = $1', [userId]);
    const theme = String(result.rows?.[0]?.theme_preference || 'dark').toLowerCase();
    return ['light', 'dark'].includes(theme) ? theme : 'dark';
  } catch (error) {
    if (error?.code === '42703') {
      return 'dark';
    }
    throw error;
  }
}

function deriveCityFromName(name) {
  const raw = normalizeText(name);
  if (!raw) return '';

  const withoutPrefix = raw.replace(/^pop\s+/i, '').trim();
  const withoutUfSuffix = withoutPrefix
    .replace(/\s*-\s*[A-Za-z]{2}$/i, '')
    .replace(/\s+do\s+[A-Za-z]{2}$/i, '')
    .trim();

  return withoutUfSuffix;
}

(async () => {
  try {
    await initDatabase();
    await ensureAdminUser();

    app.listen(port, () => {
      console.log(`Servidor POPS disponível em http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Falha na inicialização da aplicação:', error);
    process.exit(1);
  }
})();
