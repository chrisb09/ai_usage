import { createHash } from "node:crypto"
import type { AccountStateRow, CollectResult, Quota } from "./domain.js"
import type { PolicyConfig } from "./config.js"

const MIN_CHECK_DELAY_MS = 5_000
const MAX_RESET_JITTER_MS = 30_000
const BACKOFF_JITTER = 0.1

export interface StateUpdate {
  fingerprint: string | null
  intervalSec: number
  unchangedStreak: number
  errorIntervalSec: number
  lastAttemptAt: string
  lastSuccessAt: string | null
  lastChangeAt: string | null
  nextCheckAt: string
  lastError: string | null
  lastWarning: string | null
  lastDurationMs: number
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function normalizedResetAt(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return Math.floor(parsed / 60_000)
}

export function fingerprintQuotas(quotas: Quota[]): string {
  const normalized = quotas
    .map((quota) => ({
      key: quota.key,
      remaining:
        quota.remaining === null
          ? null
          : Math.round(quota.remaining * 100_000) / 100_000,
      resetAt: normalizedResetAt(quota.resetAt),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

export function detectQuotaChange(
  previous: Quota[] | null,
  current: Quota[],
  config: Pick<PolicyConfig, "changeEpsilonPp" | "resetShiftSec">,
  timing?: {
    previousCheckedAt: string | null
    currentCheckedAt: string
  },
): boolean {
  if (!previous) return true

  const previousByKey = new Map(previous.map((quota) => [quota.key, quota]))
  const currentByKey = new Map(current.map((quota) => [quota.key, quota]))

  if (previousByKey.size !== currentByKey.size) return true

  const previousMs = timing?.previousCheckedAt
    ? Date.parse(timing.previousCheckedAt)
    : null
  const currentMs = timing ? Date.parse(timing.currentCheckedAt) : null
  const elapsedMs =
    previousMs !== null &&
    currentMs !== null &&
    Number.isFinite(previousMs) &&
    Number.isFinite(currentMs)
      ? Math.max(0, currentMs - previousMs)
      : null
  const toleranceMs = Math.max(5_000, config.resetShiftSec * 1000)

  for (const [key, currentQuota] of currentByKey) {
    const previousQuota = previousByKey.get(key)
    if (!previousQuota) return true

    if (previousQuota.remaining === null || currentQuota.remaining === null) {
      if (previousQuota.remaining !== currentQuota.remaining) return true
    } else {
      const deltaPp = Math.abs(previousQuota.remaining - currentQuota.remaining) * 100
      if (deltaPp >= config.changeEpsilonPp) return true
    }

    const previousReset = normalizedResetAt(previousQuota.resetAt)
    const currentReset = normalizedResetAt(currentQuota.resetAt)

    if (previousReset === null || currentReset === null) {
      if (previousReset !== currentReset) return true
      continue
    }

    if (elapsedMs === null) {
      if (Math.abs(previousReset - currentReset) * 60 > config.resetShiftSec) {
        return true
      }
      continue
    }

    const shiftMs = (currentReset - previousReset) * 60_000
    const fixedSchedule = Math.abs(shiftMs) <= toleranceMs
    const slidingSchedule = Math.abs(shiftMs - elapsedMs) <= toleranceMs
    if (!fixedSchedule && !slidingSchedule) return true
  }

  return false
}

function isAuthError(message: string): boolean {
  return /\b(401|403)\b|unauthorized|forbidden|expired|invalid.?token|missing .*token|missing .*cookie/i.test(
    message,
  )
}

function iso(date: Date): string {
  return date.toISOString()
}

function jitteredIntervalMs(seconds: number, random: () => number): number {
  const factor = 1 - BACKOFF_JITTER + random() * BACKOFF_JITTER * 2
  return Math.max(MIN_CHECK_DELAY_MS, Math.round(seconds * 1000 * factor))
}

function earliestUpcomingReset(quotas: Quota[], nowMs: number): number | null {
  let earliest: number | null = null
  for (const quota of quotas) {
    if (!quota.resetAt) continue
    const resetMs = Date.parse(quota.resetAt)
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue
    if (earliest === null || resetMs < earliest) earliest = resetMs
  }
  return earliest
}

export function computeStateUpdate(args: {
  previous: AccountStateRow | null
  previousQuotas: Quota[] | null
  result: CollectResult
  now: Date
  config: PolicyConfig
  random?: () => number
}): StateUpdate {
  const { previous, previousQuotas, result, now, config } = args
  const random = args.random ?? Math.random
  const nowMs = now.getTime()
  const previousInterval = previous?.intervalSec ?? config.minIntervalSec

  if (result.error) {
    const previousErrorInterval = previous?.errorIntervalSec ?? 0
    const nextErrorInterval = isAuthError(result.error)
      ? config.errorMaxSec
      : previousErrorInterval > 0
        ? Math.min(
            config.errorMaxSec,
            Math.max(config.errorMinSec, previousErrorInterval * 2),
          )
        : config.errorMinSec

    return {
      fingerprint: previous?.fingerprint ?? null,
      intervalSec: previousInterval,
      unchangedStreak: previous?.unchangedStreak ?? 0,
      errorIntervalSec: nextErrorInterval,
      lastAttemptAt: iso(now),
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastChangeAt: previous?.lastChangeAt ?? null,
      nextCheckAt: iso(new Date(nowMs + jitteredIntervalMs(nextErrorInterval, random))),
      lastError: result.error,
      lastWarning: result.warning ?? previous?.lastWarning ?? null,
      lastDurationMs: result.durationMs,
    }
  }

  const changed =
    !previous ||
    !previousQuotas ||
    previous.lastError !== null ||
    detectQuotaChange(previousQuotas, result.quotas, config, {
      previousCheckedAt: previous.lastSuccessAt,
      currentCheckedAt: iso(now),
    })

  const intervalSec = changed
    ? config.minIntervalSec
    : Math.min(
        config.maxIntervalSec,
        Math.max(config.minIntervalSec, previousInterval * 2),
      )
  const unchangedStreak = changed ? 0 : (previous?.unchangedStreak ?? 0) + 1

  const plannedMs = Math.min(
    config.maxIntervalSec * 1000,
    jitteredIntervalMs(intervalSec, random),
  )
  let nextMs = nowMs + plannedMs

  const resetMs = earliestUpcomingReset(result.quotas, nowMs)
  if (resetMs !== null) {
    const resetCandidateMs =
      resetMs + config.resetGraceSec * 1000 + Math.floor(random() * MAX_RESET_JITTER_MS)
    if (resetCandidateMs < nextMs) {
      nextMs = Math.max(nowMs + MIN_CHECK_DELAY_MS, resetCandidateMs)
    }
  }

  return {
    fingerprint: fingerprintQuotas(result.quotas),
    intervalSec,
    unchangedStreak,
    errorIntervalSec: 0,
    lastAttemptAt: iso(now),
    lastSuccessAt: iso(now),
    lastChangeAt: changed ? iso(now) : (previous?.lastChangeAt ?? null),
    nextCheckAt: iso(new Date(nextMs)),
    lastError: null,
    lastWarning: result.warning ?? null,
    lastDurationMs: result.durationMs,
  }
}

export function isDue(nextCheckAt: string | null, now: Date): boolean {
  if (!nextCheckAt) return true
  const next = Date.parse(nextCheckAt)
  return !Number.isFinite(next) || next <= now.getTime()
}

export function isStale(
  lastSuccessAt: string | null,
  maxIntervalSec: number,
  now: Date,
): boolean {
  if (!lastSuccessAt) return true
  const last = Date.parse(lastSuccessAt)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last > maxIntervalSec * 1000
}
