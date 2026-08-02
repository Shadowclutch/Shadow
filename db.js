// SQLite storage via Node's built-in node:sqlite (no native compilation needed).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data.sqlite');
const SESSION_TTL_DAYS = 30;

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    steamid TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'steam',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    steamid TEXT NOT NULL REFERENCES users(steamid),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS library (
    steamid TEXT NOT NULL REFERENCES users(steamid),
    appid INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (steamid, appid)
  );
  CREATE TABLE IF NOT EXISTS agent_tokens (
    token TEXT PRIMARY KEY,
    steamid TEXT NOT NULL REFERENCES users(steamid),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);
// Backwards-compatible migration for existing databases: identify the auth
// provider (steam / discord) for each user. New installs get it via DDL above.
try {
  db.exec(`ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'steam'`);
} catch {}

// ── Users ───────────────────────────────────────────────────
const upsertUser = db.prepare(`
  INSERT INTO users (steamid, name, avatar, provider, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(steamid) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, provider = excluded.provider
`);

function findOrCreateUser({ steamid, name, avatar, provider = 'steam' }) {
  const now = Math.floor(Date.now() / 1000);
  upsertUser.run(steamid, name, avatar, provider, now);
  return { steamid, name, avatar, provider, created_at: now };
}

const getUserStmt = db.prepare('SELECT * FROM users WHERE steamid = ?');
function getUser(steamid) {
  return getUserStmt.get(steamid) || null;
}

// ── Sessions ────────────────────────────────────────────────
const insertSession = db.prepare(`
  INSERT INTO sessions (token, steamid, created_at, expires_at) VALUES (?, ?, ?, ?)
`);
const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE token = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

function createSession(steamid) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  insertSession.run(token, steamid, now, now + SESSION_TTL_DAYS * 86400);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = getSessionStmt.get(token);
  if (!s) return null;
  if (s.expires_at < Math.floor(Date.now() / 1000)) {
    deleteSessionStmt.run(token);
    return null;
  }
  return s;
}

function deleteSession(token) {
  if (token) deleteSessionStmt.run(token);
}

// ── Agent tokens (long-lived, for the background PC agent) ──
const AGENT_TOKEN_TTL_DAYS = 365;
const getAgentTokenStmt = db.prepare('SELECT * FROM agent_tokens WHERE token = ?');
const insertAgentToken = db.prepare(`
  INSERT INTO agent_tokens (token, steamid, created_at, expires_at) VALUES (?, ?, ?, ?)
`);

function getAgentToken(steamid) {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare('SELECT * FROM agent_tokens WHERE steamid = ? ORDER BY created_at DESC').all(steamid);
  for (const r of rows) {
    if (r.expires_at > now) return r.token;
  }
  const token = crypto.randomBytes(32).toString('hex');
  insertAgentToken.run(token, steamid, now, now + AGENT_TOKEN_TTL_DAYS * 86400);
  return token;
}

function findAgentToken(token) {
  if (!token) return null;
  const r = getAgentTokenStmt.get(token);
  if (!r) return null;
  if (r.expires_at < Math.floor(Date.now() / 1000)) return null;
  return r;
}

// ── Library ─────────────────────────────────────────────────
const listLibraryStmt = db.prepare('SELECT appid, name, added_at FROM library WHERE steamid = ? ORDER BY added_at DESC');
const getLibraryItem = db.prepare('SELECT * FROM library WHERE steamid = ? AND appid = ?');
const upsertLibrary = db.prepare(`
  INSERT INTO library (steamid, appid, name, added_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(steamid, appid) DO UPDATE SET name = excluded.name
`);
const removeLibraryStmt = db.prepare('DELETE FROM library WHERE steamid = ? AND appid = ?');

function listLibrary(steamid) {
  return listLibraryStmt.all(steamid);
}

function addToLibrary(steamid, appid, name) {
  const now = Math.floor(Date.now() / 1000);
  upsertLibrary.run(steamid, appid, name, now);
  return getLibraryItem.get(steamid, appid);
}

function removeFromLibrary(steamid, appid) {
  removeLibraryStmt.run(steamid, appid);
}

// Housekeeping
deleteExpired.run(Math.floor(Date.now() / 1000));

module.exports = {
  findOrCreateUser,
  getUser,
  createSession,
  getSession,
  deleteSession,
  getAgentToken,
  findAgentToken,
  listLibrary,
  addToLibrary,
  removeFromLibrary,
};
