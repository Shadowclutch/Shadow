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
const BRANCH = process.env.GITHUB_BACKUP_BRANCH || 'backup';
const TOKEN = process.env.GITHUB_REPO_TOKEN || '';

const CDN_URL = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${FILE}`;
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}`;
const API_BASE = `https://api.github.com/repos/${REPO}/contents/${FILE}`;

let pushTimer = null;
let pushInFlight = false;
let lastPushAt = 0;
// Postgres is the source of truth, so the GitHub snapshot is only a safety net.
// Auto-pushes are throttled to at most one per interval (default 30 min) so a
// busy server with thousands of users doesn't hammer the GitHub API or rewrite
// the whole file constantly. Manual /api/backup/push always forces a push.
const AUTO_PUSH_MIN_INTERVAL_MS = parseInt(process.env.BACKUP_MIN_INTERVAL_MS || (30 * 60 * 1000), 10);

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
  // Try the canonical raw URL first (always reflects the latest commit). jsDelivr
  // caches aggressively, so a stale CDN copy must never be trusted over raw.
  for (const url of [RAW_URL, CDN_URL]) {
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
    const res = await httpRequest(`${API_BASE}?ref=${BRANCH}`, { headers });
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
    return { ok: false, reason: 'server_token_not_set' };
  }
  const snapshot = {
    version: 1,
    exported_at: Math.floor(Date.now() / 1000),
    ...(await db.exportSnapshot()),
  };
  const sha = await currentFileSha();
  const payload = {
    message: `cloud backup ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(snapshot, null, 2)).toString('base64'),
    branch: BRANCH,
  };
  if (sha) payload.sha = sha;
  const res = await httpRequest(API_BASE, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  }, JSON.stringify(payload));
  if (res.status === 200 || res.status === 201) {
    lastPushAt = Date.now();
    console.log(`[backup] pushed ${FILE} to ${REPO}@${BRANCH}`);
    return { ok: true };
  }
  console.log(`[backup] push failed (${res.status}): ${res.body.slice(0, 300)}`);
  return { ok: false, reason: `http_${res.status}` };
}

// Debounced so bursts of library edits produce one push, and throttled so we
// only push the safety-net snapshot at most once per interval.
function schedulePush(delayMs = 3000) {
  if (!TOKEN) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (pushInFlight) {
      schedulePush(3000);
      return;
    }
    const sinceLast = Date.now() - lastPushAt;
    if (sinceLast < AUTO_PUSH_MIN_INTERVAL_MS) {
      console.log(`[backup] auto-push skipped (last push ${Math.round(sinceLast / 1000)}s ago; interval ${Math.round(AUTO_PUSH_MIN_INTERVAL_MS / 60000)}min)`);
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
    const counts = await db.importSnapshot(snap);
    console.log(`[backup] restored snapshot: users=${counts.users} sessions=${counts.sessions} agent_tokens=${counts.agent_tokens} library=${counts.library}`);
    return { restored: true, counts };
  } catch (e) {
    console.log(`[backup] restore failed: ${e.message}`);
    return { restored: false, error: e.message };
  }
}

module.exports = { restoreFromRepo, schedulePush, pushSnapshotNow };
