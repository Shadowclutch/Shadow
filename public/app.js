const $ = (sel) => document.querySelector(sel);

const CARD_IMAGE = (appid) => `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;

const searchInput = $('#searchInput');
const searchBtn = $('#searchBtn');
const searchCount = $('#searchCount');
const gamesGrid = $('#gamesGrid');
const loadMoreWrap = $('#loadMoreWrap');
const loadMoreBtn = $('#loadMoreBtn');
const authBox = $('#authBox');
const clouddbBadge = $('#clouddbBadge');
const libraryBody = $('#libraryBody');
const libraryCount = $('#libraryCount');
const agentCard = $('#agentCard');
const agentToken = $('#agentToken');
const copyTokenBtn = $('#copyTokenBtn');
const installAgentBtn = $('#installAgentBtn');
const pcStatus = $('#pcStatus');
const notConfiguredBanner = $('#notConfiguredBanner');

let currentUser = null;
let libraryMap = new Map(); // appid -> name
let libraryCached = new Map(); // appid -> bool (manifest stored on server)
let searchQuery = '';
let searchResults = [];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function imgError(img) {
  const placeholder = img.parentElement.querySelector('.game-card-placeholder');
  if (placeholder) {
    img.style.display = 'none';
    placeholder.style.display = 'flex';
  }
}

function statusMsg(text, cls) {
  const el = document.createElement('div');
  el.className = 'grid-msg ' + (cls || '');
  return el.textContent = text, el;
}

// ── Auth ────────────────────────────────────────────────────
async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    clouddbBadge.className = 'badge ' + (data.clouddbConfigured ? 'badge-on' : 'badge-off');
    clouddbBadge.textContent = data.clouddbConfigured ? 'CloudDB ready' : 'CloudDB not configured';
    notConfiguredBanner.classList.toggle('hidden', data.clouddbConfigured);
  } catch {}
}

async function loadMe() {
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) return renderLoggedOut();
    const user = await res.json();
    currentUser = user;
    renderLoggedIn();
    loadLibrary();
  } catch {
    renderLoggedOut();
  }
}

function renderLoggedOut() {
  currentUser = null;
  authBox.innerHTML = '<a class="steam-login-btn" href="/auth/discord">Sign in through Discord</a>';
  agentCard.style.display = 'none';
  libraryBody.innerHTML = `
    <div class="login-prompt">
      <p>Sign in with Discord to save games to your library.</p>
      <a class="steam-login-btn" href="/auth/discord">Sign in through Discord</a>
    </div>`;
  libraryCount.textContent = '';
}

function renderLoggedIn() {
  authBox.innerHTML = `
    <div class="user-chip">
      ${currentUser.avatar ? `<img src="${esc(currentUser.avatar)}" alt="">` : ''}
      <span class="name">${esc(currentUser.name)}</span>
    </div>
    <a class="ghost" href="/auth/logout" style="text-decoration:none">Logout</a>`;
  agentCard.style.display = 'block';
  fetch('/api/agent/token').then((r) => r.json()).then((d) => {
    agentToken.textContent = d.token || '';
  }).catch(() => {});
  loadPcStatus();
}

installAgentBtn.addEventListener('click', async () => {
  if (!currentUser) return renderLoggedOut();
  installAgentBtn.disabled = true;
  installAgentBtn.textContent = 'Downloading...';
  try {
    const res = await fetch('/api/agent/installer');
    if (!res.ok) throw new Error('Server error');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'CWAgent-Setup.bat';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    installAgentBtn.textContent = 'Downloaded — double-click it once';
    setTimeout(() => {
      installAgentBtn.textContent = 'Download & install PC agent';
      installAgentBtn.disabled = false;
    }, 6000);
  } catch {
    installAgentBtn.textContent = 'Download failed';
    setTimeout(() => {
      installAgentBtn.textContent = 'Download & install PC agent';
      installAgentBtn.disabled = false;
    }, 3000);
  }
});

async function loadPcStatus() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/agent/status');
    const data = await res.json();
    const online = data.online && data.agents > 0;
    pcStatus.className = 'badge ' + (online ? 'badge-on' : 'badge-off');
    pcStatus.textContent = online
      ? `${data.agents} PC online — auto-syncing`
      : 'No PC online — install the agent to auto-sync';
  } catch {}
}

// ── Library ─────────────────────────────────────────────────
async function loadLibrary() {
  if (!currentUser) return;
  const res = await fetch('/api/library');
  const data = await res.json();
  libraryMap = new Map((data.items || []).map((g) => [g.appid, g.name]));
  libraryCached = new Map((data.items || []).map((g) => [g.appid, !!g.cached]));
  renderLibrary();
}

function renderLibrary() {
  libraryCount.textContent = currentUser ? `${libraryMap.size} game(s)` : '';
  if (!currentUser) return;
  const items = [...libraryMap.entries()].map(([appid, name]) => ({ appid, name, cached: libraryCached.get(appid) }));
  if (!items.length) {
    libraryBody.innerHTML = '<div class="login-prompt"><p>Your library is empty. Browse below and click "Add to Library".</p></div>';
    return;
  }
  libraryBody.innerHTML = `<div class="games-grid">${items.map(libraryCardHtml).join('')}</div>`;
  bindLibraryButtons();
}

function libraryCardHtml({ appid, name, cached }) {
  return `
    <div class="game-card" data-appid="${appid}">
      <div class="game-card-image-wrapper">
        <img class="game-card-img" src="${CARD_IMAGE(appid)}" onerror="imgError(this)" alt="">
        <div class="game-card-placeholder" style="display:none"><span>${esc(name)}</span></div>
      </div>
      <div class="game-card-info">
        <div class="game-card-title" title="${esc(name)}">${esc(name)}</div>
        <div class="game-card-meta">
          <span>App ID</span>
          <span class="game-card-appid">${appid}</span>
          ${cached ? '<span class="badge badge-on" style="margin-left:auto">Stored</span>' : ''}
        </div>
        <div class="card-actions">
          <a class="game-card-btn download" href="/api/manifest/${appid}">Download</a>
          <button class="game-card-btn small remove" data-remove="${appid}">Remove</button>
        </div>
      </div>
    </div>`;
}

function bindLibraryButtons() {
  libraryBody.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/library/${btn.dataset.remove}`, { method: 'DELETE' });
      libraryMap.delete(Number(btn.dataset.remove));
      renderLibrary();
    });
  });
}

// ── Browse / search (CloudDB, 'pop' default) ────────────────
async function runSearch(offset) {
  const raw = searchInput.value.trim();
  if (offset === 0) {
    searchResults = [];
    searchQuery = raw ? raw : 'pop';
    searchCount.textContent = raw ? 'Searching CloudDB...' : 'Showing popular CloudDB games...';
    gamesGrid.innerHTML = '';
    gamesGrid.appendChild(statusMsg('<span class="spinner"></span>Searching CloudDB...'));
    loadMoreWrap.classList.add('hidden');
  }

  const isAppId = /^\d{1,12}$/.test(searchQuery);
  if (isAppId) {
    if (offset === 0) {
      const placeholder = statusMsg('');
      placeholder.innerHTML = `
        App ID <b>${searchQuery}</b> detected<br>
        <button class="game-card-btn add" data-add="${searchQuery}" style="width:auto;padding:8px 16px;display:inline-flex;margin-top:12px">Add to Library</button>
        <a class="game-card-btn download" href="/api/manifest/${searchQuery}" style="width:auto;padding:8px 16px;display:inline-flex;margin-top:12px">Download</a>`;
      gamesGrid.innerHTML = '';
      gamesGrid.appendChild(placeholder);
      const addBtn = placeholder.querySelector('[data-add]');
      addBtn.addEventListener('click', () => addToLibrary(searchQuery, searchQuery));
    }
    return;
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&limit=50&offset=${offset}`);
    const items = await res.json();
    if (!items.length) {
      if (offset === 0) {
        gamesGrid.innerHTML = '';
        gamesGrid.appendChild(statusMsg('No results found.'));
      }
      loadMoreWrap.classList.add('hidden');
      searchCount.textContent = `${searchResults.length} results from CloudDB`;
      return;
    }
    searchResults = searchResults.concat(items);
    const html = items.map(browseCardHtml).join('');
    if (offset === 0) gamesGrid.innerHTML = html;
    else gamesGrid.insertAdjacentHTML('beforeend', html);
    searchCount.textContent = `${searchResults.length} results from CloudDB`;
    if (items.length >= 50) loadMoreWrap.classList.remove('hidden');
    else loadMoreWrap.classList.add('hidden');
    bindBrowseButtons();
  } catch {
    if (offset === 0) {
      gamesGrid.innerHTML = '';
      gamesGrid.appendChild(statusMsg('Search failed.'));
    }
  }
}

function browseCardHtml(game) {
  const appid = game.appid;
  const name = game.name;
  const saved = libraryMap.has(appid);
  return `
    <div class="game-card" data-appid="${appid}">
      <div class="game-card-image-wrapper">
        <img class="game-card-img" src="${CARD_IMAGE(appid)}" onerror="imgError(this)" alt="">
        <div class="game-card-placeholder" style="display:none"><span>${esc(name)}</span></div>
      </div>
      <div class="game-card-info">
        <div class="game-card-title" title="${esc(name)}">${esc(name)}</div>
        <div class="game-card-meta">
          <span>App ID</span>
          <span class="game-card-appid">${appid}</span>
        </div>
        <div class="card-actions">
          <button class="game-card-btn add" data-add="${appid}" ${saved ? 'disabled' : ''}>${saved ? 'In library' : 'Add to Library'}</button>
          <a class="game-card-btn small download" href="/api/manifest/${appid}">DL</a>
        </div>
      </div>
    </div>`;
}

function bindBrowseButtons() {
  gamesGrid.querySelectorAll('[data-add]').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      if (!currentUser) return renderLoggedOut();
      await addToLibrary(btn.dataset.add, btn.dataset.add);
      btn.textContent = 'In library';
      btn.disabled = true;
    });
  });
}

async function addToLibrary(appid, fallbackName) {
  if (!currentUser) return renderLoggedOut();
  let name = fallbackName || '';
  try {
    const r = await fetch('/api/search?q=' + appid + '&limit=1');
    const items = await r.json();
    if (items.length && items[0].appid === Number(appid)) name = items[0].name;
  } catch {}
  const res = await fetch('/api/library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appid: Number(appid), name }),
  });
  if (res.ok) {
    libraryMap.set(Number(appid), name);
    libraryCached.set(Number(appid), false);
    loadLibrary();
    setTimeout(loadLibrary, 10000); // pick up the "Stored" badge once prefetch finishes
  }
}

// ── Events ──────────────────────────────────────────────────
searchBtn.addEventListener('click', () => runSearch(0));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch(0);
  clearTimeout(searchInput._t);
  searchInput._t = setTimeout(() => runSearch(0), 600);
});
loadMoreBtn.addEventListener('click', () => runSearch(searchResults.length));

copyTokenBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(agentToken.textContent);
    copyTokenBtn.textContent = 'Copied!';
    setTimeout(() => { copyTokenBtn.textContent = 'Copy token'; }, 1500);
  } catch {}
});

loadHealth();
loadMe();
runSearch(0);
