import { useEffect, useMemo, useState } from "react"
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { getHistory } from "./api"
import type { AccountView, HistoryPoint, HistoryResponse } from "./types"
import { seriesColor } from "./format"
import { isApiKeyProvider, overviewPool, overviewQuotas, overviewWindow } from "./overview"

type RangeKey = "24h" | "7d" | "30d" | "all"

const ALL_PROVIDERS = "__all__"
const API_KEY_BALANCES = "__api_keys__"

const RANGES: Array<{ key: RangeKey; label: string; hours: number | null }> = [
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
  { key: "30d", label: "30 days", hours: 24 * 30 },
  { key: "all", label: "All", hours: null },
]

function rangeStart(range: RangeKey): string | undefined {
  const hours = RANGES.find((entry) => entry.key === range)?.hours
  if (!hours) return undefined
  return new Date(Date.now() - hours * 3600 * 1000).toISOString()
}

function axisTick(value: number, range: RangeKey): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  if (range === "24h") {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function providerColor(provider: string): string {
  switch (provider) {
    case "Google · Gemini":
      return "#89b4fa"
    case "Google · Claude":
      return "#fab387"
    case "OpenCode Go":
      return "#cba6f7"
    case "Codex":
      return "#a6e3a1"
    case "OneProvider":
      return "#f38ba8"
    case "VNAI Pro":
      return "#94e2d5"
    default:
      return "#f9e2af"
  }
}

interface ChartData {
  data: Array<Record<string, number | null>>
  series: string[]
  labels: Map<string, string>
  colors: Map<string, string>
  yMax: number
  aggregated: boolean
  balances: boolean
}

export function buildChart(
  history: HistoryResponse | null,
  accounts: AccountView[],
  selectedKey: string,
): ChartData {
  const points = history?.points ?? []
  const bucketMs = Math.max(1, history?.bucketSec ?? 300) * 1000
  const labels = new Map<string, string>()
  const colors = new Map<string, string>()
  const rows = new Map<number, Record<string, number | null>>()

  const balances = selectedKey === API_KEY_BALANCES
  if (selectedKey === ALL_PROVIDERS || balances) {
    const accountByKey = new Map(accounts.map((account) => [account.accountKey, account]))
    const bucketSeries = new Map<number, Map<string, HistoryPoint>>()
    const lastBucketBySeries = new Map<string, number>()
    const providers = new Set<string>()

    for (const point of points) {
      if (point.remaining === null || !Number.isFinite(point.remaining)) continue
      const time = Date.parse(point.checkedAt)
      const account = accountByKey.get(point.accountKey)
      if (!Number.isFinite(time) || !account) continue
      if (balances ? !isApiKeyProvider(account.provider) : !overviewWindow(point)) continue

      providers.add(overviewPool(account.provider, point))
      const bucket = Math.floor(time / bucketMs) * bucketMs
      const series = bucketSeries.get(bucket) ?? new Map()
      const key = `${point.accountKey}|${point.quotaKey}`
      const previous = series.get(key)
      if (!previous || point.checkedAt >= previous.checkedAt) series.set(key, point)
      lastBucketBySeries.set(key, Math.max(lastBucketBySeries.get(key) ?? bucket, bucket))
      bucketSeries.set(bucket, series)
    }

    const latest = new Map<string, HistoryPoint>()
    for (const [bucket, series] of [...bucketSeries.entries()].sort(([a], [b]) => a - b)) {
      for (const [key, point] of series) latest.set(key, point)
      const byAccount = new Map<string, HistoryPoint[]>()
      for (const [key, point] of latest) {
        const account = accountByKey.get(point.accountKey)!
        const stillConfigured = account.active && account.quotas.some((quota) => quota.key === point.quotaKey)
        // Carry each account's last reading across asynchronous checks. Historical
        // or retired quota series stop at their final observation.
        if (!stillConfigured && bucket > lastBucketBySeries.get(key)!) continue
        const list = byAccount.get(point.accountKey) ?? []
        list.push(point)
        byAccount.set(point.accountKey, list)
      }
      const row: Record<string, number | null> = { time: bucket }
      for (const [accountKey, quotas] of byAccount) {
        const provider = accountByKey.get(accountKey)!.provider
        for (const quota of balances ? quotas : overviewQuotas(quotas)) {
          const pool = overviewPool(provider, quota)
          row[pool] = (row[pool] ?? 0) + quota.remaining! * 100
        }
      }
      rows.set(bucket, row)
    }

    for (const provider of providers) {
      labels.set(provider, provider)
      colors.set(provider, providerColor(provider))
    }

    let max = 100
    for (const row of rows.values()) {
      for (const [key, value] of Object.entries(row)) {
        if (key !== "time" && typeof value === "number") {
          max = Math.max(max, value)
        }
      }
    }

    return {
      data: [...rows.values()].sort((a, b) => Number(a.time) - Number(b.time)),
      series: [...labels.keys()],
      labels,
      colors,
      yMax: Math.max(100, Math.ceil(max / 50) * 50),
      aggregated: true,
      balances,
    }
  }

  const selectedAccount = accounts.find((account) => account.accountKey === selectedKey)
  if (selectedAccount) {
    for (const quota of selectedAccount.quotas) {
      labels.set(quota.key, quota.label)
      colors.set(quota.key, seriesColor(labels.size - 1))
    }
  }

  for (const point of points) {
    if (point.remaining === null) continue
    const time = Date.parse(point.checkedAt)
    if (!Number.isFinite(time)) continue
    if (!labels.has(point.quotaKey)) {
      labels.set(point.quotaKey, point.label)
      colors.set(point.quotaKey, seriesColor(labels.size - 1))
    }
    const row = rows.get(time) ?? { time }
    row[point.quotaKey] = point.remaining * 100
    rows.set(time, row)
  }

  return {
    data: [...rows.values()].sort((a, b) => Number(a.time) - Number(b.time)),
    series: [...labels.keys()],
    labels,
    colors,
    yMax: 100,
    aggregated: false,
    balances: false,
  }
}

export function HistoryChart(props: { accounts: AccountView[] }) {
  const { accounts } = props
  const [selectedKey, setSelectedKey] = useState<string>(ALL_PROVIDERS)
  const [range, setRange] = useState<RangeKey>("7d")
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checksVersion = accounts.map((account) => account.lastAttemptAt ?? "").join("|")

  useEffect(() => {
    if (
      selectedKey !== ALL_PROVIDERS &&
      selectedKey !== API_KEY_BALANCES &&
      !accounts.some((account) => account.accountKey === selectedKey)
    ) {
      setSelectedKey(ALL_PROVIDERS)
    }
  }, [accounts, selectedKey])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    getHistory({
      accountKey: selectedKey === ALL_PROVIDERS || selectedKey === API_KEY_BALANCES ? undefined : selectedKey,
      from: rangeStart(range),
      to: new Date().toISOString(),
    })
      .then((result) => {
        if (!cancelled) setHistory(result)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedKey, range, checksVersion])

  const chart = useMemo(
    () => buildChart(history, accounts, selectedKey),
    [history, accounts, selectedKey],
  )

  return (
    <section className="panel history-panel" id="history" aria-labelledby="history-title">
      <div className="panel-head">
        <div>
          <h2 id="history-title">Usage history</h2>
          <p className="panel-subtitle">
            {chart.balances
              ? "Remaining API credit as a percentage of each key’s budget"
              : chart.aggregated
              ? "Weekly / monthly · separate Gemini & Claude pools"
              : "Remaining quota over time"}
            {history?.bucketSec
              ? ` · ${Math.round(history.bucketSec / 60)}m buckets`
              : ""}
          </p>
        </div>
        <div className="history-controls">
          <label className="select-label">
            <span className="sr-only">History view</span>
            <select
              value={selectedKey}
              onChange={(event) => setSelectedKey(event.target.value)}
            >
              <option value={ALL_PROVIDERS}>All providers</option>
              <option value={API_KEY_BALANCES}>API key balances</option>
              {accounts.map((account) => (
                <option key={account.accountKey} value={account.accountKey}>
                  {account.label} · {account.provider}
                  {account.active ? "" : " (not configured)"}
                </option>
              ))}
            </select>
          </label>
          <div className="range-buttons">
            {RANGES.map((entry) => (
              <button
                key={entry.key}
                className={`button button-small ${range === entry.key ? "button-active" : ""}`}
                aria-pressed={range === entry.key}
                onClick={() => setRange(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="card-error">{error}</div>}

      {loading && !history ? (
        <div className="history-empty">Loading history…</div>
      ) : chart.data.length === 0 ? (
        <div className="history-empty">
          No history yet. Data appears after the first successful check.
        </div>
      ) : (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chart.data} margin={{ top: 8, right: 18, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="#252e35" strokeDasharray="3 5" vertical={false} />
              <XAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value: number) => axisTick(value, range)}
                stroke="#53616c"
                axisLine={false}
                tickLine={false}
                tickMargin={12}
                tick={{ fill: "#82909b", fontSize: 11 }}
                minTickGap={40}
              />
              <YAxis
                domain={[0, chart.yMax]}
                tickFormatter={(value: number) => `${value}%`}
                stroke="#53616c"
                axisLine={false}
                tickLine={false}
                tick={{ fill: "#82909b", fontSize: 11 }}
                width={55}
              />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                formatter={(value, name) => [
                  `${Number(value).toFixed(1)}%`,
                  chart.labels.get(String(name)) ?? String(name),
                ]}
                contentStyle={{
                  background: "#182128",
                  border: "1px solid #34414b",
                  borderRadius: 8,
                  color: "#edf2f5",
                  fontSize: 12,
                }}
                labelStyle={{ color: "#a1aeb8", marginBottom: 8 }}
              />
              <Legend
                formatter={(value) => chart.labels.get(String(value)) ?? String(value)}
                iconType="circle"
                iconSize={7}
                wrapperStyle={{ color: "#a1aeb8", fontSize: 12, paddingTop: 16 }}
              />
              {chart.series.map((key) => (
                <Line
                  key={key}
                  type="stepAfter"
                  dataKey={key}
                  stroke={chart.colors.get(key) ?? seriesColor(0)}
                  strokeWidth={2.2}
                  dot={chart.data.filter((row) => typeof row[key] === "number").length === 1 ? { r: 3, strokeWidth: 0 } : false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "#131b20" }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  )
}
