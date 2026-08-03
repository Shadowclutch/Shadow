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

## Desktop app notes
- `app.py` requires `sys.frozen = True` before import in test scripts (admin-elevation guard ~line 639).
- `_backup_cloud_push` tries server push (`POST /api/backup/push`) first, falls back to GitHub merge.
