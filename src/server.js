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
            g.created_at,
            COUNT(u.id)::int AS users_count
          FROM user_groups g
          LEFT JOIN users u ON u.group_id = g.id
          GROUP BY g.id, g.name, g.can_import, g.can_create, g.can_edit, g.can_delete, g.created_at
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

    if (!name) {
      return res.status(400).json({ error: 'Nome do grupo é obrigatório' });
    }

    const result = await query(
      `
        INSERT INTO user_groups (name, can_import, can_create, can_edit, can_delete)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, can_import, can_create, can_edit, can_delete, created_at
      `,
      [name, canImport, canCreate, canEdit, canDelete]
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
            can_delete = $5
        WHERE id = $6
        RETURNING id, name, can_import, can_create, can_edit, can_delete, created_at
      `,
      [name, canImport, canCreate, canEdit, canDelete, id]
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

    const groupId = Number(req.body.groupId);
    const password = String(req.body.password || '').trim();

    if (groupId && (!Number.isInteger(groupId) || groupId <= 0)) {
      return res.status(400).json({ error: 'Grupo inválido' });
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
      
      const passwordHash = await bcrypt.hash(password, 12);
      const result = await query(
        `
          UPDATE users
          SET group_id = COALESCE($1, group_id),
              password_hash = $2
          WHERE id = $3
          RETURNING id, email, group_id, is_admin, created_at
        `,
        [groupId || null, passwordHash, id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      return res.json({ ok: true, item: result.rows[0] });
    } else {
      const result = await query(
        `
          UPDATE users
          SET group_id = COALESCE($1, group_id)
          WHERE id = $2
          RETURNING id, email, group_id, is_admin, created_at
        `,
        [groupId || null, id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      return res.json({ ok: true, item: result.rows[0] });
    }
  } catch (error) {
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
    const city = String(req.query.city || '').trim();
    const district = String(req.query.district || '').trim();
    const q = String(req.query.q || '').trim();

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
      filters.push(
        `(name ILIKE $${params.length} OR city ILIKE $${params.length} OR district ILIKE $${params.length})`
      );
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const sql = `
      SELECT id, name, city, district, latitude, longitude, created_at
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

app.get('/api/datacenters/stats', requireAuth, async (_req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(city)::int AS with_city,
        COUNT(district)::int AS with_district,
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
    const district = normalizeText(req.body.district);
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
        RETURNING id, name, city, district, latitude, longitude, created_at
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
    const district = normalizeText(req.body.district);
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
        RETURNING id, name, city, district, latitude, longitude, created_at
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
      'SELECT id, name, city, district, latitude, longitude, created_at FROM datacenters WHERE id = $1',
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
    const geojson = await parseGeoJsonFromUpload(req.file.buffer, originalName);
    const points = extractDatacenterPoints(geojson);

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

      return res.json({
        ok: true,
        mode,
        totalPointsInFile: points.length,
        imported: inserted,
        ignored: points.length - inserted,
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

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function parseGeoJsonFromUpload(buffer, originalName) {
  let kmlBuffer = buffer;

  if (originalName.endsWith('.kmz')) {
    const zip = await JSZip.loadAsync(buffer);
    const kmlFileName = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.kml'));
    if (!kmlFileName) {
      throw new Error('KMZ sem arquivo KML interno');
    }
    kmlBuffer = await zip.files[kmlFileName].async('nodebuffer');
  }

  const xml = kmlBuffer.toString('utf8');
  const xmlDoc = new DOMParser().parseFromString(xml, 'text/xml');
  return toGeoJSON.kml(xmlDoc);
}

function extractDatacenterPoints(geojson) {
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
      pickFirst(props, ['district', 'bairro', 'neighborhood']) || fromDescription.district || ''
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
    if (['district', 'bairro', 'neighborhood'].includes(key)) result.district = value;
  }

  return result;
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
    const result = await query(
      `
        SELECT
          u.id,
          COALESCE(u.is_admin, false) AS is_admin,
          u.group_id,
          g.name AS group_name,
          COALESCE(g.can_import, false) AS can_import,
          COALESCE(g.can_create, false) AS can_create,
          COALESCE(g.can_edit, false) AS can_edit,
          COALESCE(g.can_delete, false) AS can_delete
        FROM users u
        LEFT JOIN user_groups g ON g.id = u.group_id
        WHERE u.id = $1
      `,
      [userId]
    );

    if (result.rowCount === 0) {
      return {
        isAdmin: isEnvAdmin,
        groupId: null,
        groupName: null,
        permissions: { ...DEFAULT_PERMISSIONS },
      };
    }

    const row = result.rows[0];
    return {
      isAdmin: isEnvAdmin || Boolean(row.is_admin),
      groupId: row.group_id || null,
      groupName: row.group_name || null,
      permissions: {
        canImport: Boolean(row.can_import),
        canCreate: Boolean(row.can_create),
        canEdit: Boolean(row.can_edit),
        canDelete: Boolean(row.can_delete),
      },
    };
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
