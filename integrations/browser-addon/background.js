// AI Usage Companion — background logic.
// Polls the dashboard's public usage API; when the Mistral Code session is
// stale or needs login, pushes the browser's current ory_session_* cookie to
// the server, which validates it, persists it, and refreshes the account.

const api = typeof browser !== "undefined" ? browser : chrome

const MISTRAL_COOKIE_DOMAIN = "mistral.ai"
const NEEDS_LOGIN =
  /expired|unauthorized|forbidden|\b401\b|\b403\b|missing .*(cookie|token)|codex login/i
const POLL_ALARM = "ai-usage-poll"
const POLL_MINUTES = 15

function config() {
  return api.storage.local
    .get(["serverUrl", "pushToken"])
    .then((stored) => ({
      serverUrl: (stored.serverUrl || "").replace(/\/+$/, ""),
      pushToken: stored.pushToken || "",
    }))
}

async function setBadge(active, tooltip) {
  try {
    await api.action.setBadgeText({ text: active ? "!" : "" })
    if (active) await api.action.setBadgeBackgroundColor({ color: "#d20f39" })
    await api.action.setTitle({ title: tooltip })
  } catch (error) {
    // Headless/test environments may lack action APIs; ignore.
  }
}

async function fetchStatus(serverUrl) {
  const response = await fetch(serverUrl + "/api/public/usage", {
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  const account = (body.accounts || []).find((a) => a.provider === "Mistral Code")
  if (!account) return "missing"
  if ((account.lastError && NEEDS_LOGIN.test(account.lastError)) || account.stale) {
    return "needs-login"
  }
  return "ok"
}

async function readSessionCookie() {
  const cookies = await api.cookies.getAll({ domain: MISTRAL_COOKIE_DOMAIN })
  const session = cookies.find((cookie) => cookie.name.startsWith("ory_session_"))
  return session
    ? { cookieName: session.name, cookieValue: session.value }
    : null
}

async function pushCookie(cfg, cookie) {
  const response = await fetch(cfg.serverUrl + "/api/credentials/mistral", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.pushToken}`,
    },
    body: JSON.stringify(cookie),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok && body.ok !== false, status: response.status, body }
}

async function notifyOnce(title, message) {
  const { notifiedSessionExpired } = await api.storage.local.get({
    notifiedSessionExpired: false,
  })
  if (notifiedSessionExpired) return
  await api.storage.local.set({ notifiedSessionExpired: true })
  try {
    await api.notifications.create({
      type: "basic",
      title,
      message,
      iconUrl: api.runtime.getURL("icons/icon-96.png"),
    })
  } catch (error) {
    // Notifications may be unavailable; the badge still shows the state.
  }
}

async function resetNotified() {
  await api.storage.local.remove("notifiedSessionExpired")
}

async function check(autoFix = true) {
  const cfg = await config()
  if (!cfg.serverUrl) {
    await setBadge(true, "AI Usage: open the addon options to configure the server")
    return "unconfigured"
  }

  let state
  try {
    state = await fetchStatus(cfg.serverUrl)
  } catch (error) {
    await setBadge(false, "AI Usage: server unreachable")
    return "offline"
  }

  if (state === "ok") {
    await resetNotified()
    await setBadge(false, "AI Usage: Mistral session healthy")
    return "ok"
  }

  await setBadge(
    true,
    state === "missing"
      ? "AI Usage: Mistral Code account missing on the server"
      : "AI Usage: Mistral session needs attention",
  )

  if (autoFix && cfg.pushToken) {
    const cookie = await readSessionCookie()
    if (cookie) {
      const result = await pushCookie(cfg, cookie)
      if (result.ok) {
        await resetNotified()
        await setBadge(false, "AI Usage: Mistral session reconnected")
        return "ok"
      }
    }
  }

  await notifyOnce(
    "AI Usage: Mistral session expired",
    "Log in to chat.mistral.ai and the addon reconnects the dashboard automatically.",
  )
  return "needs-login"
}

api.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES, delayInMinutes: 0.5 })
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) check()
})

api.cookies.onChanged.addListener(async (change) => {
  const cookie = change.cookie
  if (change.removed || !cookie) return
  if (!cookie.name.startsWith("ory_session_")) return
  if (!(cookie.domain || "").endsWith(MISTRAL_COOKIE_DOMAIN)) return

  const cfg = await config()
  if (!cfg.serverUrl || !cfg.pushToken) return

  // Only push genuinely new cookie values (the site may rotate often).
  const { lastPushedCookie } = await api.storage.local.get({ lastPushedCookie: "" })
  const pair = `${cookie.name}=${cookie.value}`
  if (pair === lastPushedCookie) return
  await api.storage.local.set({ lastPushedCookie: pair })

  await pushCookie(cfg, { cookieName: cookie.name, cookieValue: cookie.value })
  check()
})

api.runtime.onInstalled.addListener(() => check())
check()
