# Cursor Remote Control

[中文](./README.md) | [English](./README.en.md)

A Web console that runs on your **Windows host**. Open it from a phone browser, submit tasks to the Cursor Agent, and let it edit local projects.

Prefer running with host Node.js + pnpm. Cursor SDK local mode needs access to your local projects, credentials, and developer tools; Docker containers usually lack those pieces. Docker is kept only as an optional fallback—use the host for day-to-day use.

The UI supports Chinese and English. Use the language switcher in the top-right corner; the choice is stored in the browser.

![Cursor Remote Control UI](./screenshot.png)

## Features

- Multi-user login with admin, operator, and viewer roles. Admins can override permissions per user and assign confirmed projects.
- Default admin username is `admin`, created by `pnpm init-admin` in SQLite.
- Listens on port `20267` by default.
- Browse directories within `PROJECT_ROOTS` and confirm projects; the dropdown only lists confirmed projects.
- Runs Agent tasks in the project directory via Cursor SDK local mode.
- Loads local project rules, Skills, and MCP by default. You can attach extra confirmed workspaces, restrict tools, enable sandbox / Auto-review, and send images.
- The session view shows tool calls, token usage, thinking, and replies.
- Persists job history, status, Agent ID, Run ID, and logs. One job is one conversation; follow-up messages stay on the same job. While a round is running, follow-ups queue by default; Append interrupts the current round and runs immediately.
- Scheduled rules on confirmed projects: simple cadence (daily / weekly / every N hours) or cron. When due, the saved prompt is sent to the Cursor Agent. Each run starts a new job by default, or continues the last session. A still-running previous job skips that occurrence; downtime is caught up at most once.
- PWA support so you can install it to the home screen from a mobile browser.
- Chinese / English UI language switcher.
- No arbitrary shell input; the web UI cannot run system commands directly.

## Requirements

- Windows host (not a container)
- Node.js 22+
- Latest [pnpm](https://pnpm.io/)
- A working local Cursor / Cursor SDK environment and `CURSOR_API_KEY`

## Setup

In PowerShell 7 (UTF-8 recommended):

```powershell
cd D:\code\cursor-remote-control
pnpm install
Copy-Item .env.example .env
pnpm init-admin
```

`pnpm init-admin` generates a strong random password, writes the admin user into SQLite, and updates the session secret in `.env`. The password is shown only once—save it immediately. Add more accounts from Settings → Users. Do not share one admin password.

Then edit `.env`:

```env
CURSOR_API_KEY=cursor_xxx
PROJECT_ROOTS=E:\code;D:\code;C:\code
COOKIE_SECURE=false
```

Optional: `CURSOR_SETTING_SOURCES` (default `project,user,plugins` to load local rules / Skills / MCP), `CURSOR_SANDBOX`, `CURSOR_AUTO_REVIEW`, and `CURSOR_DISALLOWED_TOOLS`. The web UI can still override these per task.

`PROJECT_ROOTS` is a semicolon-separated list of local Windows paths. Prefer project roots, not entire system drives.

For public HTTPS access, set:

```env
COOKIE_SECURE=true
PUBLIC_BASE_URL=
```

## Start (host)

Development:

```powershell
pnpm dev
```

Production:

```powershell
pnpm build
pnpm start
```

Open:

```text
http://127.0.0.1:20267
```

When reverse-proxying publicly, forward the HTTPS domain to local port `20267`. Runtime data lives under the project `data/` directory (do not use a Docker named volume).

If you switch back from Docker to the host:

1. Stop and remove the compose services (for example `docker compose down`).
2. Make sure `.env` `PROJECT_ROOTS` uses Windows paths (such as `E:\code;D:\code;C:\code`), not container paths like `/workspace/...`.
3. Keep `DATA_DIR` as `./data`. The first start imports existing `jobs.json` / `selected-projects.json` into `data/app.db` and leaves the JSON files as backups.
4. Run `pnpm install` if needed, then `pnpm build && pnpm start` or `pnpm dev`.

## Install on a phone

After opening the console over HTTPS, an Install button appears in the top-right when the browser supports installation. Chromium shows the system install prompt; iOS Safari does not fire that event, so the button instead guides you to Share → Add to Home Screen.

PWA install requirements:

- HTTPS or local `localhost` (plain HTTP on a public host usually cannot install)
- A valid Web App Manifest (including 192 and 512 PNG icons)
- A registered Service Worker

After changing icons, run `pnpm generate-icons` to regenerate PNGs from the SVG sources.

## Docker (not recommended; fallback only)

The repo still includes `Dockerfile` and `docker-compose.yml` based on `node:alpine`, port `20267:20267`, with data bind-mounted to `./data`.

**Not recommended for daily use.** Containers usually lack the local Cursor Agent, credentials, and full toolchain, so tasks often fail or behave differently from the host. Only consider this if you need an isolated experiment and have already solved the Cursor SDK environment inside the container.

If you still try compose, note that it overrides `PROJECT_ROOTS` with container paths (for example `/workspace/d-code`) and mounts Windows drives. That is not the same as the host `.env` Windows paths—change them back before returning to host runs.

## Security notes

- Do not commit `.env`, runtime files under `data/` (such as `app.db` or legacy `jobs.json`), or the admin password to Git.
- Public access must use HTTPS, with `COOKIE_SECURE=true`.
- Do not set `PROJECT_ROOTS` to an entire system drive; prefer roots like `E:\code;D:\code;C:\code`.
- Share the console by permission. Do not share one admin password. Two agents on the same project can overwrite each other’s files.
- There is no self-registration; only users with “Manage users” can create accounts.
- Scheduled rules still go through the same project checks as a logged-in user; they only send a prompt to the Cursor Agent and never become arbitrary system commands.
