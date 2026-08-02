// PC Agent — syncs your saved library from the CW Tool website into this PC's
// Steam installation.
//
// Usage:
//   node install.js <session-token>          (one-time: saves token + auto-starts on Windows login)
//   node agent.js <session-token>            (one sync, then exit)
//   node agent.js <session-token> --watch    (run forever, auto-deploys new games instantly)
//
// Watch mode connects to the website over a live stream: whenever you add games
// to your library on the website, every running PC agent deploys them
// automatically within ~1 second — no commands needed. Install the agent once
// per PC with install.js and it runs silently in the background forever.
//
// Config: token is read from agent_config.json (written by install.js), or from
// SESSION_TOKEN / argv. Optional env: SITE_URL, STEAM_PATH, SYNC_INTERVAL (s).

const fs = require('fs');
const path = require('path');
const { getSteamPath, deployPayload } = require('./steam_local');

const SITE_URL = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const CONFIG_FILE = path.join(__dirname, 'agent_config.json');
const OWNED_ONLY = process.argv.includes('--owned-only');
const WATCH = process.argv.includes('--watch');
const POLL_MS = Math.max(5, parseInt(process.env.SYNC_INTERVAL || '60', 10)) * 1000;
const STATE_FILE = path.join(__dirname, 'agent_state.json');
const HEARTBEAT_MS = 30000;

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return {};
}
const config = readConfig();
const argToken = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const token = process.env.SESSION_TOKEN || argToken || config.token || '';

let state = {};
if (fs.existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    state = {};
  }
}
const saveState = () =>
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathStr, opts = {}) {
  const res = await fetch(SITE_URL + pathStr, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res;
}

async function loadOwned() {
  const sync = await (await api('/api/sync/owned')).json();
  if (sync.configured) {
    const owned = new Set(sync.appids);
    console.log(`[Agent] Owned-games matching enabled: ${owned.size} owned game(s) on this account`);
    return owned;
  }
  console.warn('[Agent] --owned-only given but STEAM_API_KEY not configured on server; deploying all.');
  return null;
}

async function deployOne(g, steamRoot, owned) {
  if (owned && !owned.has(g.appid)) {
    console.log(`[Agent] SKIP ${g.name} (${g.appid}) — not in your owned games`);
    return { deployed: false, skipped: true };
  }
  if (alreadyDeployed(g.appid)) {
    console.log(`[Agent] Already deployed ${g.name} (${g.appid}) — skipping`);
    return { deployed: false, skipped: true };
  }
  console.log(`[Agent] Deploying ${g.name} (${g.appid})...`);
  try {
    const resp = await api(`/api/manifest/${g.appid}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    console.log(`[Agent] Downloaded ${buf.length} bytes`);
    const deployedFiles = [];
    const success = deployPayload(buf, steamRoot, String(g.appid), (m) => {
      console.log('  ' + m);
      const m2 = /SUCCESS: Deployed .* -> (.+)$/.exec(m);
      if (m2) deployedFiles.push(m2[1].trim());
    });
    if (!success) return { deployed: false, failed: true };
    state[g.appid] = { deployedAt: new Date().toISOString(), files: deployedFiles };
    saveState();
    return { deployed: true };
  } catch (e) {
    console.log(`  [!] Failed: ${e.message}`);
    return { deployed: false, failed: true };
  }
}

// A game counts as deployed only if the files we wrote are still on disk.
// If Steam removed them (e.g. game removed from the library), redeploy.
function alreadyDeployed(appid) {
  const s = state[appid];
  if (!s) return false;
  if (Array.isArray(s.files) && s.files.length) {
    return s.files.every((f) => fs.existsSync(f));
  }
  // Legacy state (no recorded files): fall back to checking the .lua marker.
  const marker = path.join(getSteamPath(), 'config', 'stplug-in', `${appid}.lua`);
  return fs.existsSync(marker);
}

async function syncOnce(steamRoot, owned) {
  let ok = 0;
  let fail = 0;
  let skipped = 0;

  let lib;
  try {
    lib = await (await api('/api/library')).json();
  } catch (e) {
    console.log(`[Agent] Library fetch failed: ${e.message}`);
    return;
  }
  console.log(`[Agent] Library: ${lib.total} game(s)`);

  for (const g of lib.items) {
    const r = await deployOne(g, steamRoot, owned);
    if (r.deployed) ok++;
    if (r.failed) fail++;
    if (r.skipped) skipped++;
  }

  console.log(`\n[Agent] Done: ${ok} deployed, ${fail} failed, ${skipped} skipped (already deployed).`);
  if (ok > 0) console.log('[Agent] Restart Steam to apply the manifests.');
  return { ok, fail };
}

async function main() {
  if (!token) {
    console.log('CW Tool PC Agent');
    console.log('Usage: node install.js <session-token>  (one-time setup, auto-runs in background)');
    console.log('  or:  node agent.js <session-token> [--watch]');
    console.log('  Get your token from the website (Agent tab) after logging in.');
    console.log('  Optional env: SITE_URL, STEAM_PATH, SYNC_INTERVAL (seconds, default 60)');
    process.exit(1);
  }

  console.log(`[Agent] Connecting to ${SITE_URL}...`);
  let me;
  try {
    me = await (await api('/api/me')).json();
  } catch (e) {
    console.error(`[Agent] Login failed: ${e.message}`);
    console.error('  Token invalid or expired. Get a fresh one from the website.');
    process.exit(1);
  }
  console.log(`[Agent] Logged in as ${me.name} (${me.steamid})`);

  const steamRoot = getSteamPath();
  console.log(`[Agent] Steam path: ${steamRoot}`);
  if (!fs.existsSync(steamRoot)) {
    console.error(`[Agent] Steam root not found: ${steamRoot}`);
    console.error('  Set STEAM_PATH env to your Steam folder to override.');
    process.exit(1);
  }

  let owned = null;
  if (OWNED_ONLY) {
    try {
      owned = await loadOwned();
    } catch (e) {
      console.warn(`[Agent] Owned-games lookup failed: ${e.message}`);
    }
  }

  await syncOnce(steamRoot, owned);

  if (!WATCH) return;

  console.log(`\n[Agent] Watch mode ON — linked to ${SITE_URL}.`);
  console.log('  Games you add on the website deploy here automatically.');
  console.log('  Press Ctrl+C to stop.\n');

  heartbeatLoop(steamRoot, owned);
  sseLoop(steamRoot, owned);
  while (true) {
    await sleep(POLL_MS);
    await syncOnce(steamRoot, owned);
  }
}

async function heartbeatLoop() {
  while (true) {
    try { await api('/api/agent/heartbeat', { method: 'POST' }); } catch {}
    await sleep(HEARTBEAT_MS);
  }
}

// Live stream: the website pushes 'sync' the moment your library changes, so
// deployment is instant (polling above is just a fallback if the stream drops).
async function sseLoop(steamRoot, owned) {
  while (true) {
    try {
      const res = await api('/api/events');
      console.log('[Agent] Live stream connected — waiting for changes...');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.includes('event: sync')) {
            console.log('\n[Agent] Sync requested by website — deploying...');
            await syncOnce(steamRoot, owned);
            console.log('[Agent] Back to watching.\n');
          }
        }
      }
    } catch (e) {
      console.log(`[Agent] Live stream dropped (${e.message}); reconnecting...`);
    }
    await sleep(5000);
  }
}

main().catch((e) => {
  console.error('[Agent] Fatal:', e);
  process.exit(1);
});
