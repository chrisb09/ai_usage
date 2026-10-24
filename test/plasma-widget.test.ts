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
    buildSummary,
    buildRows,
    compactSummary,
    compactTooltip,
    windowSec,
    elapsedFraction,
    timeRemainingFraction,
    status,
    remainingColor,
    shortLabel
  }`,
)() as {
  buildSummary: (accounts: unknown[], serverTime: string) => any[]
  buildRows: (groups: unknown[]) => any[]
  compactSummary: (groups: unknown[]) => any[]
  compactTooltip: (series: unknown[]) => string
  windowSec: (quota: unknown) => number | null
  elapsedFraction: (quota: unknown, serverTime: string) => number
  timeRemainingFraction: (quota: unknown, serverTime: string) => number
  status: (remaining: number, elapsed: number) => string
  remainingColor: (remaining: number) => string
  shortLabel: (quota: unknown) => string
}

const now = "2026-10-24T08:00:00.000Z"

function quota(
  key: string,
  label: string,
  remaining: number,
  resetAt: string | null = null,
  windowSec: number | null = null,
  raw: Record<string, unknown> = {},
): Record<string, unknown> {
  return { key, label, remaining, resetAt, windowSec, raw }
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
  it("pools quota and time remaining by type across accounts", () => {
    const accounts = [
      account("google:a", "Google", "a@example.com", [
        quota("claude-weekly", "Claude — Weekly", 0.8, "2026-10-26T08:00:00Z", 604_800),
        quota("claude-5h", "Claude — 5h", 0.4, "2026-10-24T10:00:00Z", 18_000),
      ]),
      account("google:b", "Google", "b@example.com", [
        quota("claude-weekly", "Claude — Weekly", 0.2, "2026-10-29T08:00:00Z", 604_800),
        quota("claude-5h", "Claude — 5h", 0.6, "2026-10-24T12:00:00Z", 18_000),
      ]),
    ]

    const groups = usage.buildSummary(accounts, now)
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe("Google Claude")
    expect(groups[0].accountCount).toBe(2)
    expect(groups[0].windows).toHaveLength(2)

    const weekly = groups[0].windows.find((item: any) => item.label === "7d")
    expect(weekly.remaining).toBeCloseTo(0.5)
    expect(weekly.marker).toBeCloseTo(0.5)
    expect(weekly.elapsed).toBeCloseTo(0.5)
    expect(weekly.resetText).toBe("resets in 2d 0h")
    expect(weekly.paceText).toBe("on pace")
  })

  it("keeps Claude and Gemini separate and pools only known values", () => {
    const accounts = [
      account("google:a", "Google", "a@example.com", [
        quota("claude-weekly", "Claude — Weekly", 0.8),
        quota("gemini-weekly", "Gemini — Weekly", 0.9),
      ]),
      account("google:b", "Google", "b@example.com", [
        quota("claude-weekly", "Claude — Weekly", 0.2),
        quota("gemini-weekly", "Gemini — Weekly", -1),
      ], { active: false }),
      account("google:c", "Google", "c@example.com", [
        quota("claude-weekly", "Claude — Weekly", -1),
      ]),
    ]

    const groups = usage.buildSummary(accounts, now)
    expect(groups.map((group) => group.title)).toEqual(["Google Claude", "Google Gemini"])
    expect(groups[0].windows[0].remaining).toBeCloseTo(0.8)
    expect(groups[0].windows[0].availableCount).toBe(1)
    expect(groups[0].windows[0].matchCount).toBe(2)
    expect(usage.compactTooltip(usage.compactSummary(groups))).toContain("incomplete")
  })

  it("shows windows together in type rows without account rows", () => {
    const groups = usage.buildSummary([
      account("google:a", "Google", "a@example.com", [
        quota("claude-weekly", "Claude — Weekly", 0.5, null, 604_800),
        quota("claude-5h", "Claude — 5h", 0.7, null, 18_000),
      ], { lastError: "expired" }),
      account("codex:default", "Codex", "Codex", [
        quota("codex-weekly", "Codex — Weekly", 1, null, 604_800),
      ]),
    ], now)
    const rows = usage.buildRows(groups)

    expect(rows.map((row) => row.kind)).toEqual(["summary", "error", "summary"])
    expect(rows[0].group.windows.map((item: any) => item.label)).toEqual(["7d", "5h"])
    expect(rows[1].text).toBe("expired")
    expect(rows.some((row) => row.kind === "account")).toBe(false)
  })

  it("orders monthly, weekly, then short windows from left to right", () => {
    const groups = usage.buildSummary([
      account("go:default", "OpenCode Go", "Go", [
        quota("opencode-go-5h", "OpenCode Go — 5h", 0.5, null, 18_000),
        quota("opencode-go-weekly", "OpenCode Go — Weekly", 0.7, null, 604_800),
        quota("opencode-go-monthly", "OpenCode Go — Monthly", 0.9, null, 2_592_000),
      ]),
    ], now)

    expect(groups[0].windows.map((item: any) => item.label)).toEqual(["30d", "7d", "5h"])
  })

  it("uses one longest-window bar per type in the panel", () => {
    const groups = usage.buildSummary([
      account("codex:default", "Codex", "Codex", [
        quota("codex-5h", "Codex — 5h", 0.5, null, 18_000),
        quota("codex-weekly", "Codex — Weekly", 0.9, null, 604_800),
      ]),
      account("vnai:default", "VNAI Pro", "VNAI", [
        quota("vnai-pro", "VNAI Pro", 0.25, null, null, { balanceUsd: 2.5 }),
      ]),
    ], now)
    const compact = usage.compactSummary(groups)

    expect(compact.map((item) => item.label)).toEqual(["Codex", "VNAI Pro"])
    expect(compact.map((item) => item.remaining)).toEqual([0.9, 0.25])
  })

  it("uses a continuous red-orange-yellow-green remaining scale", () => {
    expect(usage.remainingColor(0)).toBe("#eb2a2a")
    expect(usage.remainingColor(0.25)).toBe("#eb8a2a")
    expect(usage.remainingColor(0.5)).toBe("#ebeb2a")
    expect(usage.remainingColor(1)).toBe("#2aeb2a")
    expect(usage.remainingColor(-1)).toBe("#8b949e")
  })

  it("falls back to labels for imported or older quota rows", () => {
    expect(usage.windowSec({ key: "claude-5h", label: "Claude — 5h" })).toBe(18_000)
    expect(usage.windowSec({ key: "claude-weekly", label: "Claude — Weekly" })).toBe(604_800)
    expect(usage.windowSec({ key: "opencode-go-monthly", label: "Monthly" })).toBe(2_592_000)
    expect(usage.windowSec({ key: "oneprovider", label: "OneProvider" })).toBeNull()
    expect(usage.status(0, 0.2)).toBe("critical")
    expect(usage.shortLabel({ key: "oneprovider", label: "OneProvider" })).toBe("OneProv")
  })
})
