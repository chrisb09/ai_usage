import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  resolve("integrations/plasma5/ai-usage/contents/code/usage.js"),
  "utf8",
).replace(/^\.pragma library\s*/, "")

const usage = new Function(
  `${source}
  return {
    selectSeries,
    buildSections,
    buildRows,
    windowSec,
    elapsedFraction,
    timeRemainingFraction,
    status,
    shortLabel
  }`,
)() as {
  selectSeries: (accounts: unknown[], selectors: string, serverTime: string) => any[]
  buildSections: (accounts: unknown[]) => any[]
  buildRows: (sections: unknown[]) => any[]
  windowSec: (quota: unknown) => number | null
  elapsedFraction: (quota: unknown, serverTime: string) => number
  timeRemainingFraction: (quota: unknown, serverTime: string) => number
  status: (remaining: number, elapsed: number) => string
  shortLabel: (quota: unknown) => string
}

const now = "2026-10-24T08:00:00.000Z"

function quota(
  key: string,
  label: string,
  remaining: number,
  resetAt: string | null = null,
  windowSec: number | null = null,
): Record<string, unknown> {
  return { key, label, remaining, resetAt, windowSec }
}

function account(
  accountKey: string,
  provider: string,
  label: string,
  quotas: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    accountKey,
    provider,
    label,
    active: true,
    lastError: null,
    lastWarning: null,
    stale: false,
    refreshing: false,
    quotas,
    ...extra,
  }
}

describe("Plasma widget data helpers", () => {
  it("selects the worst matching account and normalizes provider names", () => {
    const accounts = [
      account("google:a", "Google", "a@example.com", [
        quota("claude-weekly", "Claude — Weekly", 0.8, "2026-10-29T16:00:00Z", 604_800),
      ]),
      account("google:b", "Google", "b@example.com", [
        quota("claude-weekly", "Claude — Weekly", 0.2, "2026-10-29T16:00:00Z", 604_800),
      ]),
      account("opencode-go:default", "OpenCode Go", "Go", [
        quota("opencode-go-monthly", "OpenCode Go — Monthly", 0.4, "2026-10-27T00:00:00Z", 2_592_000),
      ]),
      account("vnai-pro:default", "VNAI Pro", "VNAI", [
        quota("vnai-pro", "VNAI Pro", 0.05),
      ]),
    ]

    const series = usage.selectSeries(
      accounts,
      "google:claude-weekly,opencode-go:opencode-go-monthly,vnai-pro:vnai-pro,unknown:missing",
      now,
    )

    expect(series[0].label).toBe("Claude")
    expect(series[0].remaining).toBeCloseTo(0.2)
    expect(series[0].matchCount).toBe(2)
    expect(series[0].accountLabel).toBe("b@example.com")
    expect(series[1].available).toBe(true)
    expect(series[2].available).toBe(true)
    expect(series[3].available).toBe(false)
    expect(series[3].label).toBe("missing")
  })

  it("puts the time marker at the remaining part of the window", () => {
    const item = quota(
      "claude-weekly",
      "Claude — Weekly",
      0.6,
      "2026-10-29T16:00:00Z",
      604_800,
    )
    const elapsed = usage.elapsedFraction(item, now)
    const marker = usage.timeRemainingFraction(item, now)

    expect(elapsed).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1)
    expect(marker).toBeCloseTo(1 - elapsed)
    expect(usage.status(0.6, elapsed)).toBe("warning")
    expect(usage.status(1, 0.2)).toBe("good")
    expect(usage.status(0, 0.2)).toBe("critical")
  })

  it("falls back to labels for imported or older quota rows", () => {
    expect(usage.windowSec({ key: "claude-5h", label: "Claude — 5h" })).toBe(18_000)
    expect(usage.windowSec({ key: "claude-weekly", label: "Claude — Weekly" })).toBe(604_800)
    expect(usage.windowSec({ key: "opencode-go-monthly", label: "Monthly" })).toBe(2_592_000)
    expect(usage.windowSec({ key: "oneprovider", label: "OneProvider" })).toBeNull()
    expect(usage.shortLabel({ key: "oneprovider", label: "OneProvider" })).toBe("OneProv")
  })

  it("flattens sections into ordered rows for the popup list", () => {
    const accounts = [
      account("google:a", "Google", "a@example.com", [
        quota("gemini-weekly", "Gemini — Weekly", 0.9, "2026-10-30T00:00:00Z", 604_800),
        quota("claude-weekly", "Claude — Weekly", 0.4, "2026-10-29T00:00:00Z", 604_800),
      ], { lastError: "expired" }),
      account("codex:default", "Codex", "Codex", [
        quota("codex-weekly", "Codex — Weekly", 1, "2026-10-31T00:00:00Z", 604_800),
      ]),
    ]

    const sections = usage.buildSections(accounts)
    const rows = usage.buildRows(sections)

    expect(sections.map((section) => section.title)).toEqual(["Google", "Codex"])
    expect(rows[0]).toMatchObject({ kind: "section", title: "Google" })
    expect(rows[1]).toMatchObject({ kind: "account", account: { label: "a@example.com" } })
    expect(rows[2]).toMatchObject({ kind: "error", text: "expired" })
    expect(rows[3]).toMatchObject({ kind: "quota", quota: { key: "claude-weekly" } })
    expect(rows[4]).toMatchObject({ kind: "quota", quota: { key: "gemini-weekly" } })
    expect(rows[rows.length - 1]).toMatchObject({ kind: "quota", quota: { key: "codex-weekly" } })
  })
})
