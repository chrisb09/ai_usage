# AI Usage Companion (browser addon)

A Firefox (and Chromium) addon that keeps the dashboard's Mistral Code session
alive. The dashboard collects Mistral usage server-side with a session cookie;
when that cookie stops working, this addon detects it, pushes a fresh cookie
from your browser, and clears its badge once the server confirms it works.

## How it works

1. Every 15 minutes the addon polls `<server>/api/public/usage` and checks the
   Mistral Code account for `needs login` / stale state.
2. On trouble it reads the current `ory_session_*` cookie for chat.mistral.ai
   from your browser and pushes it to `<server>/api/credentials/mistral`.
3. The server validates the cookie with a live collection attempt, stores it in
   `mistral.json`, and refreshes the account. If validation succeeds the badge
   clears — usually **without you logging in again**, because your browser
   session typically outlives the server-side copy.
4. Only when the browser session itself has expired do you get a single
   notification. Log in to chat.mistral.ai as usual; the addon watches for the
   new `ory_session_*` cookie and pushes it automatically.

The badge is a red `!` on the toolbar icon; the popup shows the current state
and offers a manual "Push cookie now" button.

## Setup

0. **Grab a build** — `releases/` holds the latest packaged `.xpi`. The
   unsigned build works for temporary `about:debugging` loading; for a
   permanent install use the AMO-signed build (see below).
1. **Install** — Firefox/Chromium-based browsers: open `about:debugging`,
   choose *This Firefox*, *Load Temporary Add-on*, and pick `manifest.json`.
   For a permanent install, submit the `.xpi` to AMO as an *unlisted* addon
   (developers/addon/submit → "On your own") to get it Mozilla-signed, then
   install the signed build via `about:addons` → gear icon → *Install Add-on
   From File*. Forks that ship with `xpinstall.signatures.required = false`
   (check `about:config`) can install unsigned builds directly. Pack a fresh
   build with `zip -r ../ai-usage-companion.xpi . -x 'releases/*'` from this
   directory (the icon was generated with `google/gemini-3-pro-image` via
   OpenRouter).
2. **Configure** — open the addon options and set:
   - *Dashboard server URL*, e.g. `https://usage.example.com`
   - *Push token* — the server's `CREDENTIAL_PUSH_TOKEN` value
3. **Grant the server origin** if prompted (the options page requests it so
   the addon may talk to your dashboard).

## Permissions

- `cookies` + `https://chat.mistral.ai/*` — read the `ory_session_*` session
  cookie (HttpOnly, so a content script cannot see it).
- Optional origin for your dashboard URL — status polling and cookie push.
- `alarms`, `notifications`, `storage` — polling, one-time notification,
  configuration.

## Security notes

- The push token authorizes **nothing except updating the Mistral session
  cookie** on your own dashboard; rotate it in the server `.env` anytime.
- Cookies travel only between your browser and your dashboard — keep the
  dashboard on HTTPS when it is not on localhost.
- The cookie is stored server-side in `mistral.json` (mode 600) and never
  appears in API responses or logs.
