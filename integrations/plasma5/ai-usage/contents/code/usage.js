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

function remainingColor(value) {
    var fraction = number(value)
    if (isNaN(fraction) || fraction < 0) return COLOR_UNKNOWN
    fraction = clamp(fraction, 0, 1)

    var hue = fraction * 2
    var saturation = 0.82
    var brightness = 0.92
    var chroma = brightness * saturation
    var x = chroma * (1 - Math.abs(hue % 2 - 1))
    var red = 0
    var green = 0
    var blue = 0

    if (hue < 1) {
        red = chroma
        green = x
    } else {
        red = x
        green = chroma
    }

    var offset = brightness - chroma
    function channel(component) {
        var hex = Math.round((component + offset) * 255).toString(16)
        return hex.length === 1 ? "0" + hex : hex
    }
    return "#" + channel(red) + channel(green) + channel(blue)
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
    if (text.indexOf("monthly") >= 0 || text.indexOf("month") >= 0) return 0
    if (text.indexOf("weekly") >= 0 || text.indexOf("week") >= 0) return 1
    if (text.indexOf("5h") >= 0 || text.indexOf("5-hour") >= 0 || text.indexOf("5 hour") >= 0) return 2
    if (text.indexOf("daily") >= 0 || text.indexOf("day") >= 0) return 3
    return 4
}

function providerKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

var PROVIDER_ORDER = [
    "Google Claude",
    "Google Gemini",
    "Codex",
    "OpenCode Go",
    "OneProvider",
    "VNAI Pro",
    "Google Cloud"
]

function quotaFamily(account, quota) {
    var provider = String(account && account.provider || "Other")
    var text = (String(quota && quota.key || "") + " " +
        String(quota && quota.label || "")).toLowerCase()
    if (providerKey(provider) === "google") {
        if (text.indexOf("claude") >= 0) return "Google Claude"
        if (text.indexOf("gemini") >= 0) return "Google Gemini"
    }
    return provider
}

function providerRank(provider) {
    for (var i = 0; i < PROVIDER_ORDER.length; i++) {
        if (PROVIDER_ORDER[i] === provider) return i
    }
    return PROVIDER_ORDER.length
}

function windowLabel(quota) {
    var seconds = windowSec(quota)
    if (seconds === 5 * HOUR_SEC) return "5h"
    if (seconds === 7 * DAY_SEC) return "7d"
    if (seconds === 30 * DAY_SEC) return "30d"
    if (seconds === DAY_SEC) return "1d"
    if (seconds !== null) return Math.round(seconds / HOUR_SEC) + "h"
    return "Balance"
}

function nextReset(quotas, serverTime) {
    var now = serverTime ? Date.parse(serverTime) : Date.now()
    var earliest = null
    for (var i = 0; i < quotas.length; i++) {
        if (!quotas[i].resetAt) continue
        var value = Date.parse(quotas[i].resetAt)
        if (!isFinite(value) || value <= now) continue
        if (earliest === null || value < earliest) earliest = value
    }
    return earliest === null ? null : new Date(earliest).toISOString()
}

function pooledWindow(quotas, serverTime) {
    var remainingTotal = 0
    var remainingCount = 0
    var timeTotal = 0
    var windowTotal = 0
    var balanceTotal = 0
    var budgetTotal = 0
    var balanceCount = 0
    var budgetCount = 0

    for (var i = 0; i < quotas.length; i++) {
        var quota = quotas[i]
        var remaining = number(quota.remaining)
        if (!isNaN(remaining) && remaining >= 0) {
            remainingTotal += remaining
            remainingCount += 1
        }

        var seconds = windowSec(quota)
        if (seconds !== null && quota.resetAt) {
            var end = Date.parse(quota.resetAt)
            var now = serverTime ? Date.parse(serverTime) : Date.now()
            if (isFinite(end) && isFinite(now)) {
                timeTotal += clamp((end - now) / 1000, 0, seconds)
                windowTotal += seconds
            }
        }

        var balance = number(quota.raw && quota.raw.balanceUsd)
        var budget = number(quota.raw && quota.raw.quotaUsd)
        if (!isNaN(balance)) {
            balanceTotal += balance
            balanceCount += 1
        }
        if (!isNaN(budget)) {
            budgetTotal += budget
            budgetCount += 1
        }
    }

    var pooled = {
        key: quotas.length > 0 ? quotas[0].key : "",
        label: quotas.length > 0 ? quotas[0].label : "",
        remaining: remainingCount > 0 ? remainingTotal / remainingCount : -1,
        resetAt: nextReset(quotas, serverTime),
        windowSec: quotas.length > 0 ? windowSec(quotas[0]) : null,
        raw: {}
    }
    if (balanceCount === quotas.length) pooled.raw.balanceUsd = balanceTotal
    if (budgetCount === quotas.length) pooled.raw.quotaUsd = budgetTotal

    var elapsed = windowTotal > 0 ? 1 - timeTotal / windowTotal : -1
    var pace = ""
    if (pooled.remaining >= 0 && elapsed >= 0) {
        var delta = Math.round((pooled.remaining - (1 - elapsed)) * 100)
        pace = delta > 0 ? "ahead " + delta + "pp"
            : delta < 0 ? "behind " + Math.abs(delta) + "pp" : "on pace"
    }
    return {
        label: windowLabel(pooled),
        quota: pooled,
        remaining: pooled.remaining,
        elapsed: elapsed,
        marker: elapsed < 0 ? -1 : 1 - elapsed,
        status: status(pooled.remaining, elapsed),
        resetText: formatReset(pooled, serverTime),
        paceText: pace,
        balanceText: balanceText(pooled),
        available: remainingCount > 0,
        matchCount: quotas.length,
        availableCount: remainingCount
    }
}

function buildSummary(accounts, serverTime) {
    var groups = []
    var byId = {}

    for (var i = 0; i < (accounts || []).length; i++) {
        var account = accounts[i]
        if (!account || account.active === false) continue
        var accountQuotas = {}
        for (var j = 0; j < (account.quotas || []).length; j++) {
            var quota = account.quotas[j]
            var family = quotaFamily(account, quota)
            var id = providerKey(family)
            var group = byId[id]
            if (!group) {
                group = {
                    id: id,
                    title: family,
                    accountCount: 0,
                    windows: [],
                    errors: [],
                    warnings: []
                }
                byId[id] = group
                groups.push(group)
            }
            if (!accountQuotas[id]) {
                group.accountCount += 1
                accountQuotas[id] = true
            }
            var seconds = windowSec(quota)
            var windowId = seconds === null ? String(quota.key || quota.label) : String(seconds)
            var windows = group.windowMap || (group.windowMap = {})
            if (!windows[windowId]) windows[windowId] = []
            windows[windowId].push(quota)
        }
        var ownGroups = {}
        for (var quotaKey in accountQuotas) ownGroups[quotaKey] = true
        for (var groupId in ownGroups) {
            if (account.lastError) byId[groupId].errors.push(account.lastError)
            if (account.lastWarning) byId[groupId].warnings.push(account.lastWarning)
        }
    }

    groups.sort(function (a, b) {
        var rank = providerRank(a.title) - providerRank(b.title)
        return rank !== 0 ? rank : a.title.localeCompare(b.title)
    })
    for (var g = 0; g < groups.length; g++) {
        var item = groups[g]
        for (var key in item.windowMap) {
            item.windows.push(pooledWindow(item.windowMap[key], serverTime))
        }
        item.windows.sort(function (a, b) {
            var rank = quotaRank(a.quota) - quotaRank(b.quota)
            return rank !== 0 ? rank : a.label.localeCompare(b.label)
        })
        delete item.windowMap
    }
    return groups
}

function buildRows(groups) {
    var rows = []
    for (var i = 0; i < (groups || []).length; i++) {
        var group = groups[i]
        rows.push({ kind: "summary", group: group })
        for (var e = 0; e < group.errors.length; e++) {
            rows.push({ kind: "error", text: group.errors[e] })
        }
        for (var w = 0; w < group.warnings.length; w++) {
            rows.push({ kind: "warning", text: group.warnings[w] })
        }
    }
    return rows
}

function compactSummary(groups) {
    var result = []
    for (var i = 0; i < (groups || []).length; i++) {
        var group = groups[i]
        var chosen = null
        for (var j = 0; j < group.windows.length; j++) {
            var candidate = group.windows[j]
            var seconds = windowSec(candidate.quota)
            if (chosen === null || (seconds !== null && seconds > windowSec(chosen.quota))) {
                chosen = candidate
            }
        }
        if (chosen === null) continue
        result.push({
            label: group.title,
            remaining: chosen.remaining,
            marker: chosen.marker,
            status: chosen.status,
            available: chosen.available,
            paceText: chosen.paceText,
            matchCount: group.accountCount,
            availableCount: chosen.availableCount
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
        if (item.matchCount > 1) text += " (pooled across " + item.matchCount + ")"
        if (item.availableCount < item.matchCount) text += ", incomplete"
        if (item.paceText) text += ", " + item.paceText
        parts.push(text)
    }
    return parts.join("\n")
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
