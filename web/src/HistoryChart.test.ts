import { describe, expect, it } from "vitest"
import { buildChart } from "./HistoryChart"
import type { AccountView, HistoryPoint, HistoryResponse } from "./types"

function account(accountKey: string, provider: string): AccountView {
  return {
    accountKey,
    provider,
    label: accountKey,
    active: true,
    quotas: [],
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastChangeAt: null,
    nextCheckAt: null,
    intervalSec: 600,
    unchangedStreak: 0,
    errorIntervalSec: 300,
    lastError: null,
    lastWarning: null,
    lastDurationMs: null,
    stale: false,
    refreshing: false,
  }
}

function point(
  accountKey: string,
  quotaKey: string,
  remaining: number | null,
  checkedAt = "2026-10-22T12:00:00.000Z",
): HistoryPoint {
  return { accountKey, quotaKey, label: quotaKey, remaining, checkedAt, resetAt: null }
}

function history(points: HistoryPoint[]): HistoryResponse {
  return { points, bucketSec: 600, from: null, to: null }
}

describe("history chart data", () => {
  it("produces finite long-term provider totals without adding 5h allowances", () => {
    const chart = buildChart(
      history([
        point("google:a", "claude-weekly", 0.75),
        point("google:b", "claude-weekly", 0.5),
        point("codex:default", "5h", 1),
        point("codex:default", "weekly", 0.53),
        point("google:a", "claude-weekly", 0, "2026-10-22T12:10:00.000Z"),
      ]),
      [account("google:a", "Google"), account("google:b", "Google"), account("codex:default", "Codex")],
      "__all__",
    )

    expect(chart.series).toEqual(["Google · Claude", "Codex"])
    expect(chart.data).toEqual([
      { time: Date.parse("2026-10-22T12:00:00.000Z"), "Google · Claude": 125, Codex: 53 },
      { time: Date.parse("2026-10-22T12:10:00.000Z"), "Google · Claude": 0 },
    ])
    expect(chart.yMax).toBe(150)
    expect(chart.data.every((row) => Object.values(row).every(Number.isFinite))).toBe(true)
  })

  it("uses the latest observation per quota within a bucket and skips unknown values", () => {
    const chart = buildChart(
      history([
        point("codex:default", "weekly", 0.9),
        point("codex:default", "weekly", 0.8, "2026-10-22T12:05:00.000Z"),
        point("codex:default", "5h", null),
      ]),
      [account("codex:default", "Codex")],
      "__all__",
    )

    expect(chart.data).toEqual([
      { time: Date.parse("2026-10-22T12:00:00.000Z"), Codex: 80 },
    ])
  })

  it("keeps account totals stable when scheduled checks land in different buckets", () => {
    const a = account("google:a", "Google")
    const b = account("google:b", "Google")
    for (const entry of [a, b]) entry.quotas = [{ key: "claude-weekly", label: "Claude — Weekly", remaining: 0.5, resetAt: null }]
    const chart = buildChart(history([
      point(a.accountKey, "claude-weekly", 0.8),
      point(b.accountKey, "claude-weekly", 0.7),
      point(a.accountKey, "claude-weekly", 0.5, "2026-10-22T12:10:00.000Z"),
      point(b.accountKey, "claude-weekly", 0.5, "2026-10-22T12:20:00.000Z"),
    ]), [a, b], "__all__")
    expect(chart.data.map((row) => row["Google · Claude"])).toEqual([150, 120, 100])
  })

  it("prefers the monthly plan to its weekly sublimit in overview", () => {
    const chart = buildChart(history([
      point("go", "5h", 1),
      point("go", "weekly", 0.8),
      point("go", "monthly", 0.4),
    ]), [account("go", "OpenCode Go")], "__all__")
    expect(chart.data[0]?.["OpenCode Go"]).toBe(40)
  })

  it("keeps short windows available in the individual account history", () => {
    const chart = buildChart(history([
      point("codex", "5h", 0.9),
      point("codex", "weekly", 0.4),
    ]), [account("codex", "Codex")], "codex")
    expect(chart.data[0]).toMatchObject({ "5h": 90, weekly: 40 })
  })

  it("keeps Google's Gemini and Claude pools separate across accounts", () => {
    const chart = buildChart(history([
      point("google:a", "gemini-weekly", 0.95),
      point("google:a", "claude-weekly", 0.8),
      point("google:a", "gemini-5h", 1),
      point("google:a", "claude-5h", 0.6),
      point("google:b", "gemini-weekly", 0.97),
      point("google:b", "claude-weekly", 0.99),
    ]), [account("google:a", "Google"), account("google:b", "Google")], "__all__")
    expect(chart.series).toEqual(["Google · Gemini", "Google · Claude"])
    expect(chart.data[0]).toMatchObject({ "Google · Gemini": 192, "Google · Claude": 179 })
  })

  it("tracks API credit separately from weekly/monthly overview limits", () => {
    const points = history([
      point("oneprovider:default", "oneprovider", 0.18),
      point("vnai-pro:default", "vnai-pro", 0.0044),
      point("codex:default", "codex-weekly", 0.52),
    ])
    const accounts = [account("oneprovider:default", "OneProvider"), account("vnai-pro:default", "VNAI Pro"), account("codex:default", "Codex")]
    const balances = buildChart(points, accounts, "__api_keys__")
    expect(balances.series).toEqual(["OneProvider", "VNAI Pro"])
    expect(balances.data[0]?.OneProvider).toBe(18)
    expect(balances.data[0]?.["VNAI Pro"]).toBeCloseTo(0.44)
    expect(balances.balances).toBe(true)
    expect(buildChart(points, accounts, "__all__").series).toEqual(["Codex"])
  })
})
