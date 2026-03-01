const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const multer = require('multer');
const { getDb, generateLicenseKey } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret-key';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth middleware ---
function requireAdmin(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.redirect('/admin/login');
  try {
    const [id, hash] = Buffer.from(token, 'base64').toString().split(':');
    const db = getDb();
    const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(id);
    if (!admin) return res.redirect('/admin/login');
    const expected = crypto.createHmac('sha256', ADMIN_SECRET)
      .update(admin.id + ':' + admin.password_hash).digest('hex');
    if (hash !== expected) return res.redirect('/admin/login');
    req.admin = admin;
    next();
  } catch { res.redirect('/admin/login'); }
}

function requireAdminApi(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [id, hash] = Buffer.from(token, 'base64').toString().split(':');
    const db = getDb();
    const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(id);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    const expected = crypto.createHmac('sha256', ADMIN_SECRET)
      .update(admin.id + ':' + admin.password_hash).digest('hex');
    if (hash !== expected) return res.status(401).json({ error: 'Unauthorized' });
    req.admin = admin;
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}

function ensureAdmin() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM admin').get().c;
  if (count === 0) {
    const hash = bcrypt.hashSync('admin', 10);
    db.prepare('INSERT INTO admin (username, password_hash) VALUES (?, ?)').run('admin', hash);
    console.log('Default admin created — login: admin / password: admin');
  }
}

// =============================================
// API: License validation (called by the app)
// =============================================
app.post('/api/validate', (req, res) => {
  const { key, email, hwid } = req.body;
  if (!key || !email || !hwid) {
    return res.json({ valid: false, message: 'Missing required fields.' });
  }

  const db = getDb();
  const license = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);

  if (!license) {
    logActivation(null, hwid, req.ip, 'validate_not_found');
    return res.json({ valid: false, message: 'License key not found.' });
  }
  if (!license.is_active) {
    logActivation(license.id, hwid, req.ip, 'validate_disabled');
    return res.json({ valid: false, message: 'License has been disabled.' });
  }
  if (license.email.toLowerCase() !== email.toLowerCase()) {
    logActivation(license.id, hwid, req.ip, 'validate_email_mismatch');
    return res.json({ valid: false, message: 'Email does not match.' });
  }

  const now = new Date().toISOString();
  if (license.expires_at && license.expires_at < now) {
    logActivation(license.id, hwid, req.ip, 'validate_expired');
    return res.json({ valid: false, message: 'Subscription has expired.' });
  }
  if (license.hwid && license.hwid !== hwid) {
    logActivation(license.id, hwid, req.ip, 'validate_hwid_mismatch');
    return res.json({ valid: false, message: 'License is bound to another machine. Contact support to reset.' });
  }
  if (!license.hwid) {
    db.prepare('UPDATE licenses SET hwid = ?, activated_at = ? WHERE id = ?').run(hwid, now, license.id);
  }

  logActivation(license.id, hwid, req.ip, 'validate_success');
  res.json({ valid: true, plan: license.plan, expires_at: license.expires_at });
});

app.post('/api/licenses/:id/reset-hwid', requireAdminApi, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE licenses SET hwid = NULL, activated_at = NULL WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/licenses/:id/toggle-active', requireAdminApi, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE licenses SET is_active = ? WHERE id = ?').run(req.body.is_active ? 1 : 0, req.params.id);
  res.json({ success: true });
});

function logActivation(licenseId, hwid, ip, action) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO activation_log (license_id, hwid, ip, action) VALUES (?, ?, ?, ?)').run(licenseId, hwid, ip, action);
  } catch {}
}

// =============================================
// Admin panel pages
// =============================================
app.get('/admin/login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const admin = db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.redirect('/admin/login?error=1');
  }
  const hash = crypto.createHmac('sha256', ADMIN_SECRET)
    .update(admin.id + ':' + admin.password_hash).digest('hex');
  const token = Buffer.from(admin.id + ':' + hash).toString('base64');
  res.cookie('admin_token', token, { httpOnly: true, maxAge: 86400000 });
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => { res.clearCookie('admin_token'); res.redirect('/admin/login'); });
app.get('/admin', requireAdmin, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// =============================================
// Admin API
// =============================================
app.get('/api/licenses', requireAdminApi, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all());
});

app.post('/api/licenses', requireAdminApi, (req, res) => {
  const { email, plan, expires_at, max_machines, note } = req.body;
  if (!email || !expires_at) return res.status(400).json({ error: 'Email and expiry date are required.' });
  const db = getDb();
  const key = generateLicenseKey();
  db.prepare('INSERT INTO licenses (license_key, email, plan, expires_at, max_machines, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(key, email, plan || 'Standard', expires_at, max_machines || 1, note || null);
  res.json({ success: true, key });
});

app.put('/api/licenses/:id', requireAdminApi, (req, res) => {
  const { email, plan, expires_at, is_active, note } = req.body;
  const db = getDb();
  db.prepare('UPDATE licenses SET email = ?, plan = ?, expires_at = ?, is_active = ?, note = ? WHERE id = ?')
    .run(email, plan, expires_at, is_active ? 1 : 0, note || null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/licenses/:id', requireAdminApi, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM licenses WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/logs', requireAdminApi, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT al.*, l.license_key, l.email FROM activation_log al LEFT JOIN licenses l ON al.license_id = l.id ORDER BY al.created_at DESC LIMIT 200').all());
});

app.post('/admin/change-password', requireAdminApi, (req, res) => {
  const { current_password, new_password } = req.body;
  const db = getDb();
  const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(req.admin.id);
  if (!bcrypt.compareSync(current_password, admin.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE admin SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  res.clearCookie('admin_token');
  res.json({ success: true });
});

app.get('/api/stats', requireAdminApi, (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM licenses').get().c;
  const active = db.prepare('SELECT COUNT(*) as c FROM licenses WHERE is_active = 1').get().c;
  const expired = db.prepare("SELECT COUNT(*) as c FROM licenses WHERE expires_at < datetime('now')").get().c;
  const todayActivations = db.prepare("SELECT COUNT(*) as c FROM activation_log WHERE created_at > datetime('now', '-1 day') AND action = 'validate_success'").get().c;
  res.json({ total, active, expired, todayActivations });
});

// =============================================
// Auto-update API (files stored as BLOB in DB)
// =============================================
app.get('/api/update/check', (req, res) => {
  const currentVersion = req.query.v || '0.0.0';
  const db = getDb();
  const latest = db.prepare(
    'SELECT id, version, changelog, file_name, file_size, created_at FROM app_updates WHERE is_active = 1 ORDER BY id DESC LIMIT 1'
  ).get();

  if (!latest || latest.version === currentVersion) {
    return res.json({ update: false });
  }

  res.json({
    update: true,
    version: latest.version,
    changelog: latest.changelog || '',
    file_size: latest.file_size,
    url: '/api/update/download'
  });
});

app.get('/api/update/download', (req, res) => {
  const db = getDb();
  const latest = db.prepare(
    'SELECT file_name, file_data FROM app_updates WHERE is_active = 1 AND file_data IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get();

  if (!latest || !latest.file_data) {
    return res.status(404).json({ error: 'No update available' });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + latest.file_name + '"');
  res.setHeader('Content-Length', latest.file_data.length);
  res.send(latest.file_data);
});

app.post('/api/updates', requireAdminApi, upload.single('file'), (req, res) => {
  const { version, changelog } = req.body;
  if (!version || !req.file) {
    return res.status(400).json({ error: 'Version and file are required.' });
  }

  const db = getDb();
  // Deactivate old updates
  db.prepare('UPDATE app_updates SET is_active = 0').run();

  db.prepare('INSERT INTO app_updates (version, changelog, file_name, file_data, file_size, is_active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(version, changelog || '', req.file.originalname, req.file.buffer, req.file.size);

  res.json({ success: true, version });
});

app.get('/api/updates', requireAdminApi, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT id, version, changelog, file_name, file_size, is_active, created_at FROM app_updates ORDER BY id DESC').all());
});

app.delete('/api/updates/:id', requireAdminApi, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM app_updates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// =============================================
ensureAdmin();
app.listen(PORT, () => {
  console.log(`License server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
