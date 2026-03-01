const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'licenses.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_key TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'Standard',
      hwid TEXT,
      activated_at TEXT,
      expires_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      max_machines INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER,
      hwid TEXT,
      ip TEXT,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (license_id) REFERENCES licenses(id)
    );

    CREATE TABLE IF NOT EXISTS app_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL,
      changelog TEXT,
      file_name TEXT NOT NULL,
      file_data BLOB,
      file_size INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function generateLicenseKey() {
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(crypto.randomBytes(3).toString('hex').toUpperCase());
  }
  return 'SRT-' + segments.join('-');
}

module.exports = { getDb, generateLicenseKey };
