# AGENTS.md

## Project
Cloud sync + backup service for the CWTool desktop app (`steam_tool` repo sibling). Two dirs live side by side:

- `steam_tool_web` (this repo): Node/Express web server. Git repo `Shadowclutch/Shadow`, branch `main`.
- `steam_tool`: Python desktop app (`app.py`, built exe in `dist\`).

## Live infra (all free tiers, no credit card)
- Render service: `srv-d9nkks6417fc73diva40` (cwtool), live at `https://cwtool.onrender.com`. Deploy via hook `POST https://api.render.com/deploy/srv-d9nkks6417fc73diva40?key=ZddvHzXCzeA`. Hook deploys the latest **GitHub** commit — always `git push` before deploying.
- Supabase Postgres (source of truth): ref `zfptfguwdeqtrzvlgusw`. Must use the **Session pooler** host `aws-1-ap-south-1.pooler.supabase.com` (Render has no IPv6; direct host `db.zfptfguwdeqtrzvlgusw.supabase.co` is IPv6-only and fails with `ENETUNREACH`). Connection requires user `postgres.zfptfguwdeqtrzvlgusw` (project-ref suffix mandatory) and the DB password URL-encoded (`@`→`%40`, `#`→`%23`).
- Render env: `DATABASE_URL` (pooler string), `GITHUB_REPO_TOKEN` (PAT for backup repo).
- GitHub backup (safety net only): `cloud_backup.json` on branch `backup` of `Shadowclutch/Shadow`.

## Keep-alive
- cron-job.org free job pings `https://cwtool.onrender.com/api/health` every 5 min to prevent Render free-tier 15-min spin-down.

## Backend behavior
- `db.js`: dual backend — Postgres (`pg`) when `DATABASE_URL` set, else SQLite fallback (`node:sqlite`). Forces IPv4 lookup. NOTE: node-pg returns `COUNT(*)` as a string; `countRows()` coerces to numbers (restore guard `users===0 && library===0` breaks otherwise).
- `server.js`: async `requireAuth`, `/api/backup/status` (incl. `db`), `/api/dbcheck` (diagnostics + row counts), `/api/health`. Startup restores from GitHub backup **only when DB empty** in pg mode (persistent DB is authoritative); SQLite fallback restores unconditionally.
- `backup.js`: auto-push throttled to `BACKUP_MIN_INTERVAL_MS` (default 30 min); manual `POST /api/backup/push` always forces.
- Test agent token (live): `88d602cefcccb5b65316dc16ca16c90c53ba19dab8bae576fa4cfbfd98e31607` for user `1487668000478855188` (ShadowClutchh).

## Monetization (downloads + manual license-key sales)
Landing page is `public/index.html` (marketing + download + buy). The old cloud-library UI moved to `/app` (`public/app.html`). Payment is **manual** (UPI / Binance / PayPal) — the Stripe endpoints still exist in `server.js` but are unused until the seller turns them on.

Endpoints:
- `GET /api/download?src=<source>` — counts the download (source/IP/UA) then 302-redirects to `EXE_DOWNLOAD_URL`. Track per-source (e.g. `?src=youtube`). Default target: `/cdn/Shadowclutch.zip` (password-protected zip, password `SHADOW`; contains `Shadowclutch.exe`).
- `GET /api/download/count` — public total for the landing page counter.
- `GET /api/stats?token=<ADMIN_TOKEN>` — admin dashboard: download totals by source + license sales.
- `POST /api/license/activate` — `{key, machine_id}`; binds key to one PC (second PC rejected).
- `POST /api/license/validate` — `{key, machine_id}`; status check.
- `POST /api/license/admin/create` — `{count?, email?}` + admin token → mints new key(s) for manual sales (UPI/Binance).
- `GET /api/license/admin/list` — + admin token → all keys with status/email/machine.
- `POST /api/license/admin/revoke` — `{key}` + admin token → revokes a key (blocks future activation).
- `GET /admin?token=...` — browser admin dashboard (mint keys, revoke, view stats). `<ADMIN_TOKEN>` = `tV3fA2HDecQmyIRz8XF49B0jgCoJNMWs` (set in Render env).
- `POST /api/checkout`, `POST /api/stripe/webhook`, `GET /api/license/redeem?session_id=...`, `GET /buy/success` — legacy Stripe flow, dormant until STRIPE keys are set.

Required env vars on Render (add via Render dashboard → cwtool service → Environment):
- `ADMIN_TOKEN` — `tV3fA2HDecQmyIRz8XF49B0jgCoJNMWs` (protects `/admin`, `/api/stats`, admin license routes).
- `EXE_DOWNLOAD_URL` — optional; recommended = the GitHub Release asset URL for Shadowclutch.zip. Without it the download 302-redirects to `/cdn/Shadowclutch.zip` (this repo's `cdn/` dir — commit the zip there).
- (Stripe, later if wanted) `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — set `PRICE_USD` (default 4.99) and create webhook for `checkout.session.completed`.

Config fallbacks live in `config.json` (keys: `stripe_secret_key`, `stripe_webhook_secret`, `admin_token`, `price_usd`, `exe_download_url`, `product_name`). Config is checked into git, so env vars are preferred for secrets.

Sell flow: buyer pays via UPI/Binance/PayPal → seller opens `https://cwtool.onrender.com/admin?token=...` → mints key → sends it to buyer → buyer activates in the desktop app.

Deploy: `git add -A && git commit -m "..." && git push` then hit the deploy hook (AGENTS.md top) — it builds the latest GitHub commit.

## Desktop app notes
- `app.py` requires `sys.frozen = True` before import in test scripts (admin-elevation guard ~line 639).
- `_backup_cloud_push` tries server push (`POST /api/backup/push`) first, falls back to GitHub merge.
- License: on first run the app shows an activation overlay. `WindowAPI.activate_license(key)` POSTs to the server's `/api/license/activate` with a persistent `machine_id` (stored in `license.json` next to the exe). Server URL comes from config.json `server_url` / env `CWT_SERVER_URL`, defaulting to `https://cwtool.onrender.com`.
