// One-time setup: saves your token and registers the PC agent as a background
// auto-start (Windows Run key — no admin needed). The agent starts silently at
// every login. After this, you never need to touch the PC again — games you
// add on the website deploy here automatically.
//
// Usage:
//   node install.js <session-token>
//   node install.js --uninstall     (remove the auto-start)
//   optional env: SITE_URL, STEAM_PATH

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SITE_URL = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const UNINSTALL = process.argv.includes('--uninstall');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'CWTool Sync Agent';
const DIR = __dirname;

const CONFIG_FILE = path.join(DIR, 'agent_config.json');
const VBS_FILE = path.join(DIR, 'run-agent.vbs');

let config = {};
try {
  if (fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {}

const argToken = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const token = process.env.SESSION_TOKEN || argToken || config.token || '';

function sh(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function nodeExe() {
  return process.execPath;
}

function writeVbs() {
  const vbs = `Set sh = CreateObject("Wscript.Shell")
sh.Run """${nodeExe()}"" ""${path.join(DIR, 'agent.js')}"" --watch", 0, False
`;
  fs.writeFileSync(VBS_FILE, vbs, 'utf8');
}

function uninstall() {
  try { sh(`reg delete "${RUN_KEY}" /v "${RUN_VALUE}" /f`); } catch {}
  try { fs.unlinkSync(VBS_FILE); } catch {}
  console.log('[Install] Background auto-start removed.');
}

if (UNINSTALL) {
  uninstall();
  process.exit(0);
}

if (!token) {
  console.log('CW Tool PC Agent installer');
  console.log('Usage: node install.js <session-token>');
  console.log('  Add --uninstall to remove the background auto-start.');
  process.exit(1);
}

if (!process.argv.includes('--no-check')) {
  console.log('[Install] Verifying token...');
  try {
    const res = execSync(`curl -s -o nul -w "%{http_code}" -H "Authorization: Bearer ${token}" ${SITE_URL}/api/me`, { shell: 'cmd.exe' }).toString().trim();
    if (res !== '200') {
      console.error(`[Install] Token rejected by ${SITE_URL} (HTTP ${res}). Get a fresh token.`);
      process.exit(1);
    }
  } catch (e) {
    console.warn('[Install] Could not reach server to verify token (is it running?). Continuing anyway.');
  }
}

fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token, site_url: SITE_URL }, null, 2));
console.log(`[Install] Token saved to agent_config.json (server: ${SITE_URL})`);

writeVbs();
console.log('[Install] Created silent launcher run-agent.vbs');

sh(`reg add "${RUN_KEY}" /v "${RUN_VALUE}" /t REG_SZ /d "wscript.exe \\"${VBS_FILE}\\"" /f`);
console.log(`[Install] Auto-start registered in Windows (${RUN_VALUE})`);

console.log('\n[Install] Done. The agent will start automatically at your next login.');
console.log('  To start it right now without logging out:');
console.log(`    start "" wscript.exe "${VBS_FILE}"`);
console.log('  Everything after this is automatic: add games on the website');
console.log(`  and they deploy to Steam at ${SITE_URL} immediately.`);

