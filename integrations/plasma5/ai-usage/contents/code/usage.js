.pragma library

var HOUR_SEC = 3600
var DAY_SEC = 86400

var COLOR_GOOD = "#3fb950"
var COLOR_WARNING = "#d29922"
var COLOR_CRITICAL = "#f85149"
var COLOR_UNKNOWN = "#8b949e"

function number(value) {
    return typeof value === "number" && isFinite(value) ? value : NaN
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
}

function windowSec(quota) {
    if (!quota) return null

    var direct = number(quota.windowSec)
    if (!isNaN(direct) && direct > 0) return direct

    var raw = quota.raw || {}
    var fromRaw = number(raw.windowSec)
    if (isNaN(fromRaw)) fromRaw = number(raw.windowSeconds)
    if (!isNaN(fromRaw) && fromRaw > 0) return fromRaw

    var text = (String(quota.key || "") + " " + String(quota.label || "")).toLowerCase()
    if (/(^|[^a-z0-9])5h([^a-z0-9]|$)/.test(text) ||
            text.indexOf("5-hour") >= 0 || text.indexOf("5 hour") >= 0) {
        return 5 * HOUR_SEC
    }
    if (text.indexOf("weekly") >= 0 || text.indexOf("week") >= 0) return 7 * DAY_SEC
    if (text.indexOf("monthly") >= 0 || text.indexOf("month") >= 0) return 30 * DAY_SEC
    if (text.indexOf("daily") >= 0 || text.indexOf("day") >= 0) return DAY_SEC
    return null
}

function elapsedFraction(quota, serverTime) {
    if (!quota || !quota.resetAt) return -1

    var end = Date.parse(quota.resetAt)
    var now = serverTime ? Date.parse(serverTime) : Date.now()
    if (!isFinite(end) || !isFinite(now)) return -1

    var seconds = windowSec(quota)
    if (seconds === null) return -1

    var remainingSec = (end - now) / 1000
    if (remainingSec <= 0) return 1
    if (remainingSec >= seconds) return 0
    return clamp(1 - remainingSec / seconds, 0, 1)
}

function timeRemainingFraction(quota, serverTime) {
    var elapsed = elapsedFraction(quota, serverTime)
    return elapsed < 0 ? -1 : 1 - elapsed
}

function status(remaining, elapsed) {
    var value = number(remaining)
    if (isNaN(value) || value < 0) return "unknown"
    if (value <= 0.05) return "critical"

    if (elapsed >= 0) {
        var ideal = 1 - elapsed
        if (value <= 0.2 || value < ideal - 0.05) return "warning"
    } else if (value <= 0.2) {
        return "warning"
    }
    return "good"
}

function statusColor(statusName) {
    if (statusName === "good") return COLOR_GOOD
    if (statusName === "warning") return COLOR_WARNING
    if (statusName === "critical") return COLOR_CRITICAL
    return COLOR_UNKNOWN
}

function formatPct(value, precise) {
    var fraction = number(value)
    if (isNaN(fraction) || fraction < 0) return "—"
    var pct = fraction * 100
    if (precise) {
        var rounded = Math.round(pct * 10) / 10
        if (rounded % 1 !== 0) return rounded.toFixed(1) + "%"
        return Math.round(rounded) + "%"
    }
    if (pct > 0 && pct < 10) return (Math.round(pct * 10) / 10).toFixed(1) + "%"
    return Math.round(pct) + "%"
}

function formatMoney(value) {
    var amount = number(value)
    if (isNaN(amount)) return ""
    return "$" + amount.toFixed(2)
}

function balanceText(quota) {
    if (!quota || !quota.raw) return ""
    var balance = number(quota.raw.balanceUsd)
    if (isNaN(balance)) return ""
    var budget = number(quota.raw.quotaUsd)
    if (!isNaN(budget)) return formatMoney(balance) + " / " + formatMoney(budget)
    return formatMoney(balance)
}

function formatDuration(ms) {
    if (!isFinite(ms)) return ""
    if (ms <= 0) return "now"
    var totalMinutes = Math.floor(ms / 60000)
    var days = Math.floor(totalMinutes / 1440)
    var hours = Math.floor((totalMinutes % 1440) / 60)
    var minutes = totalMinutes % 60
    if (days > 0) return days + "d " + hours + "h"
    if (hours > 0) return hours + "h " + minutes + "m"
    if (minutes > 0) return minutes + "m"
    return "<1m"
}

function formatReset(quota, serverTime) {
    if (!quota || !quota.resetAt) return ""
    var end = Date.parse(quota.resetAt)
    var now = serverTime ? Date.parse(serverTime) : Date.now()
    if (!isFinite(end) || !isFinite(now)) return ""

    var delta = end - now
    var seconds = windowSec(quota)
    if (delta <= 0) return seconds === null ? "expired" : "reset due"
    return (seconds === null ? "expires in " : "resets in ") + formatDuration(delta)
}

function paceText(quota, serverTime) {
    if (!quota) return ""
    var remaining = number(quota.remaining)
    var elapsed = elapsedFraction(quota, serverTime)
    if (isNaN(remaining) || remaining < 0 || elapsed < 0) return ""

    var delta = Math.round((remaining - (1 - elapsed)) * 100)
    if (delta > 0) return "ahead " + delta + "pp"
    if (delta < 0) return "behind " + Math.abs(delta) + "pp"
    return "on pace"
}

function shortLabel(quota) {
    if (!quota) return "—"

    var key = String(quota.key || "").toLowerCase()
    var label = ""
    if (key.indexOf("claude") >= 0) label = "Claude"
    else if (key.indexOf("gemini") >= 0) label = "Gemini"
    else if (key.indexOf("codex") >= 0) label = "Codex"
    else if (key.indexOf("opencode-go") >= 0) label = "Go"
    else if (key.indexOf("oneprovider") >= 0) label = "OneProv"
    else if (key.indexOf("vnai") >= 0) label = "VNAI"
    else if (key.indexOf("free-trial") >= 0) label = "GCP"
    else {
        label = String(quota.label || quota.key || "—").split("—")[0].trim()
        if (label.length > 9) label = label.substring(0, 8) + "…"
    }

    var text = (key + " " + String(quota.label || "")).toLowerCase()
    if (label.indexOf("5h") < 0 &&
            (text.indexOf("5h") >= 0 || text.indexOf("5-hour") >= 0 || text.indexOf("5 hour") >= 0)) {
        label += " 5h"
    }
    return label
}

function quotaRank(quota) {
    var key = quota && quota.key ? String(quota.key) : ""
    var label = quota && quota.label ? String(quota.label) : ""
    var text = (key + " " + label).toLowerCase()
    if (text.indexOf("weekly") >= 0 || text.indexOf("week") >= 0) return 0
    if (text.indexOf("monthly") >= 0 || text.indexOf("month") >= 0) return 1
    if (text.indexOf("5h") >= 0 || text.indexOf("5-hour") >= 0 || text.indexOf("5 hour") >= 0) return 2
    if (text.indexOf("daily") >= 0 || text.indexOf("day") >= 0) return 3
    return 4
}

var PROVIDER_ORDER = [
    "Google",
    "Codex",
    "OpenCode Go",
    "OneProvider",
    "VNAI Pro",
    "Google Cloud"
]

function providerRank(provider) {
    for (var i = 0; i < PROVIDER_ORDER.length; i++) {
        if (PROVIDER_ORDER[i] === provider) return i
    }
    return PROVIDER_ORDER.length
}

function buildRows(sections) {
    var rows = []
    for (var s = 0; s < sections.length; s++) {
        var section = sections[s]
        rows.push({
            kind: "section",
            title: section.title,
            count: section.accounts.length
        })
        for (var a = 0; a < section.accounts.length; a++) {
            var account = section.accounts[a]
            rows.push({
                kind: "account",
                account: account,
                showLabel: account.label !== section.title || section.accounts.length > 1
            })
            if (account.lastError) {
                rows.push({ kind: "error", text: account.lastError })
            }
            if (account.lastWarning) {
                rows.push({ kind: "warning", text: account.lastWarning })
            }
            for (var q = 0; q < account.quotas.length; q++) {
                rows.push({ kind: "quota", quota: account.quotas[q], account: account })
            }
        }
    }
    return rows
}

function buildSections(accounts) {
    var active = []
    var i
    var j
    for (i = 0; i < (accounts || []).length; i++) {
        var account = accounts[i]
        if (!account || account.active === false) continue
        active.push(account)
    }

    active.sort(function (a, b) {
        var pa = providerRank(a.provider)
        var pb = providerRank(b.provider)
        if (pa !== pb) return pa - pb
        return String(a.label || "").localeCompare(String(b.label || ""))
    })

    var sections = []
    for (i = 0; i < active.length; i++) {
        var current = active[i]
        var section = null
        for (j = 0; j < sections.length; j++) {
            if (sections[j].title === current.provider) {
                section = sections[j]
                break
            }
        }
        if (!section) {
            section = { title: current.provider || "Other", accounts: [] }
            sections.push(section)
        }

        var quotas = []
        for (j = 0; j < (current.quotas || []).length; j++) quotas.push(current.quotas[j])
        quotas.sort(function (a, b) {
            var ra = quotaRank(a)
            var rb = quotaRank(b)
            if (ra !== rb) return ra - rb
            return String(a.label || a.key || "").localeCompare(String(b.label || b.key || ""))
        })

        section.accounts.push({
            key: current.accountKey,
            label: current.label,
            provider: current.provider,
            active: current.active,
            lastSuccessAt: current.lastSuccessAt,
            lastError: current.lastError,
            lastWarning: current.lastWarning,
            stale: current.stale,
            refreshing: current.refreshing,
            quotas: quotas
        })
    }
    return sections
}

function betterQuota(candidate, candidateAccount, current, currentAccount) {
    var a = number(candidate.remaining)
    var b = number(current.remaining)
    if (isNaN(a)) return false
    if (isNaN(b)) return true
    if (a !== b) return a < b
    return String(candidateAccount.label || "").localeCompare(String(currentAccount.label || "")) < 0
}

function emptySeries(selector) {
    var colon = selector.indexOf(":")
    var key = colon > 0 ? selector.substring(colon + 1).trim() : selector
    return {
        id: selector,
        label: shortLabel({ key: key, label: key }),
        quotaKey: key,
        quotaLabel: key,
        accountKey: "",
        accountLabel: "",
        provider: colon > 0 ? selector.substring(0, colon).trim() : "",
        remaining: -1,
        elapsed: -1,
        marker: -1,
        status: "unknown",
        resetText: "",
        paceText: "",
        balanceText: "",
        available: false,
        matchCount: 0
    }
}

function providerKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function selectSeries(accounts, selectors, serverTime) {
    var result = []
    var raw = typeof selectors === "string" ? selectors.split(",") : (selectors || [])

    for (var s = 0; s < raw.length; s++) {
        var selector = String(raw[s] || "").trim()
        if (!selector) continue

        var colon = selector.indexOf(":")
        if (colon <= 0) {
            result.push(emptySeries(selector))
            continue
        }

        var provider = selector.substring(0, colon).trim()
        var quotaKey = selector.substring(colon + 1).trim()
        var chosen = null
        var matchCount = 0

        for (var i = 0; i < (accounts || []).length; i++) {
            var account = accounts[i]
            if (!account || account.active === false) continue
            if (provider !== "*" &&
                    providerKey(account.provider) !== providerKey(provider)) {
                continue
            }

            for (var j = 0; j < (account.quotas || []).length; j++) {
                var quota = account.quotas[j]
                if (!quota || quota.key !== quotaKey) continue
                matchCount += 1
                if (chosen === null || betterQuota(quota, account, chosen.quota, chosen.account)) {
                    chosen = { quota: quota, account: account }
                }
            }
        }

        if (chosen === null) {
            result.push(emptySeries(selector))
            continue
        }

        var remaining = number(chosen.quota.remaining)
        var elapsed = elapsedFraction(chosen.quota, serverTime)
        result.push({
            id: selector,
            label: shortLabel(chosen.quota),
            quotaKey: chosen.quota.key,
            quotaLabel: chosen.quota.label,
            accountKey: chosen.account.accountKey,
            accountLabel: chosen.account.label,
            provider: chosen.account.provider,
            remaining: isNaN(remaining) ? -1 : remaining,
            elapsed: elapsed,
            marker: elapsed < 0 ? -1 : 1 - elapsed,
            status: status(remaining, elapsed),
            resetText: formatReset(chosen.quota, serverTime),
            paceText: paceText(chosen.quota, serverTime),
            balanceText: balanceText(chosen.quota),
            available: !isNaN(remaining) && remaining >= 0,
            matchCount: matchCount
        })
    }
    return result
}

function compactTooltip(series) {
    var parts = []
    for (var i = 0; i < (series || []).length; i++) {
        var item = series[i]
        if (!item.available) {
            parts.push(item.label + " —")
            continue
        }
        var text = item.label + " " + formatPct(item.remaining)
        if (item.matchCount > 1) text += " (worst of " + item.matchCount + ")"
        if (item.paceText) text += ", " + item.paceText
        parts.push(text)
    }
    return parts.join(" · ")
}

function issueCount(accounts) {
    var count = 0
    for (var i = 0; i < (accounts || []).length; i++) {
        var account = accounts[i]
        if (account && account.active !== false && (account.lastError || account.stale)) count += 1
    }
    return count
}

function activeCount(accounts) {
    var count = 0
    for (var i = 0; i < (accounts || []).length; i++) {
        if (accounts[i] && accounts[i].active !== false) count += 1
    }
    return count
}

function errorCount(accounts) {
    var count = 0
    for (var i = 0; i < (accounts || []).length; i++) {
        if (accounts[i] && accounts[i].active !== false && accounts[i].lastError) count += 1
    }
    return count
}

function accountStatus(account) {
    if (!account) return ""
    if (account.refreshing) return "refreshing…"
    if (account.lastError) return "error"
    if (account.stale) return "stale"
    return ""
}

function formatClock(ms) {
    if (!ms) return ""
    var date = new Date(ms)
    var hours = date.getHours()
    var minutes = date.getMinutes()
    return (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes
}

function fetchedText(ms) {
    if (!ms) return "not loaded"
    return "fetched " + formatClock(ms)
}
