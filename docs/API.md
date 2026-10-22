# HTTP API

JSON API for usage data, history, and manual checks.

- Public instance: `https://usage.christian-f-brinkmann.de`
- Local default: `http://127.0.0.1:7694`
- All responses are JSON. Timestamps are ISO 8601 UTC.
- `remaining` values are fractions from `0` to `1` (`0.53` = 53% remaining) or
  `null` when unknown. Multiply by 100 for percentages.
- Account keys use the form `provider:identifier`, for example
  `google:user@example.com`, `codex:default`, `oneprovider:default`, or
  `vnai-pro:default`.

## Authentication

The app does not implement authentication. When it is exposed beyond loopback,
a reverse proxy in front of it enforces HTTP Basic Auth. The public instance
returns `401 Unauthorized` for unauthenticated requests to every path,
including `/api/*`.

Send credentials with every request:

```bash
curl -u 'username:password' https://usage.christian-f-brinkmann.de/api/health
```

or explicitly:

```bash
curl -H "Authorization: Basic $(printf 'username:password' | base64)" \
  https://usage.christian-f-brinkmann.de/api/health
```

Credentials are accepted by the proxy, not the app, so they protect the
dashboard and the API equally. Avoid putting credentials in URLs, since those
end up in logs and shell history.

### Multiple users

The proxy reads a standard Apache-style password file. Create users on the host
with `htpasswd` from `apache2-utils`:

```bash
# First user creates the file; -B selects bcrypt
htpasswd -Bc /container/config/ai_usage/.htpasswd alice

# Additional users append to the existing file
htpasswd -B /container/config/ai_usage/.htpasswd bob
```

Use `-c` only for the first user; it overwrites the file. Update a password by
re-running the command for that username without `-c`.

Nginx:

```nginx
location / {
    auth_basic "AI Usage";
    auth_basic_user_file /etc/nginx/ai_usage.htpasswd;
    proxy_pass http://127.0.0.1:7694;
}
```

Caddy:

```caddyfile
usage.example.com {
  basic_auth {
    alice $2a$14$REPLACE_WITH_BCRYPT_HASH
    bob   $2a$14$REPLACE_WITH_BCRYPT_HASH
  }
  reverse_proxy 127.0.0.1:7694
}
```

Caddy stores users inline in the Caddyfile; Nginx and Apache use the
`.htpasswd` file. If the proxy runs in Docker, mount the password file into the
proxy container read-only. Set `TRUST_PROXY=true` when the proxy forwards
`X-Forwarded-*` headers.

## `GET /api/usage`

Current state of every known account. This is the endpoint the dashboard polls.
Cached data is returned immediately; due checks run in the background and are
reflected by `refreshing`.

Response fields:

| Field | Description |
|---|---|
| `serverTime` | Server clock at response time |
| `accounts` | Array of account views (below) |
| `policy` | Active refresh policy settings |
| `scheduler` | `lastTickAt`, `ticking` |
| `refreshing` | `true` while any check is running or due |

Account view fields:

| Field | Description |
|---|---|
| `accountKey` | Stable key, e.g. `google:user@example.com` |
| `provider` | `Google`, `OpenCode Go`, `Codex`, `OneProvider`, or `VNAI Pro` |
| `label` | Display name (email or masked API key) |
| `active` | `false` for accounts that exist only in imported history |
| `quotas` | Current quota windows, see below |
| `lastAttemptAt`, `lastSuccessAt`, `lastChangeAt` | Timestamps |
| `nextCheckAt` | When the next automatic check is planned |
| `intervalSec` | Current adaptive interval |
| `unchangedStreak` | Consecutive checks without a change |
| `errorIntervalSec` | Current error backoff |
| `lastError`, `lastWarning` | Most recent failure or warning, `null` when none |
| `lastDurationMs` | Duration of the last check |
| `stale` | `true` when data is older than the maximum interval |
| `refreshing` | `true` while this account is being checked |

Quota fields: `key`, `label`, `remaining`, `resetAt`, and an optional `raw`
object. API key providers include `raw.balanceUsd`, `raw.quotaUsd`,
`raw.usedUsd`, and `raw.expiresAt`.

```bash
curl -su 'username:password' https://usage.christian-f-brinkmann.de/api/usage \
  | jq '.accounts[] | {label, provider, refreshing, lastError,
                       quotas: [.quotas[] | {label, remaining}]}'
```

To wait for a specific account to be refreshed:

```bash
curl -su 'username:password' https://usage.christian-f-brinkmann.de/api/usage \
  | jq '.accounts[] | select(.accountKey == "codex:default")'
```

## `GET /api/history`

Observations over time. Query parameters:

| Parameter | Description |
|---|---|
| `accountKey` | Optional; restrict to one account |
| `quotaKey` | Optional; restrict to one quota window |
| `from`, `to` | Optional ISO timestamps; `from` defaults to the earliest stored observation |
| `bucketSec` | Optional bucket size; the server picks one from the time span when omitted |
| `limit` | Maximum points returned (default 5000, max 50000) |

Response: `points` (each with `accountKey`, `quotaKey`, `label`, `remaining`,
`resetAt`, `checkedAt`), plus `bucketSec`, `from`, and `to`. When bucketing,
the newest observation per account and quota in each bucket is kept.

```bash
# Last 24 hours for one account
curl -su 'username:password' \
  "https://usage.christian-f-brinkmann.de/api/history?accountKey=codex:default&from=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
```

## `POST /api/refresh`

Forces checks and waits for them to finish. The body is optional; omit
`accountKeys` to refresh everything.

```bash
curl -su 'username:password' -X POST \
  https://usage.christian-f-brinkmann.de/api/refresh \
  -H 'content-type: application/json' \
  -d '{"accountKeys":["codex:default","oneprovider:default"]}'
```

Response: `refreshed` (with `accountKey`, `provider`, `label`, `quotas`,
`error`, `durationMs`) and `skipped` (with `accountKey`, `reason`). Accounts
inside `MANUAL_COOLDOWN_SEC` (default 60) are skipped. This endpoint is
rate-limited to 10 requests per minute.

## `GET /api/health`

Liveness and counts. Useful for monitoring or a proxy health check:

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptimeSec": 3600,
  "scheduler": { "lastTickAt": "2026-10-22T12:00:00.000Z", "ticking": false },
  "counts": { "accounts": 9, "checks": 8263, "observations": 12621, "lastCheckAt": "2026-10-22T12:00:00.000Z" }
}
```

## `GET /api/meta`

Read-only configuration: `version`, `policy`, `schedulerIntervalSec`,
`concurrency`, and the same `counts` as health.

## MCP endpoint

`POST /mcp` implements the MCP Streamable HTTP transport (stateless, JSON
responses). It exposes three tools:

| Tool | Purpose |
|---|---|
| `usage_overview` | Current accounts, quota percentages, balances, errors, next checks |
| `usage_history` | Compact per-series trends: first/last, change, min/max, reset |
| `refresh_usage` | Force checks; accepts `accountKeys`, omits them to refresh all |

Only `POST` is supported. `GET` and `DELETE` return `405 Method Not Allowed`.
The endpoint has no built-in authentication; it relies on the same reverse-proxy
Basic Auth as the rest of the site. Do not expose it directly.

### opencode configuration

Create a Basic credential once (standard base64 of `username:password`, not URL-safe):

```bash
printf '%s' 'username:password' | base64
```

Set the result as `AI_USAGE_BASIC`, then add this to `opencode.json` or
`opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai-usage": {
      "type": "remote",
      "url": "https://usage.christian-f-brinkmann.de/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Basic {env:AI_USAGE_BASIC}"
      }
    }
  }
}
```

`oauth` must be `false`; otherwise opencode may try its OAuth flow when the
proxy returns `401`. The tools are then available as `ai-usage_*` in prompts,
for example: *"Use ai-usage_usage_overview to find quotas below 20%."*

Direct JSON-RPC example:

```bash
curl -su 'username:password' -X POST \
  https://usage.christian-f-brinkmann.de/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Polling guidance

- Poll `/api/usage` at a modest rate, for example every 30 seconds. The server
  triggers due checks itself; polling does not force provider requests.
- Use `/api/refresh` only for explicit user actions.
- No credentials, cookies, or API keys are ever returned by the API.
