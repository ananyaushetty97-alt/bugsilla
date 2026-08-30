import express from 'express';
import initSqlJs from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import multer from 'multer';
import nodemailer from 'nodemailer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(__dirname, '..', 'data');
mkdirSync(dataDirectory, { recursive: true });

const databasePath = join(dataDirectory, 'bugsilla.sqlite');
const uploadsDirectory = join(dataDirectory, 'uploads');
mkdirSync(uploadsDirectory, { recursive: true });

const priorities = new Set(['Low', 'Medium', 'High']);
const statuses = new Set(['Open', 'In Progress', 'Resolved', 'Closed']);
const app = express();
const eventClients = new Set();
const isProduction = process.env.NODE_ENV === 'production';
const authAttempts = new Map();
const uploadAttempts = new Map();
const clientAddress = (req) => req.ip || req.socket.remoteAddress || 'unknown';
const withinRateLimit = (store, key, limit, windowMs) => {
  const now = Date.now();
  const recent = (store.get(key) || []).filter((time) => now - time < windowMs);
  recent.push(now); store.set(key, recent);
  return recent.length <= limit;
};
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  if (isProduction && !req.secure) return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.get('origin')) {
    const expectedOrigin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (req.get('origin') !== expectedOrigin) return res.status(403).json({ error: 'Invalid request origin.' });
  }
  return next();
});
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([name]) => name));
  next();
});
const broadcastIssueEvent = (issueId, type = 'updated') => {
  const message = `data: ${JSON.stringify({ issueId: Number(issueId), type })}\n\n`;
  eventClients.forEach((client) => client.write(message));
};
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsDirectory),
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${randomBytes(8).toString('hex')}${file.originalname.includes('.') ? file.originalname.slice(file.originalname.lastIndexOf('.')) : ''}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowedTypes = new Set(['application/pdf', 'text/plain', 'text/x-log', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/zip', 'text/x-diff', 'text/x-patch']);
    callback(null, allowedTypes.has(file.mimetype));
  }
});

function row(result) {
  if (!result.length || !result[0].values.length) return null;
  return Object.fromEntries(result[0].columns.map((column, index) => [column, result[0].values[0][index]]));
}

function rows(result) {
  if (!result.length) return [];
  return result[0].values.map((values) =>
    Object.fromEntries(result[0].columns.map((column, index) => [column, values[index]]))
  );
}

async function start() {
  const SQL = await initSqlJs();
  const db = existsSync(databasePath) ? new SQL.Database(readFileSync(databasePath)) : new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open',
      priority TEXT NOT NULL DEFAULT 'Medium',
      created_at TEXT NOT NULL,
      assignee TEXT
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      author TEXT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id)
    );
    CREATE INDEX IF NOT EXISTS comments_issue_created_at
      ON comments (issue_id, created_at)
    ;
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      UNIQUE (product_id, name),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      UNIQUE (product_id, name),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      UNIQUE (product_id, name),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS user_groups (
      user_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, group_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );
    CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      query_params TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      field_changed TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id)
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER NOT NULL,
      uploaded_by TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id)
    );
    CREATE TABLE IF NOT EXISTS issue_watchers (
      issue_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (issue_id, user_id),
      FOREIGN KEY (issue_id) REFERENCES issues(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS issue_dependencies (
      blocking_issue_id INTEGER NOT NULL,
      blocked_issue_id INTEGER NOT NULL,
      PRIMARY KEY (blocking_issue_id, blocked_issue_id),
      FOREIGN KEY (blocking_issue_id) REFERENCES issues(id),
      FOREIGN KEY (blocked_issue_id) REFERENCES issues(id)
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS issue_keywords (
      issue_id INTEGER NOT NULL,
      keyword_id INTEGER NOT NULL,
      PRIMARY KEY (issue_id, keyword_id),
      FOREIGN KEY (issue_id) REFERENCES issues(id),
      FOREIGN KEY (keyword_id) REFERENCES keywords(id)
    );
  `);
  const commentColumns = rows(db.exec('PRAGMA table_info(comments)'));
  if (commentColumns.some((column) => column.name === 'body') && !commentColumns.some((column) => column.name === 'text')) {
    db.run('ALTER TABLE comments RENAME COLUMN body TO text');
  }

  const issueColumns = new Set(rows(db.exec('PRAGMA table_info(issues)')).map((column) => column.name));
  const newIssueColumns = [
    ['product_id', 'INTEGER'],
    ['component_id', 'INTEGER'],
    ['version_id', 'INTEGER'],
    ['milestone_id', 'INTEGER'],
    ['reporter_id', 'INTEGER'],
    ['group_id', 'INTEGER']
  ];
  let catalogChanged = false;
  newIssueColumns.forEach(([name, type]) => {
    if (!issueColumns.has(name)) {
      db.run(`ALTER TABLE issues ADD COLUMN ${name} ${type}`);
      catalogChanged = true;
    }
  });
  if (row(db.exec('SELECT COUNT(*) AS total FROM products')).total === 0) {
    db.run("INSERT INTO products (name) VALUES ('Bugsilla')");
    const product = row(db.exec('SELECT id FROM products WHERE name = ?', ['Bugsilla']));
    db.run('INSERT INTO components (product_id, name) VALUES (?, ?), (?, ?), (?, ?)', [product.id, 'Frontend', product.id, 'API', product.id, 'Infrastructure']);
    db.run('INSERT INTO versions (product_id, name) VALUES (?, ?), (?, ?)', [product.id, '1.0', product.id, '1.1']);
    db.run('INSERT INTO milestones (product_id, name) VALUES (?, ?), (?, ?)', [product.id, 'Next release', product.id, 'Backlog']);
    catalogChanged = true;
  }
  if (row(db.exec('SELECT COUNT(*) AS total FROM groups')).total === 0) {
    db.run("INSERT INTO groups (name) VALUES ('Public'), ('Security')");
    catalogChanged = true;
  }
  const saveDatabase = () => writeFileSync(databasePath, Buffer.from(db.export()));
  db.run("UPDATE issues SET priority = 'Medium' WHERE priority NOT IN ('Low', 'Medium', 'High')");
  if (catalogChanged) saveDatabase();

  const publicGroup = () => row(db.exec("SELECT id FROM groups WHERE name = 'Public'"));
  const cookieSecurity = isProduction ? '; Secure' : '';
  const sessionCookie = (token) => `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}${cookieSecurity}`;
  const clearSessionCookie = `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieSecurity}`;
  const hashPassword = (password) => {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  };
  const passwordMatches = (password, stored) => {
    const [salt, expected] = stored.split(':');
    if (!salt || !expected) return false;
    const actual = scryptSync(password, salt, 64).toString('hex');
    return actual.length === expected.length && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  };
  const userShape = (user) => ({ id: user.id, email: user.email, name: user.name, role: user.role });
  const issueVisibility = (user, alias = 'i') => user.role === 'admin'
    ? { clause: '', bindings: [] }
    : { clause: ` AND ${alias ? `${alias}.` : ''}group_id IN (SELECT group_id FROM user_groups WHERE user_id = ?)`, bindings: [user.id] };
  const requireAuth = (req, res, next) => {
    const token = req.cookies.session;
    const user = token && row(db.exec(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`, [token, new Date().toISOString()]));
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    req.user = user;
    return next();
  };
  const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    return next();
  };
  const canAccessIssue = (user, issueId) => user.role === 'admin' || Boolean(row(db.exec('SELECT i.id FROM issues i WHERE i.id = ? AND i.group_id IN (SELECT group_id FROM user_groups WHERE user_id = ?)', [issueId, user.id])));
  const notifyIssueChange = async (issueId, actor, summary) => {
    const issue = row(db.exec('SELECT i.title, reporter.email AS reporter_email, assignee_user.email AS assignee_email FROM issues i LEFT JOIN users reporter ON reporter.id = i.reporter_id LEFT JOIN users assignee_user ON assignee_user.name = i.assignee WHERE i.id = ?', [issueId]));
    if (!issue) return;
    const watcherEmails = rows(db.exec('SELECT u.email FROM issue_watchers w JOIN users u ON u.id = w.user_id WHERE w.issue_id = ?', [issueId])).map((item) => item.email);
    const recipients = [...new Set([issue.reporter_email, issue.assignee_email, ...watcherEmails].filter((email) => email && email !== actor.email))];
    const subject = `Bugsilla #${issueId}: ${issue.title}`;
    const body = `${actor.name} ${summary}.\n\nOpen the issue in Bugsilla for details.`;
    recipients.forEach((recipient) => db.run('INSERT INTO notification_outbox (recipient, subject, body, created_at) VALUES (?, ?, ?, ?)', [recipient, subject, body, new Date().toISOString()]));
    saveDatabase();
    if (recipients.length && process.env.SMTP_URL) {
      const transporter = nodemailer.createTransport(process.env.SMTP_URL);
      await Promise.all(recipients.map((recipient) => transporter.sendMail({ from: process.env.SMTP_FROM || 'bugsilla@localhost', to: recipient, subject, text: body })));
      db.run('UPDATE notification_outbox SET sent_at = ? WHERE subject = ? AND sent_at IS NULL', [new Date().toISOString(), subject]);
      saveDatabase();
    }
  };

  app.post('/api/auth/signup', (req, res) => {
    if (!withinRateLimit(authAttempts, clientAddress(req), 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!/^\S+@\S+\.\S+$/.test(email) || !name || password.length < 8) return res.status(400).json({ error: 'Provide a name, valid email, and password of at least 8 characters.' });
    if (row(db.exec('SELECT id FROM users WHERE email = ?', [email]))) return res.status(409).json({ error: 'An account with that email already exists.' });
    const role = row(db.exec('SELECT COUNT(*) AS total FROM users')).total === 0 ? 'admin' : 'member';
    db.run('INSERT INTO users (email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)', [email, hashPassword(password), name, role, new Date().toISOString()]);
    const user = row(db.exec('SELECT * FROM users WHERE id = last_insert_rowid()'));
    db.run('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)', [user.id, publicGroup().id]);
    const token = randomBytes(32).toString('hex');
    db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, user.id, new Date(Date.now() + 604800000).toISOString()]);
    saveDatabase();
    res.set('Set-Cookie', sessionCookie(token));
    return res.status(201).json({ user: userShape(user) });
  });
  app.post('/api/auth/login', (req, res) => {
    if (!withinRateLimit(authAttempts, clientAddress(req), 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = row(db.exec('SELECT * FROM users WHERE email = ?', [email]));
    if (!user || !passwordMatches(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password.' });
    const token = randomBytes(32).toString('hex');
    db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, user.id, new Date(Date.now() + 604800000).toISOString()]);
    saveDatabase();
    res.set('Set-Cookie', sessionCookie(token));
    return res.json({ user: userShape(user) });
  });
  app.post('/api/auth/logout', requireAuth, (req, res) => {
    db.run('DELETE FROM sessions WHERE token = ?', [req.cookies.session]);
    saveDatabase();
    res.set('Set-Cookie', clearSessionCookie);
    return res.status(204).end();
  });
  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: userShape(req.user) }));
  app.get('/api/events', requireAuth, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    eventClients.add(res);
    req.on('close', () => eventClients.delete(res));
  });
  app.get('/api/users', requireAuth, (_req, res) => res.json(rows(db.exec('SELECT id, name, email, role FROM users ORDER BY name'))));
  app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => res.json(rows(db.exec('SELECT id, name, email, role, created_at FROM users ORDER BY name'))));
  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    const role = req.body.role;
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be admin or member.' });
    const user = row(db.exec('SELECT id FROM users WHERE id = ?', [req.params.id]));
    if (!user) return res.status(404).json({ error: 'User not found.' });
    db.run('UPDATE users SET role = ? WHERE id = ?', [role, user.id]); saveDatabase();
    return res.json(row(db.exec('SELECT id, name, email, role FROM users WHERE id = ?', [user.id])));
  });

  const parseOptionalId = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const id = Number.parseInt(value, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const issueSelect = `SELECT i.*, p.name AS product_name, c.name AS component_name,
    v.name AS version_name, m.name AS milestone_name, reporter.name AS reporter_name,
    issue_group.name AS group_name
    FROM issues i
    LEFT JOIN products p ON p.id = i.product_id
    LEFT JOIN components c ON c.id = i.component_id
    LEFT JOIN versions v ON v.id = i.version_id
    LEFT JOIN milestones m ON m.id = i.milestone_id
    LEFT JOIN users reporter ON reporter.id = i.reporter_id
    LEFT JOIN groups issue_group ON issue_group.id = i.group_id`;

  app.post('/api/issues', requireAuth, (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  const priority = priorities.has(req.body.priority) ? req.body.priority : 'Medium';
  const productId = parseOptionalId(req.body.productId);
  const componentId = parseOptionalId(req.body.componentId);
  const versionId = parseOptionalId(req.body.versionId);
  const milestoneId = parseOptionalId(req.body.milestoneId);
  const requestedGroupId = parseOptionalId(req.body.groupId);
  const keywordIds = Array.isArray(req.body.keywordIds) ? [...new Set(req.body.keywordIds.map(parseOptionalId).filter(Boolean))] : [];

  if (!title) {
    return res.status(400).json({ error: 'A title is required.' });
  }
  if (!description) {
    return res.status(400).json({ error: 'A description is required.' });
  }
  if (title.length > 255) {
    return res.status(400).json({ error: 'Title must be 255 characters or fewer.' });
  }
  const product = productId && row(db.exec('SELECT id FROM products WHERE id = ?', [productId]));
  const component = componentId && product && row(db.exec('SELECT id FROM components WHERE id = ? AND product_id = ?', [componentId, productId]));
  const version = versionId && product && row(db.exec('SELECT id FROM versions WHERE id = ? AND product_id = ?', [versionId, productId]));
  const milestone = milestoneId && product && row(db.exec('SELECT id FROM milestones WHERE id = ? AND product_id = ?', [milestoneId, productId]));
  if (!product) return res.status(400).json({ error: 'Choose a valid product.' });
  if (!component) return res.status(400).json({ error: 'Choose a valid component for that product.' });
  if (versionId && !version) return res.status(400).json({ error: 'Choose a valid version for that product.' });
  if (milestoneId && !milestone) return res.status(400).json({ error: 'Choose a valid target milestone for that product.' });
  const group = requestedGroupId ? row(db.exec('SELECT id FROM groups WHERE id = ?', [requestedGroupId])) : publicGroup();
  if (!group) return res.status(400).json({ error: 'Choose a valid visibility group.' });
  if (req.user.role !== 'admin' && group.id !== publicGroup().id) return res.status(403).json({ error: 'Only administrators can create restricted issues.' });

    db.run(`
    INSERT INTO issues (title, description, status, priority, created_at, assignee, product_id, component_id, version_id, milestone_id, reporter_id, group_id)
    VALUES (?, ?, 'Open', ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `, [title, description, priority, new Date().toISOString(), productId, componentId, versionId, milestoneId, req.user.id, group.id]);
    const issue = row(db.exec(`${issueSelect} WHERE i.id = last_insert_rowid()`));
    if (keywordIds.length) {
      const total = row(db.exec(`SELECT COUNT(*) AS total FROM keywords WHERE id IN (${keywordIds.map(() => '?').join(', ')})`, keywordIds)).total;
      if (total !== keywordIds.length) return res.status(400).json({ error: 'Choose valid keywords.' });
      keywordIds.forEach((keywordId) => db.run('INSERT INTO issue_keywords (issue_id, keyword_id) VALUES (?, ?)', [issue.id, keywordId]));
    }
    saveDatabase();

    return res.status(201).json({ id: issue.id });
  });

  app.get('/api/issues', requireAuth, (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 25;
    const offset = Number.isInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const priority = typeof req.query.priority === 'string' ? req.query.priority : '';
    const keyword = parseOptionalId(req.query.keyword);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (status && !statuses.has(status)) return res.status(400).json({ error: 'Invalid status filter.' });
    if (priority && !priorities.has(priority)) return res.status(400).json({ error: 'Invalid priority filter.' });
    if (query.length > 100) return res.status(400).json({ error: 'Search terms must be 100 characters or fewer.' });

    const conditions = [];
    const bindings = [];
    if (status) {
      conditions.push('i.status = ?');
      bindings.push(status);
    }
    if (priority) {
      conditions.push('i.priority = ?');
      bindings.push(priority);
    }
    if (query) {
      conditions.push('(i.title LIKE ? OR i.description LIKE ?)');
      bindings.push(`%${query}%`, `%${query}%`);
    }
    if (req.query.keyword && !keyword) return res.status(400).json({ error: 'Invalid keyword filter.' });
    if (keyword) { conditions.push('i.id IN (SELECT issue_id FROM issue_keywords WHERE keyword_id = ?)'); bindings.push(keyword); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const visibility = issueVisibility(req.user);
    const visibleWhere = where ? `${where}${visibility.clause}` : (visibility.clause ? ` WHERE ${visibility.clause.slice(5)}` : '');
    const issues = rows(db.exec(
      `${issueSelect}${visibleWhere} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
      [...bindings, ...visibility.bindings, limit, offset]
    ));
    const total = row(db.exec(`SELECT COUNT(*) AS total FROM issues i${visibleWhere}`, [...bindings, ...visibility.bindings])).total;

    res.set('X-Total-Count', String(total));
    res.set('X-Page-Limit', String(limit));
    res.set('X-Page-Offset', String(offset));
    return res.json(issues);
  });

  app.get('/api/products', requireAuth, (_req, res) => {
    return res.json(rows(db.exec('SELECT * FROM products ORDER BY name')));
  });

  function catalogList(table) {
    return (req, res) => {
      const productId = parseOptionalId(req.query.product_id);
      if (!productId) return res.status(400).json({ error: 'A valid product_id is required.' });
      return res.json(rows(db.exec(`SELECT * FROM ${table} WHERE product_id = ? ORDER BY name`, [productId])));
    };
  }
  app.get('/api/components', requireAuth, catalogList('components'));
  app.get('/api/versions', requireAuth, catalogList('versions'));
  app.get('/api/milestones', requireAuth, catalogList('milestones'));

  function catalogCreate(table, requiresProduct = true) {
    return (req, res) => {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const productId = parseOptionalId(req.body.productId);
      if (!name || name.length > 120) return res.status(400).json({ error: 'Name is required and must be 120 characters or fewer.' });
      if (requiresProduct && !row(db.exec('SELECT id FROM products WHERE id = ?', [productId]))) return res.status(400).json({ error: 'Choose a valid product.' });
      db.run(requiresProduct ? `INSERT INTO ${table} (product_id, name) VALUES (?, ?)` : `INSERT INTO ${table} (name) VALUES (?)`, requiresProduct ? [productId, name] : [name]);
      const entity = row(db.exec(`SELECT * FROM ${table} WHERE id = last_insert_rowid()`));
      saveDatabase();
      return res.status(201).json(entity);
    };
  }
  function catalogUpdate(table) {
    return (req, res) => {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name || name.length > 120) return res.status(400).json({ error: 'Name is required and must be 120 characters or fewer.' });
      const entity = row(db.exec(`SELECT id FROM ${table} WHERE id = ?`, [req.params.id]));
      if (!entity) return res.status(404).json({ error: 'Catalog item not found.' });
      db.run(`UPDATE ${table} SET name = ? WHERE id = ?`, [name, entity.id]);
      saveDatabase();
      return res.json(row(db.exec(`SELECT * FROM ${table} WHERE id = ?`, [entity.id])));
    };
  }
  function catalogDelete(table) {
    return (req, res) => {
      const entity = row(db.exec(`SELECT id FROM ${table} WHERE id = ?`, [req.params.id]));
      if (!entity) return res.status(404).json({ error: 'Catalog item not found.' });
      db.run(`DELETE FROM ${table} WHERE id = ?`, [entity.id]);
      saveDatabase();
      return res.status(204).end();
    };
  }
  [['products', false], ['components', true], ['versions', true], ['milestones', true]].forEach(([table, requiresProduct]) => {
    app.post(`/api/${table}`, requireAuth, requireAdmin, catalogCreate(table, requiresProduct));
    app.patch(`/api/${table}/:id`, requireAuth, requireAdmin, catalogUpdate(table));
    app.delete(`/api/${table}/:id`, requireAuth, requireAdmin, catalogDelete(table));
  });

  app.get('/api/groups', requireAuth, (req, res) => {
    if (req.user.role === 'admin') return res.json(rows(db.exec('SELECT * FROM groups ORDER BY name')));
    return res.json(rows(db.exec('SELECT g.* FROM groups g JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = ? ORDER BY g.name', [req.user.id])));
  });
  app.post('/api/groups', requireAuth, requireAdmin, catalogCreate('groups', false));
  app.patch('/api/groups/:id', requireAuth, requireAdmin, catalogUpdate('groups'));
  app.delete('/api/groups/:id', requireAuth, requireAdmin, catalogDelete('groups'));
  app.post('/api/groups/:id/members', requireAuth, requireAdmin, (req, res) => {
    const userId = parseOptionalId(req.body.userId);
    if (!row(db.exec('SELECT id FROM users WHERE id = ?', [userId])) || !row(db.exec('SELECT id FROM groups WHERE id = ?', [req.params.id]))) return res.status(404).json({ error: 'User or group not found.' });
    db.run('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)', [userId, req.params.id]);
    saveDatabase();
    return res.status(204).end();
  });
  app.get('/api/keywords', requireAuth, (_req, res) => res.json(rows(db.exec('SELECT * FROM keywords ORDER BY name'))));
  app.post('/api/keywords', requireAuth, requireAdmin, catalogCreate('keywords', false));
  app.patch('/api/keywords/:id', requireAuth, requireAdmin, catalogUpdate('keywords'));
  app.delete('/api/keywords/:id', requireAuth, requireAdmin, catalogDelete('keywords'));
  app.get('/api/saved-searches', requireAuth, (req, res) => {
    const searches = rows(db.exec('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC', [req.user.id])).map((search) => ({ ...search, query_params: JSON.parse(search.query_params) }));
    return res.json(searches);
  });
  app.post('/api/saved-searches', requireAuth, (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const queryParams = req.body.queryParams;
    if (!name || name.length > 120 || !queryParams || typeof queryParams !== 'object') return res.status(400).json({ error: 'Provide a search name and filter criteria.' });
    const cleanParams = { q: typeof queryParams.q === 'string' ? queryParams.q.slice(0, 100) : '', status: statuses.has(queryParams.status) ? queryParams.status : '', priority: priorities.has(queryParams.priority) ? queryParams.priority : '', keyword: parseOptionalId(queryParams.keyword) ? String(parseOptionalId(queryParams.keyword)) : '' };
    db.run('INSERT INTO saved_searches (user_id, name, query_params, created_at) VALUES (?, ?, ?, ?)', [req.user.id, name, JSON.stringify(cleanParams), new Date().toISOString()]);
    const search = row(db.exec('SELECT * FROM saved_searches WHERE id = last_insert_rowid()'));
    saveDatabase();
    return res.status(201).json({ ...search, query_params: cleanParams });
  });
  app.delete('/api/saved-searches/:id', requireAuth, (req, res) => {
    const search = row(db.exec('SELECT id FROM saved_searches WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]));
    if (!search) return res.status(404).json({ error: 'Saved search not found.' });
    db.run('DELETE FROM saved_searches WHERE id = ?', [search.id]);
    saveDatabase();
    return res.status(204).end();
  });

  app.get('/api/stats', requireAuth, (req, res) => {
    const visibility = issueVisibility(req.user, '');
    const clause = visibility.clause ? visibility.clause.slice(5) : '';
    const groupedCounts = rows(db.exec(`SELECT status, COUNT(*) AS count FROM issues${clause ? ` WHERE ${clause}` : ''} GROUP BY status`, visibility.bindings));
    const counts = Object.fromEntries([...statuses].map((status) => [status, 0]));
    groupedCounts.forEach(({ status, count }) => {
      if (statuses.has(status)) counts[status] = count;
    });
    return res.json(counts);
  });

  app.patch('/api/issues/:id', requireAuth, (req, res) => {
    const status = req.body.status;
    const priority = req.body.priority;
    const assignee = req.body.assignee;
    const updates = [];
    const bindings = [];
    if (status !== undefined && !statuses.has(status)) {
      return res.status(400).json({ error: 'Status must be Open, In Progress, Resolved, or Closed.' });
    }
    if (priority !== undefined && !priorities.has(priority)) {
      return res.status(400).json({ error: 'Priority must be Low, Medium, or High.' });
    }
    if (assignee !== undefined && assignee !== null && !row(db.exec('SELECT id FROM users WHERE name = ?', [assignee]))) {
      return res.status(400).json({ error: 'Assignee must be an existing user.' });
    }
    if (status !== undefined) {
      updates.push('status = ?');
      bindings.push(status);
    }
    if (priority !== undefined) {
      updates.push('priority = ?');
      bindings.push(priority);
    }
    if (assignee !== undefined) {
      updates.push('assignee = ?');
      bindings.push(assignee || null);
    }
    if (!updates.length) return res.status(400).json({ error: 'Provide a status, priority, or assignee to update.' });

    const issue = row(db.exec('SELECT id, status, priority, assignee, group_id FROM issues WHERE id = ?', [req.params.id]));
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    const visibility = issueVisibility(req.user);
    if (visibility.bindings.length && !row(db.exec(`SELECT id FROM issues i WHERE i.id = ?${visibility.clause}`, [issue.id, ...visibility.bindings]))) return res.status(404).json({ error: 'Issue not found.' });

    db.run('BEGIN');
    db.run(`UPDATE issues SET ${updates.join(', ')} WHERE id = ?`, [...bindings, req.params.id]);
    [['status', status], ['priority', priority], ['assignee', assignee]].forEach(([field, value]) => {
      if (value !== undefined && String(issue[field] ?? '') !== String(value ?? '')) db.run('INSERT INTO activity_log (issue_id, field_changed, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)', [issue.id, field, issue[field], value ?? null, req.user.name, new Date().toISOString()]);
    });
    db.run('COMMIT');
    saveDatabase();
    void notifyIssueChange(issue.id, req.user, 'updated this issue').catch(() => {});
    broadcastIssueEvent(issue.id);
    return res.json({ id: issue.id, status: status ?? issue.status, priority: priority ?? issue.priority, assignee: assignee === undefined ? issue.assignee : (assignee || null) });
  });

  app.post('/api/issues/:id/watch', requireAuth, (req, res) => {
    if (!canAccessIssue(req.user, req.params.id)) return res.status(404).json({ error: 'Issue not found.' });
    db.run('INSERT OR IGNORE INTO issue_watchers (issue_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id]);
    saveDatabase();
    broadcastIssueEvent(req.params.id, 'watchers-changed');
    return res.status(204).end();
  });
  app.delete('/api/issues/:id/watch', requireAuth, (req, res) => {
    if (!canAccessIssue(req.user, req.params.id)) return res.status(404).json({ error: 'Issue not found.' });
    db.run('DELETE FROM issue_watchers WHERE issue_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    saveDatabase();
    broadcastIssueEvent(req.params.id, 'watchers-changed');
    return res.status(204).end();
  });
  app.post('/api/issues/:id/attachments', requireAuth, upload.single('file'), (req, res) => {
    if (!withinRateLimit(uploadAttempts, `${req.user.id}:${clientAddress(req)}`, 30, 60 * 60 * 1000)) return res.status(429).json({ error: 'Upload limit reached. Try again later.' });
    if (!canAccessIssue(req.user, req.params.id)) return res.status(404).json({ error: 'Issue not found.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
    db.run('INSERT INTO attachments (issue_id, filename, storage_path, mime_type, size, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.params.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.name, new Date().toISOString()]);
    const attachment = row(db.exec('SELECT * FROM attachments WHERE id = last_insert_rowid()'));
    saveDatabase();
    broadcastIssueEvent(req.params.id, 'attachment-added');
    return res.status(201).json({ ...attachment, url: `/api/attachments/${attachment.id}/download` });
  });
  app.get('/api/attachments/:id/download', requireAuth, (req, res) => {
    const attachment = row(db.exec('SELECT * FROM attachments WHERE id = ?', [req.params.id]));
    if (!attachment || !canAccessIssue(req.user, attachment.issue_id)) return res.status(404).json({ error: 'Attachment not found.' });
    return res.download(join(uploadsDirectory, attachment.storage_path), attachment.filename);
  });
  app.post('/api/issues/:id/dependencies', requireAuth, (req, res) => {
    const blockedId = parseOptionalId(req.body.blockedIssueId);
    if (!blockedId || String(blockedId) === String(req.params.id) || !canAccessIssue(req.user, req.params.id) || !canAccessIssue(req.user, blockedId)) return res.status(400).json({ error: 'Choose another accessible issue.' });
    db.run('INSERT OR IGNORE INTO issue_dependencies (blocking_issue_id, blocked_issue_id) VALUES (?, ?)', [req.params.id, blockedId]);
    saveDatabase();
    broadcastIssueEvent(req.params.id, 'dependency-added');
    broadcastIssueEvent(blockedId, 'dependency-added');
    return res.status(204).end();
  });
  app.delete('/api/issues/:id/dependencies/:blockedId', requireAuth, (req, res) => {
    if (!canAccessIssue(req.user, req.params.id)) return res.status(404).json({ error: 'Issue not found.' });
    db.run('DELETE FROM issue_dependencies WHERE blocking_issue_id = ? AND blocked_issue_id = ?', [req.params.id, req.params.blockedId]);
    saveDatabase();
    broadcastIssueEvent(req.params.id, 'dependency-removed');
    broadcastIssueEvent(req.params.blockedId, 'dependency-removed');
    return res.status(204).end();
  });
  app.post('/api/issues/:id/keywords', requireAuth, (req, res) => {
    const keywordId = parseOptionalId(req.body.keywordId);
    if (!keywordId || !canAccessIssue(req.user, req.params.id) || !row(db.exec('SELECT id FROM keywords WHERE id = ?', [keywordId]))) return res.status(400).json({ error: 'Choose a valid keyword and issue.' });
    db.run('INSERT OR IGNORE INTO issue_keywords (issue_id, keyword_id) VALUES (?, ?)', [req.params.id, keywordId]); saveDatabase();
    broadcastIssueEvent(req.params.id, 'keywords-changed');
    return res.status(204).end();
  });
  app.delete('/api/issues/:id/keywords/:keywordId', requireAuth, (req, res) => {
    if (!canAccessIssue(req.user, req.params.id)) return res.status(404).json({ error: 'Issue not found.' });
    db.run('DELETE FROM issue_keywords WHERE issue_id = ? AND keyword_id = ?', [req.params.id, req.params.keywordId]); saveDatabase();
    broadcastIssueEvent(req.params.id, 'keywords-changed');
    return res.status(204).end();
  });

  app.post('/api/issues/:id/comments', requireAuth, (req, res) => {
    const issue = row(db.exec('SELECT id, group_id FROM issues WHERE id = ?', [req.params.id]));
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    const visibility = issueVisibility(req.user);
    if (visibility.bindings.length && !row(db.exec(`SELECT id FROM issues i WHERE i.id = ?${visibility.clause}`, [issue.id, ...visibility.bindings]))) return res.status(404).json({ error: 'Issue not found.' });

    const author = req.user.name;
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'A comment is required.' });
    if (text.length > 5000) return res.status(400).json({ error: 'Comments must be 5,000 characters or fewer.' });

    db.run(
      'INSERT INTO comments (issue_id, author, text, created_at) VALUES (?, ?, ?, ?)',
      [issue.id, author, text, new Date().toISOString()]
    );
    const comment = row(db.exec('SELECT * FROM comments WHERE id = last_insert_rowid()'));
    saveDatabase();
    void notifyIssueChange(issue.id, req.user, 'commented on this issue').catch(() => {});
    broadcastIssueEvent(issue.id, 'comment-added');
    return res.status(201).json(comment);
  });

  app.get('/api/issues/:id', requireAuth, (req, res) => {
    const issue = row(db.exec(`${issueSelect} WHERE i.id = ?`, [req.params.id]));
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    const visibility = issueVisibility(req.user);
    if (visibility.bindings.length && !row(db.exec(`SELECT id FROM issues i WHERE i.id = ?${visibility.clause}`, [issue.id, ...visibility.bindings]))) return res.status(404).json({ error: 'Issue not found.' });
    const comments = rows(db.exec(
      'SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC',
      [req.params.id]
    ));
    const activity = rows(db.exec('SELECT * FROM activity_log WHERE issue_id = ? ORDER BY changed_at ASC', [issue.id]));
    const attachments = rows(db.exec('SELECT * FROM attachments WHERE issue_id = ? ORDER BY uploaded_at DESC', [issue.id])).map((attachment) => ({ ...attachment, url: `/api/attachments/${attachment.id}/download` }));
    const watchers = rows(db.exec('SELECT u.id, u.name FROM issue_watchers w JOIN users u ON u.id = w.user_id WHERE w.issue_id = ? ORDER BY u.name', [issue.id]));
    const blocks = rows(db.exec('SELECT i.id, i.title FROM issue_dependencies d JOIN issues i ON i.id = d.blocked_issue_id WHERE d.blocking_issue_id = ?', [issue.id]));
    const dependsOn = rows(db.exec('SELECT i.id, i.title FROM issue_dependencies d JOIN issues i ON i.id = d.blocking_issue_id WHERE d.blocked_issue_id = ?', [issue.id]));
    const keywords = rows(db.exec('SELECT k.* FROM issue_keywords ik JOIN keywords k ON k.id = ik.keyword_id WHERE ik.issue_id = ? ORDER BY k.name', [issue.id]));
    return res.json({ ...issue, comments, activity, attachments, watchers, watching: watchers.some((watcher) => watcher.id === req.user.id), blocks, dependsOn, keywords });
  });

  if (isProduction) {
    const clientDirectory = join(__dirname, '..', 'dist');
    app.use(express.static(clientDirectory, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(clientDirectory, 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Files must be 10 MB or smaller.' : 'Invalid upload.' });
    if (error) return res.status(400).json({ error: 'Invalid upload. Use an allowed image, text, patch, PDF, or ZIP file.' });
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.listen(process.env.PORT || 3001, () => console.log(`API listening on port ${process.env.PORT || 3001}`));
}

start().catch((error) => {
  console.error('Unable to start Bugsilla API:', error);
  process.exitCode = 1;
});
