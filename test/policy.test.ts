import { describe, expect, it } from "vitest"
import type { PolicyConfig } from "../src/config.js"
import type { AccountStateRow, CollectResult, Quota } from "../src/domain.js"
import {
  computeStateUpdate,
  detectQuotaChange,
  fingerprintQuotas,
  isDue,
  isStale,
} from "../src/policy.js"

const NOW = new Date("2026-10-22T12:00:00.000Z")

const config: PolicyConfig = {
  minIntervalSec: 600,
  maxIntervalSec: 21_600,
  changeEpsilonPp: 0.5,
  resetShiftSec: 120,
  resetGraceSec: 60,
  manualCooldownSec: 60,
  errorMinSec: 300,
  errorMaxSec: 3600,
}

function state(overrides: Partial<AccountStateRow> = {}): AccountStateRow {
  return {
    accountKey: "google:test@example.com",
    fingerprint: "previous",
    intervalSec: 600,
    unchangedStreak: 0,
    errorIntervalSec: 0,
    lastAttemptAt: new Date(NOW.getTime() - 600_000).toISOString(),
    lastSuccessAt: new Date(NOW.getTime() - 600_000).toISOString(),
    lastChangeAt: new Date(NOW.getTime() - 600_000).toISOString(),
    nextCheckAt: NOW.toISOString(),
    lastError: null,
    lastWarning: null,
    lastManualAt: null,
    lastDurationMs: 100,
    ...overrides,
  }
}

function result(quotas: Quota[], error: string | null = null): CollectResult {
  return {
    accountKey: "google:test@example.com",
    provider: "Google",
    label: "test@example.com",
    quotas,
    error,
    warning: null,
    durationMs: 120,
  }
}

function quota(
  remaining: number,
  resetAt: string | null = null,
  key = "gemini-weekly",
): Quota {
  return { key, label: "Gemini — Weekly", remaining, resetAt }
}

describe("detectQuotaChange", () => {
  it("ignores changes below the threshold", () => {
    expect(detectQuotaChange([quota(0.75)], [quota(0.749)], config)).toBe(false)
  })

  it("detects changes at the threshold", () => {
    expect(detectQuotaChange([quota(0.75)], [quota(0.745)], config)).toBe(true)
  })

  it("detects reset-time shifts", () => {
    const previous = quota(0.5, "2026-10-23T00:00:00.000Z")
    const current = quota(0.5, "2026-10-23T00:05:00.000Z")
    expect(detectQuotaChange([previous], [current], config)).toBe(true)
  })

  it("detects added and removed quotas", () => {
    expect(detectQuotaChange([quota(0.5)], [], config)).toBe(true)
    expect(
      detectQuotaChange([], [quota(0.5)], config),
    ).toBe(true)
  })

  it("ignores sliding reset windows", () => {
    const previousCheckedAt = new Date(NOW.getTime() - 10 * 60_000)
    const previousReset = new Date(previousCheckedAt.getTime() + 5 * 3600_000)
    const currentReset = new Date(NOW.getTime() + 5 * 3600_000)
    expect(
      detectQuotaChange(
        [quota(0.5, previousReset.toISOString())],
        [quota(0.5, currentReset.toISOString())],
        config,
        {
          previousCheckedAt: previousCheckedAt.toISOString(),
          currentCheckedAt: NOW.toISOString(),
        },
      ),
    ).toBe(false)
  })

  it("ignores fixed reset schedules", () => {
    const nextReset = new Date(NOW.getTime() + 3 * 24 * 3600_000).toISOString()
    expect(
      detectQuotaChange([quota(0.5, nextReset)], [quota(0.5, nextReset)], config, {
        previousCheckedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
        currentCheckedAt: NOW.toISOString(),
      }),
    ).toBe(false)
  })

  it("detects reset events or schedule extensions", () => {
    const previousReset = new Date(NOW.getTime() + 30 * 60_000).toISOString()
    const currentReset = new Date(NOW.getTime() + 5 * 3600_000).toISOString()
    expect(
      detectQuotaChange([quota(0.5, previousReset)], [quota(0.5, currentReset)], config, {
        previousCheckedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
        currentCheckedAt: NOW.toISOString(),
      }),
    ).toBe(true)
  })
})

describe("computeStateUpdate", () => {
  it("doubles the interval when nothing changed", () => {
    const update = computeStateUpdate({
      previous: state(),
      previousQuotas: [quota(0.75)],
      result: result([quota(0.75)]),
      now: NOW,
      config,
      random: () => 0.5,
    })

    expect(update.intervalSec).toBe(1200)
    expect(update.unchangedStreak).toBe(1)
    expect(update.lastError).toBeNull()
    expect(Date.parse(update.nextCheckAt)).toBe(NOW.getTime() + 1200_000)
  })

  it("does not reset the interval for a sliding reset window", () => {
    const previousCheckedAt = new Date(NOW.getTime() - 10 * 60_000)
    const update = computeStateUpdate({
      previous: state({
        intervalSec: 1200,
        unchangedStreak: 1,
        lastSuccessAt: previousCheckedAt.toISOString(),
      }),
      previousQuotas: [
        quota(0.5, new Date(previousCheckedAt.getTime() + 5 * 3600_000).toISOString()),
      ],
      result: result([
        quota(0.5, new Date(NOW.getTime() + 5 * 3600_000).toISOString()),
      ]),
      now: NOW,
      config,
      random: () => 0.5,
    })

    expect(update.intervalSec).toBe(2400)
    expect(update.unchangedStreak).toBe(2)
  })

  it("resets the interval when a quota changes", () => {
    const update = computeStateUpdate({
      previous: state({ intervalSec: 4800, unchangedStreak: 3 }),
      previousQuotas: [quota(0.75)],
      result: result([quota(0.74)]),
      now: NOW,
      config,
      random: () => 0.5,
    })

    expect(update.intervalSec).toBe(600)
    expect(update.unchangedStreak).toBe(0)
    expect(update.lastChangeAt).toBe(NOW.toISOString())
  })

  it("treats recovery from an error as a change", () => {
    const update = computeStateUpdate({
      previous: state({ lastError: "HTTP 500", errorIntervalSec: 600 }),
      previousQuotas: [quota(0.75)],
      result: result([quota(0.75)]),
      now: NOW,
      config,
      random: () => 0.5,
    })

    expect(update.intervalSec).toBe(600)
    expect(update.errorIntervalSec).toBe(0)
    expect(update.lastError).toBeNull()
  })

  it("schedules a check shortly after a known quota reset", () => {
    const resetAt = new Date(NOW.getTime() + 5 * 60_000).toISOString()
    const update = computeStateUpdate({
      previous: state({ intervalSec: 21_600, unchangedStreak: 8 }),
      previousQuotas: [quota(0.75, resetAt)],
      result: result([quota(0.75, resetAt)]),
      now: NOW,
      config,
      random: () => 0.5,
    })

    const next = Date.parse(update.nextCheckAt)
    expect(next).toBeGreaterThan(NOW.getTime() + 5 * 60_000)
    expect(next).toBeLessThan(NOW.getTime() + 10 * 60_000)
  })

  it("caps the interval at the maximum even with jitter", () => {
    const update = computeStateUpdate({
      previous: state({ intervalSec: 21_600, unchangedStreak: 8 }),
      previousQuotas: [quota(0.75)],
      result: result([quota(0.75)]),
      now: NOW,
      config,
      random: () => 0.99,
    })

    expect(update.intervalSec).toBe(21_600)
    expect(Date.parse(update.nextCheckAt) - NOW.getTime()).toBeLessThanOrEqual(
      21_600_000,
    )
  })

  it("uses exponential error backoff", () => {
    const first = computeStateUpdate({
      previous: state(),
      previousQuotas: [quota(0.75)],
      result: result([], "HTTP 500"),
      now: NOW,
      config,
      random: () => 0.5,
    })
    expect(first.errorIntervalSec).toBe(300)

    const second = computeStateUpdate({
      previous: state({ errorIntervalSec: first.errorIntervalSec }),
      previousQuotas: [quota(0.75)],
      result: result([], "HTTP 500"),
      now: NOW,
      config,
      random: () => 0.5,
    })
    expect(second.errorIntervalSec).toBe(600)
    expect(second.lastSuccessAt).toBe(state().lastSuccessAt)
  })

  it("carries credential warnings through successful checks", () => {
    const warned = computeStateUpdate({
      previous: state(),
      previousQuotas: [quota(0.75)],
      result: { ...result([quota(0.75)]), warning: "mount is read-only" },
      now: NOW,
      config,
      random: () => 0.5,
    })
    expect(warned.lastWarning).toBe("mount is read-only")

    const cleared = computeStateUpdate({
      previous: state({ lastWarning: "mount is read-only" }),
      previousQuotas: [quota(0.75)],
      result: result([quota(0.75)]),
      now: NOW,
      config,
      random: () => 0.5,
    })
    expect(cleared.lastWarning).toBeNull()
  })

  it("uses the maximum error interval for auth failures", () => {
    const update = computeStateUpdate({
      previous: state(),
      previousQuotas: [quota(0.75)],
      result: result([], "HTTP 401 unauthorized"),
      now: NOW,
      config,
      random: () => 0.5,
    })
    expect(update.errorIntervalSec).toBe(3600)
  })
})

describe("fingerprints and freshness", () => {
  it("is stable across quota ordering", () => {
    const a = fingerprintQuotas([quota(0.5), quota(0.7, null, "claude-weekly")])
    const b = fingerprintQuotas([quota(0.7, null, "claude-weekly"), quota(0.5)])
    expect(a).toBe(b)
  })

  it("computes due state", () => {
    expect(isDue(null, NOW)).toBe(true)
    expect(isDue(new Date(NOW.getTime() - 1).toISOString(), NOW)).toBe(true)
    expect(isDue(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe(false)
  })

  it("computes staleness", () => {
    expect(isStale(null, 21_600, NOW)).toBe(true)
    expect(
      isStale(new Date(NOW.getTime() - 21_601_000).toISOString(), 21_600, NOW),
    ).toBe(true)
    expect(
      isStale(new Date(NOW.getTime() - 21_599_000).toISOString(), 21_600, NOW),
    ).toBe(false)
  })
})
