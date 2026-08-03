// Storage layer with a dual backend:
//   - Postgres (via `pg`) when DATABASE_URL is set — the DB then lives in a
//     persistent hosted database (e.g. Neon) and survives Render restarts, which
//     is the "complete" fix for data durability.
//   - SQLite (Node's built-in node:sqlite) otherwise — used on Render only as a
//     fallback when no DATABASE_URL is configured.
// The public API is uniform and async, so callers use `await` everywhere.
const path = require('path');
const crypto = require('crypto');

const USE_PG = !!process.env.DATABASE_URL && /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL);
const SESSION_TTL_DAYS = 30;
const AGENT_TOKEN_TTL_DAYS = 365;

const SCHEMA = `
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
`;

// Convert SQLite `?` placeholders to Postgres `$1, $2, ...`.
function pgify(sql, params) {
  let n = 0;
  const text = sql.replace(/\?/g, () => `$${++n}`);
  return { text, values: params || [] };
}

function createSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DATABASE_PATH || path.join(__dirname, 'data.sqlite'));
  db.exec(SCHEMA);
  // Backwards-compatible migration for existing databases.
  try { db.exec(`ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'steam'`); } catch {}
  return {
    backend: 'sqlite',
    ready: Promise.resolve(),
    async run(sql, params) { db.prepare(sql).run(...(params || [])); },
    async all(sql, params) { return db.prepare(sql).all(...(params || [])); },
    async get(sql, params) { return db.prepare(sql).get(...(params || [])) || null; },
    async close() {},
  };
}

function createPg(connStr) {
  const { Pool } = require('pg');
  const dns = require('dns');
  const parse = require('pg-connection-string').parse;
  const c = parse(connStr);
  const state = { pool: null, meta: { host: c.host, port: c.port || 5432, database: c.database, user: c.user } };
  // Render's free tier has no IPv6, but Supabase hostnames can resolve to AAAA
  // records first (Node's default dns-result-order is `verbatim`). Force the
  // IPv4 address so the connection actually goes through.
  const ready = (async () => {
    let host = c.host;
    try {
      const r = await dns.promises.lookup(c.host, { family: 4 });
      host = r.address;
      state.meta.resolved4 = host;
      console.log(`[db] Postgres host ${c.host} -> IPv4 ${host}`);
    } catch (e) {
      console.log(`[db] IPv4 lookup failed for ${c.host} (${e.message}) — using original host`);
    }
    state.pool = new Pool({
      host,
      port: c.port ? Number(c.port) : 5432,
      user: c.user,
      password: c.password,
      database: c.database,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 15000,
    });
    await state.pool.query(SCHEMA);
    console.log(`[db] Postgres backend ready (${host}:${c.port || 5432}/${c.database})`);
  })().catch((e) => {
    console.error(`[db] Postgres init failed: ${e.message}`);
    throw e;
  });
  return {
    backend: 'pg',
    ready,
    meta: () => ({ ...state.meta, connected: !!state.pool }),
    async run(sql, params) { await ready; await state.pool.query(pgify(sql, params)); },
    async all(sql, params) { await ready; const r = await state.pool.query(pgify(sql, params)); return r.rows; },
    async get(sql, params) { await ready; const r = await state.pool.query(pgify(sql, params)); return r.rows[0] || null; },
    async close() { await ready; await state.pool.end(); },
  };
}

const A = USE_PG ? createPg(process.env.DATABASE_URL) : createSqlite();

// ── Users ───────────────────────────────────────────────────
async function findOrCreateUser({ steamid, name, avatar, provider = 'steam' }) {
  const now = Math.floor(Date.now() / 1000);
  await A.run(`
    INSERT INTO users (steamid, name, avatar, provider, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(steamid) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, provider = excluded.provider
  `, [steamid, name || '', avatar || '', provider, now]);
  return { steamid, name: name || '', avatar: avatar || '', provider, created_at: now };
}

async function getUser(steamid) {
  return A.get('SELECT * FROM users WHERE steamid = ?', [steamid]);
}

// ── Sessions ────────────────────────────────────────────────
async function createSession(steamid) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  await A.run('INSERT INTO sessions (token, steamid, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, steamid, now, now + SESSION_TTL_DAYS * 86400]);
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const s = await A.get('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!s) return null;
  if (s.expires_at < Math.floor(Date.now() / 1000)) {
    await A.run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  return s;
}

async function deleteSession(token) {
  if (token) await A.run('DELETE FROM sessions WHERE token = ?', [token]);
}

// ── Agent tokens (long-lived, for the background PC agent) ──
async function getAgentToken(steamid) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await A.all('SELECT * FROM agent_tokens WHERE steamid = ? ORDER BY created_at DESC', [steamid]);
  for (const r of rows) {
    if (r.expires_at > now) return r.token;
  }
  const token = crypto.randomBytes(32).toString('hex');
  await A.run('INSERT INTO agent_tokens (token, steamid, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, steamid, now, now + AGENT_TOKEN_TTL_DAYS * 86400]);
  return token;
}

async function findAgentToken(token) {
  if (!token) return null;
  const r = await A.get('SELECT * FROM agent_tokens WHERE token = ?', [token]);
  if (!r) return null;
  if (r.expires_at < Math.floor(Date.now() / 1000)) return null;
  return r;
}

// ── Library ─────────────────────────────────────────────────
async function listLibrary(steamid) {
  return A.all('SELECT appid, name, added_at FROM library WHERE steamid = ? ORDER BY added_at DESC', [steamid]);
}

async function addToLibrary(steamid, appid, name) {
  const now = Math.floor(Date.now() / 1000);
  await A.run(`
    INSERT INTO library (steamid, appid, name, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(steamid, appid) DO UPDATE SET name = excluded.name
  `, [steamid, appid, name || '', now]);
  return A.get('SELECT * FROM library WHERE steamid = ? AND appid = ?', [steamid, appid]);
}

async function removeFromLibrary(steamid, appid) {
  await A.run('DELETE FROM library WHERE steamid = ? AND appid = ?', [steamid, appid]);
}

// ── Backup snapshot (GitHub-repo persistence) ───────────────
async function countRows() {
  return {
    users: (await A.get('SELECT COUNT(*) AS n FROM users')).n,
    sessions: (await A.get('SELECT COUNT(*) AS n FROM sessions')).n,
    library: (await A.get('SELECT COUNT(*) AS n FROM library')).n,
    agent_tokens: (await A.get('SELECT COUNT(*) AS n FROM agent_tokens')).n,
  };
}

async function diagnose() {
  const meta = (typeof A.meta === 'function') ? A.meta() : { backend: A.backend };
  try {
    const r = await A.get('SELECT 1 AS ok');
    const counts = await countRows();
    return { ok: true, backend: A.backend, meta, counts, result: r };
  } catch (e) {
    return { ok: false, backend: A.backend, meta, error: String((e && e.message) || e) };
  }
}

async function exportSnapshot() {
  return {
    users: await A.all('SELECT * FROM users'),
    sessions: await A.all('SELECT * FROM sessions'),
    agent_tokens: await A.all('SELECT * FROM agent_tokens'),
    library: await A.all('SELECT * FROM library'),
  };
}

async function importSnapshot(snap) {
  const counts = { users: 0, sessions: 0, agent_tokens: 0, library: 0 };
  const upserts = [
    { table: 'users', rows: snap.users || [], sql: `
        INSERT INTO users (steamid, name, avatar, provider, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(steamid) DO UPDATE SET name = excluded.name, avatar = excluded.avatar,
          provider = excluded.provider, created_at = excluded.created_at` },
    { table: 'sessions', rows: snap.sessions || [], sql: `
        INSERT INTO sessions (token, steamid, created_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET steamid = excluded.steamid,
          created_at = excluded.created_at, expires_at = excluded.expires_at` },
    { table: 'agent_tokens', rows: snap.agent_tokens || [], sql: `
        INSERT INTO agent_tokens (token, steamid, created_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET steamid = excluded.steamid,
          created_at = excluded.created_at, expires_at = excluded.expires_at` },
    { table: 'library', rows: snap.library || [], sql: `
        INSERT INTO library (steamid, appid, name, added_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(steamid, appid) DO UPDATE SET name = excluded.name, added_at = excluded.added_at` },
  ];
  for (const u of upserts) {
    for (const row of u.rows) {
      try {
        const params = u.table === 'users'
          ? [row.steamid, row.name || '', row.avatar || '', row.provider || 'steam', row.created_at]
          : u.table === 'library'
            ? [row.steamid, row.appid, row.name || '', row.added_at]
            : [row.token, row.steamid, row.created_at, row.expires_at];
        await A.run(u.sql, params);
        counts[u.table]++;
      } catch {
        // Tolerate individual bad rows (e.g. FK to a missing user) so a single
        // corrupt entry can't abort the whole restore.
      }
    }
  }
  return counts;
}

// Housekeeping (fire-and-forget — runs once after the schema is ready).
A.ready.then(() => {
  A.run('DELETE FROM sessions WHERE expires_at < ?', [Math.floor(Date.now() / 1000)]).catch(() => {});
}).catch(() => {});

module.exports = {
  backend: A.backend,
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
  countRows,
  diagnose,
  exportSnapshot,
  importSnapshot,
};
