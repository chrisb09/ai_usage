import type { Quota } from "./domain.js"

const HOUR_SEC = 3_600
const DAY_SEC = 86_400

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null
}

/**
 * Length of a quota window in seconds, when it can be determined.
 *
 * Collectors put the exact value in `raw.windowSec`. Older observations and
 * imported rows fall back to the quota key/label so clients can still show a
 * useful time marker after an upgrade.
 */
export function quotaWindowSec(quota: Quota): number | null {
  const explicit = positive(quota.windowSec)
  if (explicit !== null) return explicit

  const fromRaw = positive(quota.raw?.windowSec) ?? positive(quota.raw?.windowSeconds)
  if (fromRaw !== null) return fromRaw

  const text = `${quota.key} ${quota.label}`.toLowerCase()
  if (/(^|[^a-z0-9])5h([^a-z0-9]|$)/.test(text) || text.includes("5-hour") || text.includes("5 hour")) {
    return 5 * HOUR_SEC
  }
  if (text.includes("weekly") || text.includes("week")) return 7 * DAY_SEC
  if (text.includes("monthly") || text.includes("month")) return 30 * DAY_SEC
  if (text.includes("daily") || text.includes("day")) return DAY_SEC
  return null
}
