// GitHub-repo persistence for the free Render tier.
//
// The Render free plan wipes its filesystem on every deploy and cold start, so
// any SQLite stored locally is lost. Instead we mirror the DB as a JSON snapshot
// (`cloud_backup.json`) in the Shadowclutch/Shadow repo:
//   - On boot: restore from the repo snapshot (via jsDelivr, then raw fallback).
//   - On every library/login change: push the snapshot back to the repo.
//
// Requires `GITHUB_REPO_TOKEN` (a classic PAT with `repo` scope, or a fine-grained
// token with Contents: Read+Write on Shadowclutch/Shadow) set in the Render env.
// Without it the server still runs — it just won't be able to write backups.
const https = require('https');
const db = require('./db');

const REPO = process.env.GITHUB_BACKUP_REPO || 'Shadowclutch/Shadow';
const FILE = process.env.GITHUB_BACKUP_FILE || 'cloud_backup.json';
const TOKEN = process.env.GITHUB_REPO_TOKEN || '';

const CDN_URL = `https://cdn.jsdelivr.net/gh/${REPO}@main/${FILE}`;
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/main/${FILE}`;
const API_BASE = `https://api.github.com/repos/${REPO}/contents/${FILE}`;

let pushTimer = null;
let pushInFlight = false;

function httpRequest(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': 'CWTool-Web/1.0',
        ...(opts.headers || {}),
      },
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchSnapshotJson() {
  for (const url of [CDN_URL, RAW_URL]) {
    try {
      const res = await httpRequest(url);
      if (res.status === 200) {
        const parsed = JSON.parse(res.body);
        if (parsed && parsed.version) return parsed;
      }
    } catch {}
  }
  return null;
}

async function currentFileSha() {
  try {
    const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
    const res = await httpRequest(API_BASE, { headers });
    if (res.status === 200) {
      const parsed = JSON.parse(res.body);
      return parsed.sha || null;
    }
  } catch {}
  return null;
}

async function pushSnapshotNow() {
  if (!TOKEN) {
    console.log('[backup] GITHUB_REPO_TOKEN not set — skipping push to repo');
    return;
  }
  const snapshot = {
    version: 1,
    exported_at: Math.floor(Date.now() / 1000),
    ...db.exportSnapshot(),
  };
  const sha = await currentFileSha();
  const payload = {
    message: `cloud backup ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(snapshot, null, 2)).toString('base64'),
  };
  if (sha) payload.sha = sha;
  const res = await httpRequest(API_BASE, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  }, JSON.stringify(payload));
  if (res.status === 200 || res.status === 201) {
    console.log(`[backup] pushed ${FILE} to ${REPO}`);
  } else {
    console.log(`[backup] push failed (${res.status}): ${res.body.slice(0, 300)}`);
  }
}

// Debounced so bursts of library edits produce one push.
function schedulePush(delayMs = 3000) {
  if (!TOKEN) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (pushInFlight) {
      schedulePush(3000);
      return;
    }
    pushInFlight = true;
    pushSnapshotNow()
      .catch((e) => console.log(`[backup] push error: ${e.message}`))
      .finally(() => { pushInFlight = false; });
  }, delayMs);
}

async function restoreFromRepo() {
  try {
    const snap = await fetchSnapshotJson();
    if (!snap) {
      console.log('[backup] no remote snapshot found — starting with fresh DB');
      return { restored: false };
    }
    const counts = db.importSnapshot(snap);
    console.log(`[backup] restored snapshot: users=${counts.users} sessions=${counts.sessions} agent_tokens=${counts.agent_tokens} library=${counts.library}`);
    return { restored: true, counts };
  } catch (e) {
    console.log(`[backup] restore failed: ${e.message}`);
    return { restored: false, error: e.message };
  }
}

module.exports = { restoreFromRepo, schedulePush, pushSnapshotNow };
