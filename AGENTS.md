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

## Monetization (downloads + Stripe + license keys)
Landing page is `public/index.html` (marketing + download + buy). The old cloud-library UI moved to `/app` (`public/app.html`).

Endpoints:
- `GET /api/download?src=<source>` — counts the download (source/IP/UA) then 302-redirects to `EXE_DOWNLOAD_URL`. Track per-source (e.g. `?src=youtube`).
- `GET /api/download/count` — public total for the landing page counter.
- `GET /api/stats?token=<ADMIN_TOKEN>` — admin dashboard: download totals by source + license sales.
- `POST /api/checkout` — creates a Stripe Checkout session for one license key.
- `POST /api/stripe/webhook` — on `checkout.session.completed`, mints a key (`SHADOW-XXXX-...`) and stores it (session_id + email).
- `GET /buy/success?session_id=...` — post-purchase page that shows the buyer their key.
- `POST /api/license/activate` — `{key, machine_id}`; binds key to one PC (second PC rejected).
- `POST /api/license/validate` — `{key, machine_id}`; status check.
- `GET /api/license/redeem?session_id=...` — fetch key for a session.
- `POST /api/license/admin/create` — `{count?, email?}` + admin token → mints new key(s) for manual sales (UPI/Binance).
- `GET /api/license/admin/list` — + admin token → all keys with status/email/machine.
- `POST /api/license/admin/revoke` — `{key}` + admin token → revokes a key (blocks future activation).
- `GET /admin?token=...` — browser admin dashboard (mint keys, revoke, view stats).

Required env vars on Render (add via Render dashboard → cwtool service → Environment):
- `STRIPE_SECRET_KEY` — sk_live_... (Stripe Dashboard → Developers → API keys)
- `STRIPE_WEBHOOK_SECRET` — whsec_... (Stripe → Developers → Webhooks → cwtool service endpoint). Endpoint URL: `https://cwtool.onrender.com/api/stripe/webhook`, event `checkout.session.completed`.
- `ADMIN_TOKEN` — your private token for `/api/stats`.
- `PRICE_USD` — optional, default 4.99.
- `EXE_DOWNLOAD_URL` — optional; recommended = the GitHub Release asset URL for Shadowclutch.exe. Without it the download 302-redirects to `/cdn/Shadowclutch.exe` (this repo's `cdn/` dir — commit the exe there).
- `PRODUCT_NAME` — optional, default "ShadowTools License".

Config fallbacks live in `config.json` (keys: `stripe_secret_key`, `stripe_webhook_secret`, `admin_token`, `price_usd`, `exe_download_url`, `product_name`). Config is checked into git, so env vars are preferred for secrets.

Ads: the landing page has three `.ad-slot` divs (leaderboard-top/mid/bottom). Paste your Google AdSense `<ins class="adsbygoogle">` snippet into those slots (and the AdSense loader script in `<head>`).

Deploy: `git add -A && git commit -m "..." && git push` then hit the deploy hook (AGENTS.md top) — it builds the latest GitHub commit.

## Desktop app notes
- `app.py` requires `sys.frozen = True` before import in test scripts (admin-elevation guard ~line 639).
- `_backup_cloud_push` tries server push (`POST /api/backup/push`) first, falls back to GitHub merge.
- License: on first run the app shows an activation overlay. `WindowAPI.activate_license(key)` POSTs to the server's `/api/license/activate` with a persistent `machine_id` (stored in `license.json` next to the exe). Server URL comes from config.json `server_url` / env `CWT_SERVER_URL`, defaulting to `https://cwtool.onrender.com`.
