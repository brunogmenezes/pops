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
      createTableIfMissing: true,
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

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    id: req.session.userId,
    email: req.session.userEmail,
  });
});

app.get('/api/csrf', requireAuth, (req, res) => {
  res.json({ csrfToken: getOrCreateCsrfToken(req) });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password || email.length > 200 || password.length > 200) {
      return res.status(400).json({ error: 'Credenciais inválidas' });
    }

    const result = await query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    const csrfToken = getOrCreateCsrfToken(req);

    return res.json({ ok: true, csrfToken });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno no login' });
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

app.post('/api/import', requireAuth, requireCsrf, upload.single('file'), async (req, res) => {
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
