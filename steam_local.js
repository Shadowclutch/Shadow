// Shared logic for anything that touches the user's local Steam install.
// Used by the PC agent (agent.js). Pure Node — no npm deps, works standalone.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ── Steam path detection (Windows registry) ─────────────────
function detectSteamPath() {
  const queries = [
    ['HKCU\\Software\\Valve\\Steam'],
    ['HKLM\\Software\\WOW6432Node\\Valve\\Steam'],
  ];
  for (const [subkey] of queries) {
    try {
      const out = execFileSync('reg', ['query', subkey, '/v', 'SteamPath'], { encoding: 'utf8' });
      const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
      if (m) return m[1].trim().replace(/\\\\/g, '\\');
    } catch {}
  }
  return 'C:\\Program Files (x86)\\Steam';
}

function getSteamPath() {
  return process.env.STEAM_PATH || detectSteamPath();
}

// ── Payload deployment (mirrors app.py process_download_payload) ──
function isZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function forceWrite(data, dest, log) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.writeFileSync(dest, data);
    return;
  } catch (e) {
    try {
      const tmp = dest + '.tmp.' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, dest);
      return;
    } catch (e2) {
      throw new Error('could not write ' + dest + ': ' + e2.message);
    }
  }
}

function deployPayload(data, steamRoot, appId, log) {
  const luaDir = path.join(steamRoot, 'config', 'stplug-in');
  const depotDir = path.join(steamRoot, 'depotcache');
  fs.mkdirSync(luaDir, { recursive: true });
  fs.mkdirSync(depotDir, { recursive: true });

  if (isZip(data)) {
    log('[*] Archive package discovered. Unpacking...');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtool-'));
    try {
      fs.writeFileSync(path.join(tmp, 'payload.zip'), data);
      execFileSync('tar', ['-xf', path.join(tmp, 'payload.zip'), '-C', tmp], { stdio: 'ignore' });
      let deployed = 0;
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full); continue; }
          const lower = e.name.toLowerCase();
          if (!lower.endsWith('.lua') && !lower.endsWith('.manifest')) continue;
          const destDir = lower.endsWith('.lua') ? luaDir : depotDir;
          const dest = path.join(destDir, e.name);
          try {
            forceWrite(fs.readFileSync(full), dest, log);
            log(`[++++] SUCCESS: Deployed ${lower.endsWith('.lua') ? 'Lua' : 'Manifest'} -> ${dest}`);
            deployed++;
          } catch (e) {
            log(`[!] FAILED to deploy -> ${dest}: ${e.message}`);
          }
        }
      };
      walk(tmp);
      return deployed > 0;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  log('[*] Single asset returned directly. Placing into target directory...');
  let dest;
  try {
    const sample = data.slice(0, 100).toString('utf8');
    if (/manifest|AppState/i.test(sample)) dest = path.join(depotDir, `${appId}.manifest`);
    else dest = path.join(luaDir, `${appId}.lua`);
  } catch {
    dest = path.join(depotDir, `${appId}.manifest`);
  }
  try {
    forceWrite(data, dest, log);
    log(`[++++] SUCCESS: Individual asset deployed -> ${dest}`);
    return true;
  } catch (e) {
    log(`[!] Deployment failed: ${e.message}`);
    return false;
  }
}

module.exports = { detectSteamPath, getSteamPath, deployPayload, isZip, forceWrite };
