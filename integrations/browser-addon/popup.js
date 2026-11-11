const api = typeof browser !== "undefined" ? browser : chrome

const NEEDS_LOGIN =
  /expired|unauthorized|forbidden|\b401\b|\b403\b|missing .*(cookie|token)|codex login/i

async function config() {
  const stored = await api.storage.local.get(["serverUrl", "pushToken"])
  return {
    serverUrl: (stored.serverUrl || "").replace(/\/+$/, ""),
    pushToken: stored.pushToken || "",
  }
}

async function renderStatus() {
  const el = document.getElementById("status")
  const detail = document.getElementById("detail")
  const cfg = await config()
  if (!cfg.serverUrl) {
    el.textContent = "Not configured — open Options."
    el.className = "status warn"
    return
  }
  try {
    const response = await fetch(cfg.serverUrl + "/api/public/usage", {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    const account = (body.accounts || []).find((a) => a.provider === "Mistral Code")
    if (!account) {
      el.textContent = "Mistral Code account missing on the server."
      el.className = "status warn"
      return
    }
    if ((account.lastError && NEEDS_LOGIN.test(account.lastError)) || account.stale) {
      el.textContent = "Mistral session needs attention."
      el.className = "status bad"
      if (account.lastError) {
        detail.hidden = false
        detail.textContent = account.lastError
      }
      return
    }
    const quota = (account.quotas || [])[0]
    const used = quota && quota.raw && typeof quota.raw.usagePercent === "number"
      ? ` — ${quota.raw.usagePercent}% used`
      : ""
    el.textContent = `Mistral session healthy${used}.`
    el.className = "status ok"
  } catch (error) {
    el.textContent = `Server unreachable (${String(error).slice(0, 80)})`
    el.className = "status bad"
  }
}

async function pushNow() {
  const result = document.getElementById("pushResult")
  const cfg = await config()
  if (!cfg.serverUrl || !cfg.pushToken) {
    result.textContent = "Configure server URL and push token first (Options)."
    return
  }
  const cookies = await api.cookies.getAll({ domain: "mistral.ai" })
  const session = cookies.find((cookie) => cookie.name.startsWith("ory_session_"))
  if (!session) {
    result.textContent = "No ory_session_* cookie found — log in to chat.mistral.ai first."
    return
  }
  try {
    const response = await fetch(cfg.serverUrl + "/api/credentials/mistral", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.pushToken}`,
      },
      body: JSON.stringify({ cookieName: session.name, cookieValue: session.value }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json().catch(() => ({}))
    if (response.ok && body.ok !== false) {
      const quota = (body.quotas || [])[0]
      const used = quota && quota.raw && typeof quota.raw.usagePercent === "number"
        ? ` (${quota.raw.usagePercent}% used)`
        : ""
      result.textContent = `Reconnected${used}.`
    } else {
      result.textContent = `Push failed: ${body.error || `HTTP ${response.status}`}`
    }
  } catch (error) {
    result.textContent = `Push failed: ${String(error).slice(0, 100)}`
  }
  await renderStatus()
}

document.getElementById("push").addEventListener("click", () => void pushNow())
document.getElementById("options").addEventListener("click", () => api.runtime.openOptionsPage())
void renderStatus()
