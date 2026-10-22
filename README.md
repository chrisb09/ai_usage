# AI Usage

Personal quota dashboard and JSON API for AI provider accounts. It collects usage
from the same sources as `check_usage.mjs`, stores every observation in SQLite,
and serves a web dashboard plus an HTTP API.

Supported providers:

- Google Antigravity accounts
- OpenCode Go
- Codex
- OneProvider
- VNAI Pro

## Features

- **Adaptive refresh policy** — checks back off from 10 minutes to 6 hours when
  nothing changes. Requests serve cached data unless a check is due. Checks are
  scheduled around known quota reset times.
- **Per-account scheduling** — one account changing does not force a refresh of
  every other account.
- **Background refresh on requests** — the API returns cached data immediately
  and triggers due checks in the background.
- **History** — every successful check is stored, with per-account/quota charts.
- **Long-term overview** — overview history totals use weekly
  or monthly limits, preferring monthly when both exist. Gemini and Claude are
  independent Google pools with separate history lines. Short-window limits
  remain available on account cards and individual account history. Unspecified
  quota windows are excluded from the long-term overview.
- **API key balances** — OneProvider and VNAI Pro cards show remaining dollars,
  original credit budget, and expiry when provided. Select **API key balances**
  in the history view to track each provider's remaining credit percentage.
- **Safe credential handling** — provider files are read-only except Codex,
  where rotated OAuth tokens are written back atomically to its own `auth.json`
  (the same file the CLI uses) to keep the login alive.
- **Secret-safe output** — API responses and logs never include tokens, cookies,
  API keys, or client secrets.

## Quick start with Docker

```bash
git clone https://github.com/chrisb09/ai_usage.git
cd ai_usage
cp .env.example .env
mkdir -p data secrets/opencode secrets/opencode-data secrets/codex
# Populate the credential directories described below, or edit the *_HOST paths.
# Set ANTIGRAVITY_CLIENT_SECRET in .env if collecting Google accounts.
# Set AI_USAGE_UID and AI_USAGE_GID to the values from `id -u` and `id -g`.
docker compose up -d --build
```

Open <http://127.0.0.1:7694>.

The database is stored in its own host bind mount, independent of the image and
container. Set `AI_USAGE_DATA_HOST` in `.env` to keep it outside the code checkout:

```dotenv
AI_USAGE_DATA_HOST=/srv/ai-usage/data
```

Create that directory and make it writable by `AI_USAGE_UID:AI_USAGE_GID` before
starting the container. The default is `./data`; both locations are mounted at
`/data` inside the container, where the app uses `/data/ai_usage.db`. Recreating
or removing the container leaves the host database directory intact.

Requires Docker Engine and Docker Compose. Node/npm are only needed for local
development; the container build installs the application's dependencies.

If you are using the legacy `docker-compose` 1.x binary with a recent Docker
engine, run `docker-compose down` before `docker-compose up -d --build` when
recreating an existing container. Compose v2 (`docker compose`) does not need
this workaround.

The Compose file publishes the dashboard on localhost only. Credential
directories are mounted as follows:

- `${AI_USAGE_DATA_HOST}` → `/data` (read-write; SQLite data and backups)
- `${OPENCODE_CONFIG_HOST}` → `/config/opencode` (read-only)
- `${OPENCODE_DATA_HOST}` → `/config/opencode-data` (read-only; shared auth store)
- `${CODEX_HOME_HOST}` → `/config/codex` (read-write)

The example `.env` uses these portable host directories inside the clone:

| Host directory | Files used |
|---|---|
| `secrets/opencode/` | `antigravity-accounts.json`, `opencode-go.json`, `oneprovider.json` |
| `secrets/opencode-data/` | OpenCode's shared `auth.json` for OneProvider and VNAI Pro |
| `secrets/codex/` | Codex `auth.json` |

You can instead point the three `*_HOST` variables at existing credential
directories. Files under `secrets/` and `data/`, `.env`, CSVs, and SQLite files
are excluded from Git and Docker build context. Only `.env.example` is committed.

Google token refresh also needs `ANTIGRAVITY_CLIENT_SECRET` in your private
`.env`: use the `CLIENT_SECRET` value from your working `check_usage.mjs`.

If a provider's file is missing, that provider is skipped. This applies to
`antigravity-accounts.json`, `opencode-go.json`, `oneprovider.json`, and the
Codex `auth.json`.

OneProvider first reads `oneprovider.json` (`apiKey` or `key`), then falls back to
the `oneprovider.key` entry in OpenCode's shared auth store. VNAI Pro reads
`vnaipro.key` from that same store. On Linux the shared store normally lives at
`~/.local/share/opencode/auth.json`; set `OPENCODE_DATA_HOST` to its parent
directory for Docker. Existing login files are used directly.

For a separate VNAI Pro credential file, set `VNAI_PRO_AUTH_PATH` to a mounted
file containing `{"apiKey":"sk-your-key"}`. Its default is the shared store.
The configured keys stay out of usage responses and logs; only masked labels
and balance/quota information are exposed.

### OpenCode Go console access

OpenCode Go usage is read from `https://opencode.ai/console/api/go/status` using
the console session cookie and an organization/workspace ID. The inference API
key in the shared auth store does not grant access to these subscription meters.
Place the same `opencode-go.json` used by `check_usage` in
`${OPENCODE_CONFIG_HOST}` (or set `OPENCODE_GO_CONFIG_PATH` to a mounted file):

```json
{
  "consoleSession": "st_your-console-session",
  "orgId": "your-organization-id",
  "email": "you@example.com"
}
```

`workspaceId` is accepted as an alias for `orgId`. Existing `authCookie` and
complete `cookie` headers are supported too. All three usage meters—monthly,
weekly, and 5-hour—appear on the account card and individual history. The
overview uses the monthly meter, falling back to weekly when monthly is absent.
An expired session is reported as needing login; replace the console session
in the credential file after signing in again.

The Codex directory is mounted read-write because the server refreshes the
Codex OAuth access token and writes rotated tokens back to `auth.json`, the
same way the Codex CLI does. That keeps the CLI logged in without manual
`codex login` runs. If the mount is read-only, the server still uses the
refreshed token in memory and shows a warning badge until the mount is fixed.

The container runs as `${AI_USAGE_UID}:${AI_USAGE_GID}` (default `1000:1000`).
If your credential files are owned by a different user, set those two values in
`.env` so the container can read the read-only mounts.

### Import existing CSV history

The old `usage_history.csv` can be imported once:

```bash
cp /path/to/usage_history.csv data/usage_history.csv
docker compose run --rm ai-usage node dist/import-csv.js /data/usage_history.csv
```

Imported rows keep their original timestamps. A fresh check is scheduled
immediately. Re-running the importer is safe: duplicate timestamp/account groups
are ignored. You can also run the importer locally with
`npm run import:csv -- /path/to/usage_history.csv`.

## Moving to another machine

The repository contains code and deployment configuration. Runtime data is
transferred separately:

- **SQLite database:** contains all imported history, new observations, account
  state, and refresh scheduling. Copying it is sufficient to preserve history.
- **CSV:** optional archive/import source. Once imported, it is not needed by the
  running application and does not need to be transferred with the database.
- **Credentials and `.env`:** configure these privately on the new machine. Start
  from `.env.example` and use paths and UID/GID values appropriate to that host.

### 1. Prepare the new host

Clone the repo and create the directories from the quick-start section. Copy the
provider credential files into the matching `secrets/` directories and populate
`.env`. Keep the destination service stopped until the database has been copied.
If using a dedicated `AI_USAGE_DATA_HOST`, create that host directory and place
the copied database there instead of the default `data/` directory.

### 2. Export the current database

On the source host, create a consistent snapshot while the service is running:

```bash
docker compose exec ai-usage node dist/backup-db.js /data/ai_usage-export.db
```

This uses SQLite's online backup API and includes committed data still in the
WAL. It produces a self-contained `ai_usage-export.db` in `AI_USAGE_DATA_HOST`
(`data/ai_usage-export.db` with the default mount); choose another
filename if that export already exists. A raw copy of a running `ai_usage.db`
alone can miss recent WAL transactions.

With a local Node installation, the equivalent command is:

```bash
npm run backup:db -- data/ai_usage-export.db
```

### 3. Transfer and start

From the source machine, replacing the SSH destination and clone path:

```bash
scp data/ai_usage-export.db user@new-host:/path/to/ai_usage/data/ai_usage.db
```

For a dedicated host mount, replace the source and destination paths with the
corresponding data directories, for example `/srv/ai-usage/data/ai_usage.db` on
the destination.

For a move, stop the old service before starting the new one so the copied Codex
refresh token has a single writer. On the new host, start the service from the
clone directory:

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:7694/api/health
```

The copied database and credential files must be accessible to the UID/GID in
`.env`; `data/` and the Codex directory must be writable by that user. To access
the loopback-only dashboard from your workstation, you can use an SSH tunnel:

```bash
ssh -N -L 7694:127.0.0.1:7694 user@new-host
```

Then open `http://127.0.0.1:7694` locally. For a reverse-proxy deployment, see
[Remote deployment](#remote-deployment). The legacy `docker-compose` command can
be used in place of `docker compose` throughout these instructions.

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Purpose |
|---|---:|---|
| `HOST` | `127.0.0.1` | Bind address (Compose overrides to `0.0.0.0` inside the container) |
| `PORT` | `7694` | HTTP port |
| `DATABASE_PATH` | `data/ai_usage.db` | SQLite database |
| `AI_USAGE_DATA_HOST` | `./data` | Docker host directory bind-mounted at `/data`; use an absolute path such as `/srv/ai-usage/data` for storage outside the clone |
| `WEB_ROOT` | `web/dist` | Built web assets |
| `MIN_INTERVAL_SEC` | `600` | Minimum automatic check interval |
| `MAX_INTERVAL_SEC` | `21600` | Maximum automatic check interval (6h) |
| `CHANGE_EPSILON_PP` | `0.5` | Remaining change that counts as a change (percentage points) |
| `RESET_SHIFT_SEC` | `120` | Tolerance for reset-time changes before they count as a change |
| `RESET_GRACE_SEC` | `60` | Delay after a quota reset before checking |
| `MANUAL_COOLDOWN_SEC` | `60` | Cooldown between manual refreshes per account |
| `ERROR_MIN_SEC` / `ERROR_MAX_SEC` | `300` / `3600` | Error backoff bounds |
| `CONCURRENCY` | `4` | Parallel provider checks |
| `REQUEST_TIMEOUT_MS` | `15000` | Per-request provider timeout |
| `OPENCODE_CONFIG_DIR` | XDG opencode dir | Directory containing provider JSON files |
| `ANTIGRAVITY_CLIENT_SECRET` | none | Google OAuth client secret from the working reference script; store in private `.env` |
| `OPENCODE_AUTH_PATH` | XDG opencode data dir + `auth.json` | Shared auth store used for OneProvider and VNAI Pro keys |
| `VNAI_PRO_AUTH_PATH` | `OPENCODE_AUTH_PATH` | Optional separate VNAI Pro credential file |
| `CODEX_HOME` | `~/.codex` | Directory containing Codex `auth.json` |
| `TRUST_PROXY` | `false` | Trust reverse-proxy forwarding headers |
| `INCLUDE_DISABLED` | `false` | Include disabled Antigravity accounts |
| `CODEX_REFRESH` | `true` | Refresh Codex OAuth tokens and write them back to `auth.json` |
| `CODEX_REFRESH_SKEW_SEC` | `300` | Refresh the Codex token when it expires within this window |
| `CODEX_CLIENT_ID` | built-in | Override the OAuth client id used for Codex token refresh |

Optional explicit file overrides: `ANTIGRAVITY_ACCOUNTS_PATH`,
`OPENCODE_GO_CONFIG_PATH`, `ONEPROVIDER_CONFIG_PATH`, `CODEX_AUTH_PATH`.

`OPENCODE_DATA_HOST` controls the Docker host directory mounted read-only for the
shared auth store. Compose sets `OPENCODE_AUTH_PATH` inside the container.

Outbound proxy variables are honored: `MY_PROXY_URL`, `HTTP_PROXY`,
`HTTPS_PROXY` (and lowercase variants).

## Refresh policy

State is tracked per account in SQLite.

1. Every successful check is compared against the previous successful check.
2. A change is any remaining quota movement of at least `0.5` percentage points,
   a quota being added/removed, a success/error transition, or a reset-time shift
   that is not explained by a normal sliding window or fixed schedule.
3. If something changed, the next automatic check is after the minimum interval
   (10 minutes by default).
4. If nothing changed, the interval doubles: 10m → 20m → 40m → … → 6h.
5. If a quota reset is known to happen before the next planned check, the check
   is moved to just after that reset.
6. Failed checks use an independent 5m → 1h backoff and keep the last good data,
   which is marked stale.
7. Manual refreshes update the same backoff state. Two manual checks with no
   change push the next automatic check farther out.

`GET /api/usage` returns cached data. If an account is due, it starts a
background refresh and sets `refreshing` flags. `POST /api/refresh` forces a
manual check and waits for it to finish.

## HTTP API

### `GET /api/usage`

Current state for every known account, including quotas, freshness, errors,
next check time, and the current backoff interval.

### `GET /api/history`

Query parameters:

- `accountKey` (optional)
- `quotaKey` (optional)
- `from`, `to` (optional ISO timestamps)
- `bucketSec` (optional; server chooses a bucket if omitted)
- `limit` (default 5000, max 50000)

```bash
curl -s http://127.0.0.1:7694/api/history?accountKey=google:user@example.com \
  | jq '.points | length'
```

### `POST /api/refresh`

Force checks. The body is optional:

```bash
curl -s -X POST http://127.0.0.1:7694/api/refresh \
  -H 'content-type: application/json' \
  -d '{"accountKeys":["google:user@example.com"]}' | jq
```

Per-account manual refreshes are rate-limited by `MANUAL_COOLDOWN_SEC`.
Skipped accounts are reported in the response.

### `GET /api/health`

Liveness, uptime, scheduler state, and database counts. Use this for container
health checks and monitoring.

### `GET /api/meta`

Public policy settings and counts.

## Remote deployment

The intended setup is a small server behind a reverse proxy:

1. Publish the container only on loopback:
   `127.0.0.1:7694:7694` is already the default in `compose.yaml`.
2. Put Caddy, Nginx, or another reverse proxy in front of it with TLS and basic
   authentication.
3. Stage credential files on the server and point `OPENCODE_CONFIG_HOST`,
   `OPENCODE_DATA_HOST`, and `CODEX_HOME_HOST` at them.
4. Set `TRUST_PROXY=true` if the proxy forwards `X-Forwarded-*` headers.

Example Caddy site:

```caddyfile
usage.example.com {
  basic_auth {
    admin $2a$14$REPLACE_WITH_BCRYPT_HASH
  }
  reverse_proxy 127.0.0.1:7694
}
```

The app does not implement its own authentication. Keep the published port on
loopback and let the reverse proxy handle access control.

## Local development

```bash
npm install
cp .env.example .env
npm run dev          # API + scheduler on :7694
npm run dev:web      # Vite dev server on :5173, proxying /api
```

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run collect               # one collection cycle, no server
npm run import:csv -- path/to/usage_history.csv
npm run backup:db -- data/ai_usage-export.db
```

Build the Docker image without starting it:

```bash
docker compose build
```

## Data and security

- Observations and scheduling state live in SQLite (`data/ai_usage.db`).
- Provider credentials are read from the mounted config files. Codex's rotated
  OAuth tokens are the only credential writes.
- Antigravity access tokens are cached in memory until shortly before expiry.
- Codex access tokens are refreshed from `auth.json` shortly before expiry and
  the rotated tokens are written back atomically. A per-account warning badge
  appears if the write-back fails.
- OpenCode Go sessions cannot be refreshed automatically; an expired cookie is
  reported as `needs login`.
- Logs redact authorization and cookie headers.
- API responses include account labels, quota percentages, reset times, and
  sanitized provider details (for example OneProvider balance/limit), but never
  credentials.
- The default Compose port binding is loopback-only.
