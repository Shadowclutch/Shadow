const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const backup = require('./backup');

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const CONFIG_PATH = path.join(__dirname, 'config.json');

const STEAM_OPENID_LOGIN = 'https://steamcommunity.com/openid/login';
const SESSION_COOKIE = 'cw_session';

// ── Discord OAuth config ────────────────────────────────────
// Credentials come from environment variables or config.json:
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET  (env)
//   discord_client_id / discord_client_secret  (config.json)
let serverCfg = {};
try {
  if (fs.existsSync(CONFIG_PATH)) serverCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {}
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || serverCfg.discord_client_id || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || serverCfg.discord_client_secret || '';
const DISCORD_REDIRECT_WEB = `${SITE_URL}/auth/discord/callback`;
const DISCORD_REDIRECT_DESKTOP = `${SITE_URL}/api/desktop/discord/callback`;
const pendingDiscord = new Map(); // state -> { createdAt, token?, user? }

// ── CloudDB API ─────────────────────────────────────────────
const CLOUDDB_BASE = 'https://hubcapmanifest.com';
const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/Shadowclutch/Shadow/main/config.json';
const COOLDOWN_SECS = 86400;

let CLOUDDB_KEYS = [];
const keyCooldown = new Map();
const COOLDOWN_STATE_PATH = path.join(__dirname, 'clouddb_cooldowns.json');

function loadClouddbKeys() {
  const envKey = process.env.CWT_CLOUDDB_KEY;
  if (envKey) {
    CLOUDDB_KEYS = [envKey];
  } else {
    let cfg = {};
    try {
      if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {}
    const keys = cfg.clouddb_keys;
    if (Array.isArray(keys) && keys.length) CLOUDDB_KEYS = keys;
    else if (cfg.clouddb_key) CLOUDDB_KEYS = [cfg.clouddb_key];
    loadRemoteKeys();
  }
  try {
    const cds = JSON.parse(fs.readFileSync(COOLDOWN_STATE_PATH, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of Object.entries(cds)) {
      if (typeof v === 'number' && v > now) keyCooldown.set(k, v);
    }
  } catch {}
}

async function loadRemoteKeys() {
  try {
    const res = await fetchWithTimeout(REMOTE_CONFIG_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000);
    if (!res.ok) return;
    const cfg = await res.json();
    const remoteKeys = cfg.clouddb_keys;
    if (Array.isArray(remoteKeys) && remoteKeys.length) {
      CLOUDDB_KEYS = remoteKeys;
      console.log(`[CWTool Web] Loaded ${CLOUDDB_KEYS.length} CloudDB keys from remote config`);
      return;
    }
    const single = cfg.clouddb_key || cfg.hubapi_key;
    if (single) {
      CLOUDDB_KEYS = [single];
      console.log('[CWTool Web] Loaded CloudDB key from remote config');
    }
  } catch {}
}

function persistCooldowns() {
  const cds = {};
  for (const [k, v] of keyCooldown) cds[k] = v;
  try {
    fs.writeFileSync(COOLDOWN_STATE_PATH, JSON.stringify(cds, null, 2));
  } catch {}
}

function activeKey() {
  const now = Math.floor(Date.now() / 1000);
  for (const k of CLOUDDB_KEYS) {
    const until = keyCooldown.get(k);
    if (!until || now > until) return k;
  }
  return null;
}

function markKeyCooldown(key) {
  keyCooldown.set(key, Math.floor(Date.now() / 1000) + COOLDOWN_SECS);
  persistCooldowns();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function clouddbRequest(pathStr, binary = false) {
  if (!CLOUDDB_KEYS.length) return binary ? [null, 'No API keys configured'] : null;
  const tried = new Set();
  for (let i = 0; i < CLOUDDB_KEYS.length * 2; i++) {
    const key = activeKey();
    if (!key || tried.has(key)) break;
    tried.add(key);
    try {
      const res = await fetchWithTimeout(CLOUDDB_BASE + pathStr, {
        headers: { 'X-API-Key': key, 'User-Agent': 'Mozilla/5.0' },
      });
      if (res.status === 429) {
        markKeyCooldown(key);
        continue;
      }
      if (!res.ok) return binary ? [null, `HTTP ${res.status}`] : null;
      return binary ? [Buffer.from(await res.arrayBuffer()), null] : await res.json();
    } catch (e) {
      return binary ? [null, e.message] : null;
    }
  }
  return binary ? [null, 'Service temporarily unavailable'] : null;
}

// ── Steam OpenID auth ───────────────────────────────────────
function openidLoginUrl() {
  const returnTo = `${SITE_URL}/auth/steam/callback`;
  const realm = SITE_URL + '/';
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_LOGIN}?${params.toString()}`;
}

function scalar(v) {
  return Array.isArray(v) ? v[0] : v;
}

async function validateOpenId(query) {
  const claimed = scalar(query['openid.claimed_id']) || scalar(query['openid.identity']) || '';
  const m = claimed.match(/\/id\/(\d+)$/);
  if (!m) return null;

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('openid.')) body.append(k, scalar(v));
  }
  body.set('openid.mode', 'check_authentication');

  try {
    const res = await fetchWithTimeout(STEAM_OPENID_LOGIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, 15000);
    const text = await res.text();
    if (!/is_valid:\s*true/i.test(text)) return null;
    return m[1];
  } catch {
    return null;
  }
}

async function fetchProfile(steamid) {
  if (STEAM_API_KEY) {
    try {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamid}`;
      const res = await fetchWithTimeout(url, {}, 10000);
      const data = await res.json();
      const p = data && data.response && data.response.players && data.response.players[0];
      if (p) {
        return { name: p.personaname || steamid, avatar: p.avatarmedium || '' };
      }
    } catch {}
  }
  try {
    const res = await fetchWithTimeout(`https://steamcommunity.com/profiles/${steamid}?xml=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 10000);
    const text = await res.text();
    const nameMatch = text.match(/<steamID>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/steamID>/) || text.match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/);
    const avatarMatch = text.match(/<avatarFull>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/avatarFull>/);
    return {
      name: nameMatch ? nameMatch[1].trim() : steamid,
      avatar: avatarMatch ? avatarMatch[1].trim() : '',
    };
  } catch {
    return { name: steamid, avatar: '' };
  }
}

// ── Discord OAuth helpers ───────────────────────────────────
function discordAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function discordExchange(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetchWithTimeout('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, 15000);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error('Discord token exchange failed (' + res.status + '): ' + detail);
  }
  return res.json();
}

async function discordFetchUser(accessToken) {
  const res = await fetchWithTimeout('https://discord.com/api/users/@me', {
    headers: { Authorization: 'Bearer ' + accessToken, 'User-Agent': 'CWTool/1.0' },
  }, 15000);
  if (!res.ok) throw new Error('Discord user fetch failed (HTTP ' + res.status + ')');
  return res.json();
}

function discordUserProfile(discordUser) {
  const id = String(discordUser.id || '');
  const name = discordUser.global_name || discordUser.username || id;
  const avatar = discordUser.avatar ? `https://cdn.discordapp.com/avatars/${id}/${discordUser.avatar}.png` : '';
  return { id, name, username: discordUser.username || name, avatar };
}

function discordSuccessPage(name) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0e1428;color:#e8e8f0;">
    <h2>Login successful</h2>
    <p>Signed in as <b>${name.replace(/[<>&"']/g, '')}</b>.</p>
    <p>You can close this tab and return to CW Tool.</p>
  </body></html>`;
}

function discordErrorPage(message) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0e1428;color:#e8e8f0;">
    <h2>Login failed</h2>
    <p>${String(message).replace(/[<>&"']/g, '')}</p>
    <p>You can close this tab and try again.</p>
  </body></html>`;
}

// ── Session helpers ─────────────────────────────────────────
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

async function requireAuth(req, res, next) {
  try {
    let token = readCookie(req, SESSION_COOKIE);
    // Allow Authorization: Bearer <token> for non-browser clients (PC agent)
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
    const session = await db.getSession(token);
    if (session) {
      req.user = await db.getUser(session.steamid);
      req.sessionToken = token;
      return req.user ? next() : res.status(401).json({ error: 'Not authenticated' });
    }
    const agent = await db.findAgentToken(token);
    if (agent) {
      req.user = await db.getUser(agent.steamid);
      req.sessionToken = agent.token;
      return req.user ? next() : res.status(401).json({ error: 'Not authenticated' });
    }
    return res.status(401).json({ error: 'Not authenticated' });
  } catch (e) {
    return res.status(500).json({ error: 'Authentication error' });
  }
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
}

// ── Live agent sync ─────────────────────────────────────────
// Agents keep a long-lived SSE connection. When the user's library changes we
// push a 'sync' event so connected PCs deploy the new games immediately.
const subscribers = new Map(); // steamid -> Set<res>
const agentLastSeen = new Map(); // steamid -> timestamp (ms)

function notifySync(steamid) {
  const set = subscribers.get(steamid);
  if (!set || !set.size) return;
  for (const res of set) {
    try { res.write('event: sync\ndata: {}\n\n'); } catch {}
  }
}

// ── Simple in-memory rate limiter (public deployment safety) ──
const rateBuckets = new Map(); // ip -> { count, resetAt }
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = (req.ip || req.socket.remoteAddress || '?').toString();
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, b);
    }
    b.count++;
    if (b.count > max) return res.status(429).json({ error: 'Too many requests, slow down.' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (b.resetAt < now) rateBuckets.delete(k);
}, 60000).unref();

// ── App ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/cdn', express.static(path.join(__dirname, 'cdn'), {
  setHeaders(res, filePath) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.zip')) res.setHeader('Content-Type', 'application/zip');
    if (filePath.endsWith('.exe')) res.setHeader('Content-Type', 'application/octet-stream');
  },
}));

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');

  const steamid = req.user.steamid;
  let set = subscribers.get(steamid);
  if (!set) { set = new Set(); subscribers.set(steamid, set); }
  set.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size) subscribers.delete(steamid);
  });
});

app.post('/api/agent/heartbeat', requireAuth, (req, res) => {
  agentLastSeen.set(req.user.steamid, Date.now());
  res.json({ ok: true });
});

app.get('/api/agent/status', requireAuth, (req, res) => {
  const last = agentLastSeen.get(req.user.steamid);
  const online = !!last && Date.now() - last < 120000;
  res.json({ online, lastSeen: last ? new Date(last).toISOString() : null, agents: subscribers.get(req.user.steamid)?.size || 0 });
});

app.get('/api/health', (req, res) => res.json({ ok: true, clouddbConfigured: CLOUDDB_KEYS.length > 0 }));

// ── Auth routes ─────────────────────────────────────────────
app.get('/auth/steam', (req, res) => {
  res.redirect(openidLoginUrl());
});

app.get('/auth/steam/callback', async (req, res) => {
  try {
    const steamid = await validateOpenId(req.query);
    if (!steamid) return res.status(400).send('Steam login validation failed.');
    const profile = await fetchProfile(steamid);
    await db.findOrCreateUser({ steamid, name: profile.name, avatar: profile.avatar });
    const token = await db.createSession(steamid);
    setSessionCookie(res, token);
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Login error: ' + e.message);
  }
});

// ── Discord OAuth ─ web (browser) login ────────────────────
app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return res.status(503).send('Discord login is not configured on this server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingDiscord.set(state, { createdAt: Date.now() });
  res.redirect(discordAuthorizeUrl(DISCORD_REDIRECT_WEB, state));
});

app.get('/auth/discord/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const code = String(req.query.code || '');
  if (!pendingDiscord.has(state)) return res.status(400).send('Unknown or expired login attempt.');
  try {
    const tok = await discordExchange(code, DISCORD_REDIRECT_WEB);
    const profile = discordUserProfile(await discordFetchUser(tok.access_token));
    await db.findOrCreateUser({ steamid: profile.id, provider: 'discord', name: profile.name, avatar: profile.avatar });
    const token = await db.createSession(profile.id);
    setSessionCookie(res, token);
    res.redirect('/');
  } catch (e) {
    pendingDiscord.delete(state);
    res.status(500).send('Discord login error: ' + e.message);
  }
});

app.get('/auth/logout', async (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  await db.deleteSession(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/');
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ steamid: req.user.steamid, name: req.user.name, avatar: req.user.avatar });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ steamid: req.user.steamid, name: req.user.name, avatar: req.user.avatar });
});

// Desktop exe login: the desktop app runs the Steam OpenID flow in the system
// browser with a local redirect (http://127.0.0.1:<port>/cb), then forwards the
// openid.* params here for server-side validation. On success we return a
// long-lived agent token the desktop uses for all library calls.
app.post('/api/desktop/login', async (req, res) => {
  try {
    const steamid = await validateOpenId(req.body || {});
    if (!steamid) return res.status(401).json({ error: 'Steam login validation failed.' });
    const profile = await fetchProfile(steamid);
    await db.findOrCreateUser({ steamid, name: profile.name, avatar: profile.avatar });
    const token = await db.getAgentToken(steamid);
    backup.schedulePush();
    res.json({ steamid, name: profile.name, avatar: profile.avatar, token });
  } catch (e) {
    res.status(500).json({ error: 'Login error: ' + e.message });
  }
});

// ── Discord OAuth ─ desktop login ──────────────────────────
// Flow: the desktop opens /api/desktop/discord/login?state=<ticket> in the
// browser. Discord redirects back to the server callback, which issues an agent
// token. The desktop polls /api/desktop/discord/status?state=<ticket> until it
// receives the token. No local redirect port is needed on the desktop.
app.get('/api/desktop/discord/configured', (req, res) => {
  res.json({
    configured: !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET),
    web_redirect: DISCORD_REDIRECT_WEB,
    desktop_redirect: DISCORD_REDIRECT_DESKTOP,
  });
});

app.get('/api/desktop/discord/login', (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return res.type('html').status(503).send(discordErrorPage('Discord login is not configured on this server.'));
  }
  if (!/^\d{17,20}$/.test(DISCORD_CLIENT_ID)) {
    return res.type('html').status(500).send(discordErrorPage('DISCORD_CLIENT_ID on this server is not a valid Discord Application ID. Open Discord Developer Portal -> your app -> OAuth2 -> copy the numeric Client ID, then update the Render env var.'));
  }
  const state = String(req.query.state || '');
  if (state.length < 16 || !/^[a-zA-Z0-9]+$/.test(state)) {
    return res.status(400).send('Invalid login ticket.');
  }
  pendingDiscord.set(state, { createdAt: Date.now() });
  res.redirect(discordAuthorizeUrl(DISCORD_REDIRECT_DESKTOP, state));
});

app.get('/api/desktop/discord/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const code = String(req.query.code || '');
  if (!pendingDiscord.has(state)) return res.status(400).send('Unknown or expired login attempt.');
  try {
    const tok = await discordExchange(code, DISCORD_REDIRECT_DESKTOP);
    const profile = discordUserProfile(await discordFetchUser(tok.access_token));
    await db.findOrCreateUser({ steamid: profile.id, provider: 'discord', name: profile.name, avatar: profile.avatar });
    const entry = pendingDiscord.get(state);
    entry.token = await db.getAgentToken(profile.id);
    entry.user = profile;
    backup.schedulePush();
    res.type('html').send(discordSuccessPage(profile.name));
  } catch (e) {
    pendingDiscord.set(state, { createdAt: Date.now(), error: String(e.message).slice(0, 500) });
    res.type('html').status(500).send(discordErrorPage(e.message));
  }
});

app.get('/api/desktop/discord/status', rateLimit(120, 60000), (req, res) => {
  const state = String(req.query.state || '');
  const entry = pendingDiscord.get(state);
  if (!entry) return res.json({ pending: false, error: 'unknown_login' });
  if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
    pendingDiscord.delete(state);
    return res.json({ pending: false, error: 'expired' });
  }
  if (entry.token) {
    pendingDiscord.delete(state);
    return res.json({ pending: false, token: entry.token, user: entry.user });
  }
  if (entry.error) {
    pendingDiscord.delete(state);
    return res.json({ pending: false, error: entry.error });
  }
  res.json({ pending: true });
});

app.get('/api/agent/token', requireAuth, async (req, res) => {
  res.json({ token: await db.getAgentToken(req.user.steamid) });
});

// Serve the agent source files so a downloaded installer can fetch them onto any PC.
app.get('/agent/:file', (req, res) => {
  const file = path.basename(req.params.file);
  if (!['agent.js', 'steam_local.js', 'install.js'].includes(file)) return res.status(404).end();
  res.type('.js').sendFile(path.join(__dirname, file));
});

// Generate a self-installing .bat with the user's agent token embedded. The user
// double-clicks it once; it sets up the background sync agent with zero commands.
app.get('/api/agent/installer', rateLimit(10, 60000), requireAuth, async (req, res) => {
  const token = await db.getAgentToken(req.user.steamid);
  const bat = installerBat(SITE_URL, token);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="CWAgent-Setup.bat"');
  res.send(bat);
});

function installerBat(siteUrl, token) {
  const dir = '%LOCALAPPDATA%\\CWToolAgent';
  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    'title CW Tool - PC Agent Setup',
    `set "SITE=${siteUrl}"`,
    `set "TOKEN=${token}"`,
    `set "DIR=${dir}"`,
    'if not exist "%DIR%" mkdir "%DIR%"',
    'echo Downloading agent files...',
    'curl -s -o "%DIR%\\agent.js" "%SITE%/agent/agent.js"',
    'curl -s -o "%DIR%\\steam_local.js" "%SITE%/agent/steam_local.js"',
    'curl -s -o "%DIR%\\install.js" "%SITE%/agent/install.js"',
    '> "%DIR%\\agent_config.json" echo {"token":"%TOKEN%","site_url":"%SITE%"}',
    'where node >nul 2>nul',
    'if not errorlevel 1 goto hasnode',
    'echo Node.js not found - downloading a portable copy (one time)...',
    'curl -s -o "%DIR%\\node.zip" "https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip"',
    'tar -xf "%DIR%\\node.zip" -C "%DIR%"',
    'set "PATH=%DIR%\\node-v24.16.0-win-x64;%PATH%"',
    ':hasnode',
    'cd /d "%DIR%"',
    'node install.js',
    'if errorlevel 1 goto fail',
    'start "" wscript.exe "%DIR%\\run-agent.vbs"',
    'echo.',
    'echo SUCCESS: PC agent installed and running in the background.',
    'echo Your Steam games will now auto-sync from the website.',
    'timeout /t 4 /nobreak >nul',
    'exit /b 0',
    ':fail',
    'echo.',
    'echo Setup failed. See the message above.',
    'pause',
  ];
  return lines.join('\r\n') + '\r\n';
}

// ── Library ─────────────────────────────────────────────────
app.get('/api/backup/status', (req, res) => {
  res.json({
    token_set: !!process.env.GITHUB_REPO_TOKEN,
    token_len: process.env.GITHUB_REPO_TOKEN ? process.env.GITHUB_REPO_TOKEN.length : 0,
    backup_repo: process.env.GITHUB_BACKUP_REPO || 'Shadowclutch/Shadow',
    backup_branch: process.env.GITHUB_BACKUP_BRANCH || 'backup',
    uptime_sec: Math.floor(process.uptime()),
  });
});

// Trigger an immediate full-snapshot backup push. Desktop apps call this after
// library changes so the server (which owns GITHUB_REPO_TOKEN) writes the shared
// backup covering ALL users — no client needs the GitHub token. When the token
// isn't configured the server returns pushed:false and the client falls back to
// its own merge push.
app.post('/api/backup/push', rateLimit(30, 60000), requireAuth, async (req, res) => {
  try {
    const result = await backup.pushSnapshotNow();
    if (result && result.ok) return res.json({ pushed: true, full_snapshot: true });
    res.json({ pushed: false, reason: (result && result.reason) || 'push_failed' });
  } catch (e) {
    res.json({ pushed: false, reason: 'error' });
  }
});

app.get('/api/library', requireAuth, async (req, res) => {
  const items = (await db.listLibrary(req.user.steamid)).map((g) => ({
    ...g,
    cached: !!readManifestCache(g.appid),
  }));
  res.json({ total: items.length, items });
});

app.post('/api/library', rateLimit(30, 60000), requireAuth, async (req, res) => {
  const appid = Number(req.body && req.body.appid);
  const name = String((req.body && req.body.name) || '');
  if (!Number.isInteger(appid) || appid <= 0) return res.status(400).json({ error: 'Invalid appid' });
  const row = await db.addToLibrary(req.user.steamid, appid, name);
  notifySync(req.user.steamid);
  backup.schedulePush();
  res.json({ item: row });
  prefetchManifest(appid); // store centrally now so all PCs sync from local cache
});

app.delete('/api/library/:appid', requireAuth, async (req, res) => {
  await db.removeFromLibrary(req.user.steamid, Number(req.params.appid));
  notifySync(req.user.steamid);
  backup.schedulePush();
  res.json({ ok: true });
});

// Fetch a game's manifest from cache → CloudDB → Adder 1 and store it locally.
// Runs in the background the moment a game is added to the library.
async function prefetchManifest(appId) {
  if (readManifestCache(appId)) return;
  try {
    const [d] = await clouddbRequest(`/api/v1/manifest/${appId}`, true);
    if (d) {
      writeManifestCache(appId, d);
      console.log(`[CWTool Web] Stored locally: ${appId} (${d.length} bytes, from CloudDB)`);
      return;
    }
  } catch {}
  try {
    const d = await adder1Fallback(appId);
    if (d) {
      writeManifestCache(appId, d);
      console.log(`[CWTool Web] Stored locally: ${appId} (${d.length} bytes, from Adder 1)`);
    }
  } catch {}
}

// ── CloudDB browse / download ───────────────────────────────
// ── Adder 1 catalog (full Steam app list) ───────────────────
// Cached server-side for 24h. Used as a search fallback when CloudDB has no
// results, mirroring Game Adder 1's catalog behaviour.
const CATALOG_FILE = path.join(__dirname, 'game_catalog.json');
let gameCatalog = null;

async function loadCatalog() {
  if (gameCatalog) return gameCatalog;
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      const age = Date.now() - fs.statSync(CATALOG_FILE).mtimeMs;
      if (age < 24 * 3600 * 1000) {
        gameCatalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
        return gameCatalog;
      }
    }
  } catch {}
  const urls = [
    'https://applist.morrenus.xyz/',
    'https://generator.ryuu.lol/files/games.json',
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 120000);
      if (!res.ok) continue;
      let data = await res.json();
      if (data && data.applist) data = data.applist.apps;
      else if (data && data.apps) data = data.apps;
      if (!Array.isArray(data) || data.length < 100000) continue;
      const seen = new Set();
      const games = [];
      for (const item of data) {
        const appid = Number(item.appid);
        const name = String(item.name || '');
        if (appid > 0 && name && !seen.has(appid)) {
          seen.add(appid);
          games.push({ appid, name });
        }
      }
      if (games.length >= 100000) {
        gameCatalog = games;
        try { fs.writeFileSync(CATALOG_FILE, JSON.stringify(games)); } catch {}
        console.log(`[CWTool Web] Adder1 catalog loaded: ${games.length} games`);
        return games;
      }
    } catch {}
  }
  gameCatalog = [];
  return gameCatalog;
}

app.get('/api/search', rateLimit(60, 60000), async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const limit = Math.min(parseInt(req.query.limit) || 50, 50);
  const offset = parseInt(req.query.offset) || 0;

  let items = [];
  if (CLOUDDB_KEYS.length) {
    const data = await clouddbRequest(`/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`);
    if (data) {
      const raw = Array.isArray(data) ? data : (data.results || data.games || data.items || []);
      items = raw
        .filter((g) => g && (g.appid || g.game_id))
        .map((g) => ({
          appid: Number(g.appid || g.game_id),
          name: g.name || g.game_name || '',
        }));
    }
  }

  if (!items.length) {
    const catalog = await loadCatalog();
    const term = q.toLowerCase();
    items = catalog
      .filter((g) => g.name.toLowerCase().includes(term) || String(g.appid) === q)
      .slice(offset, offset + limit);
  }

  res.json(items);
});

app.get('/api/status/:appId', async (req, res) => {
  if (!CLOUDDB_KEYS.length) return res.json({ available: null, error: 'No API keys configured' });
  const data = await clouddbRequest(`/api/v1/status/${req.params.appId}`);
  if (!data) return res.json({ available: false, error: 'Request failed' });
  const avail = !!(data.has_manifest || data.exists || String(data).toLowerCase().includes('manifest'));
  res.json({ available: avail, error: null });
});

// ── Manifest cache + Game Adder 1 fallback ──────────────────
// Every manifest we successfully download is cached locally, so redeploys are
// instant and never hit external sources twice. When CloudDB (Adder 2) fails,
// we fall back to Game Adder 1's mirror "lines".
const MANIFEST_CACHE_DIR = path.join(__dirname, 'manifest_cache');
fs.mkdirSync(MANIFEST_CACHE_DIR, { recursive: true });
function manifestCachePath(appId) { return path.join(MANIFEST_CACHE_DIR, `${appId}.zip`); }
function readManifestCache(appId) {
  try { return fs.readFileSync(manifestCachePath(appId)); } catch { return null; }
}
function writeManifestCache(appId, buf) {
  try { fs.writeFileSync(manifestCachePath(appId), buf); } catch {}
}

const ADDER1_SOURCES = [
  { id: 'Line #1', url: (id) => `http://167.235.229.108/${id}` },
  { id: 'Line #2', url: (id) => `https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/${id}.zip` },
  { id: 'Line #3', url: (id) => `https://raw.githubusercontent.com/skyflarefox/Skyapi/refs/heads/main/${id}.zip` },
];

async function adder1Fallback(appId) {
  for (const src of ADDER1_SOURCES) {
    try {
      const res = await fetchWithTimeout(src.url(appId), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
      }, 20000);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      console.log(`[CWTool Web] Adder1 fallback hit: ${src.id} -> ${appId} (${buf.length} bytes)`);
      return buf;
    } catch {}
  }
  return null;
}

// Manifest proxy — downloads from cache → CloudDB (Adder 2) → Adder 1 sources,
// streams the payload to the browser (manual download) or the PC agent (auto-deploy)
app.get('/api/manifest/:appId', requireAuth, async (req, res) => {
  const appId = req.params.appId;
  let data = readManifestCache(appId);
  let err = null;
  if (!data) {
    const [d, e] = await clouddbRequest(`/api/v1/manifest/${appId}`, true);
    data = d;
    err = e;
  }
  if (!data) {
    data = await adder1Fallback(appId);
  }
  if (!data) {
    return res.status(502).json({ error: err || 'Download failed (CloudDB + Adder 1 sources exhausted)' });
  }
  writeManifestCache(appId, data);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', data.length);
  res.setHeader('Content-Disposition', `attachment; filename="${appId}.zip"`);
  res.send(data);
});

// ── Owned games sync (optional, needs STEAM_API_KEY) ────────
app.get('/api/sync/owned', requireAuth, async (req, res) => {
  if (!STEAM_API_KEY) return res.json({ configured: false, appids: [] });
  if (req.user.provider === 'discord') return res.json({ configured: false, appids: [], error: 'Steam owned-games sync only works for Steam accounts' });
  try {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${req.user.steamid}&include_appinfo=false&include_played_free_games=true`;
    const resp = await fetchWithTimeout(url, {}, 20000);
    const data = await resp.json();
    const games = (data && data.response && data.response.games) || [];
    res.json({ configured: true, appids: games.map((g) => g.appid) });
  } catch (e) {
    res.json({ configured: true, appids: [], error: e.message });
  }
});

// ── Start ───────────────────────────────────────────────────
backup.restoreFromRepo().finally(() => {
  app.listen(PORT, () => {
    console.log(`[CWTool Web] Running at ${SITE_URL}`);
    console.log(`[CWTool Web] CloudDB keys configured: ${CLOUDDB_KEYS.length}`);
    console.log(`[CWTool Web] Steam API key (owned-games sync): ${STEAM_API_KEY ? 'yes' : 'no'}`);
    console.log(`[CWTool Web] Discord login: ${DISCORD_CLIENT_ID ? 'configured' : 'NOT configured (set discord_client_id/secret in config.json or env)'}`);
    console.log(`[CWTool Web]   web redirect:    ${DISCORD_REDIRECT_WEB}`);
    console.log(`[CWTool Web]   desktop redirect:${DISCORD_REDIRECT_DESKTOP}`);
    console.log(`[CWTool Web] GitHub backup: ${process.env.GITHUB_REPO_TOKEN ? 'ENABLED' : 'DISABLED (set GITHUB_REPO_TOKEN to persist the library across deploys)'}`);
  });
});

loadClouddbKeys();
