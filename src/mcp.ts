import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppConfig } from "./config.js"
import type { UsageDatabase } from "./db.js"
import type { Quota } from "./domain.js"
import { isStale } from "./policy.js"
import type { UsageScheduler } from "./scheduler.js"

const VERSION = "0.1.0"
const LOGIN_ERROR = /expired|unauthorized|forbidden|\b401\b|\b403\b|missing .*(cookie|token)|codex login/i

interface McpDeps {
  config: AppConfig
  db: UsageDatabase
  scheduler: UsageScheduler
}

function percent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.round(value * 1000) / 10
}

function roundPp(value: number): number {
  return Math.round(value * 10) / 10
}

function compactQuota(quota: Quota): Record<string, unknown> {
  const result: Record<string, unknown> = {
    key: quota.key,
    label: quota.label,
    remainingPct: percent(quota.remaining),
    resetAt: quota.resetAt,
  }
  const balance = quota.raw?.balanceUsd
  const budget = quota.raw?.quotaUsd
  if (typeof balance === "number" && Number.isFinite(balance)) result.balanceUsd = balance
  if (typeof budget === "number" && Number.isFinite(budget)) result.budgetUsd = budget
  if (typeof quota.raw?.expiresAt === "string") result.expiresAt = quota.raw.expiresAt
  return result
}

export function overviewPayload(
  deps: McpDeps,
  args: { includeInactive?: boolean; provider?: string } = {},
): Record<string, unknown> {
  const now = new Date()
  const views = deps.db.buildViews({
    refreshing: (accountKey) => deps.scheduler.isRefreshing(accountKey),
    isStale: (lastSuccessAt) =>
      isStale(lastSuccessAt, deps.config.policy.maxIntervalSec, now),
  })
  const provider = args.provider?.toLowerCase()
  const selected = views.filter(
    (view) =>
      (args.includeInactive || view.active) &&
      (!provider || view.provider.toLowerCase() === provider),
  )

  return {
    generatedAt: now.toISOString(),
    summary: {
      accounts: selected.length,
      errors: selected.filter((view) => view.lastError).length,
      needsLogin: selected.filter((view) => LOGIN_ERROR.test(view.lastError ?? "")).length,
      stale: selected.filter((view) => view.stale).length,
      refreshing: selected.filter((view) => view.refreshing).length,
    },
    accounts: selected.map((view) => ({
      accountKey: view.accountKey,
      provider: view.provider,
      label: view.label,
      active: view.active,
      state: view.lastError
        ? "error"
        : view.stale
          ? "stale"
          : view.refreshing
            ? "refreshing"
            : "ok",
      lastSuccessAt: view.lastSuccessAt,
      nextCheckAt: view.nextCheckAt,
      lastError: view.lastError,
      lastWarning: view.lastWarning,
      quotas: view.quotas.map(compactQuota),
    })),
  }
}

export function historySummary(
  deps: McpDeps,
  args: {
    accountKey?: string
    quotaKey?: string
    hours?: number
  } = {},
): Record<string, unknown> {
  const hours = Math.min(Math.max(Math.round(args.hours ?? 24), 1), 720)
  const to = new Date()
  const from = new Date(to.getTime() - hours * 3600 * 1000)
  const bucketSec = Math.max(300, Math.ceil((hours * 3600) / 48 / 300) * 300)
  const points = deps.db.getHistory({
    accountKey: args.accountKey,
    quotaKey: args.quotaKey,
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSec,
    limit: 50_000,
  })
  const accounts = new Map(deps.db.getAccounts().map((account) => [account.account_key, account]))
  const groups = new Map<string, typeof points>()

  for (const point of points) {
    if (point.remaining === null || !Number.isFinite(point.remaining)) continue
    const key = `${point.accountKey}\u0000${point.quotaKey}`
    const series = groups.get(key) ?? []
    series.push(point)
    groups.set(key, series)
  }

  const allSeries = [...groups.values()]
    .map((series) => {
      const first = series[0]!
      const last = series[series.length - 1]!
      const values = series.map((point) => point.remaining! * 100)
      const account = accounts.get(first.accountKey)
      return {
        accountKey: first.accountKey,
        provider: account?.provider ?? null,
        label: account?.label ?? first.accountKey,
        quotaKey: first.quotaKey,
        quotaLabel: last.label,
        points: series.length,
        firstAt: first.checkedAt,
        lastAt: last.checkedAt,
        firstPct: percent(first.remaining),
        lastPct: percent(last.remaining),
        changePp: roundPp((last.remaining! - first.remaining!) * 100),
        minPct: roundPp(Math.min(...values)),
        maxPct: roundPp(Math.max(...values)),
        resetAt: last.resetAt,
      }
    })
    .sort(
      (a, b) =>
        a.accountKey.localeCompare(b.accountKey) || a.quotaKey.localeCompare(b.quotaKey),
    )

  const maxSeries = 50
  return {
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      hours,
      bucketSec,
    },
    seriesCount: allSeries.length,
    truncated: allSeries.length > maxSeries,
    series: allSeries.slice(0, maxSeries),
  }
}

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] }
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "ai-usage", version: VERSION },
    {
      instructions:
        "Read the self-hosted AI usage dashboard. Prefer usage_overview for current quota and credit status. Use usage_history for trends. Only call refresh_usage when the user explicitly asks to refresh, because it contacts providers and observes a per-account cooldown.",
    },
  )

  server.registerTool(
    "usage_overview",
    {
      title: "AI usage overview",
      description:
        "Current provider accounts with quota percentages, reset times, API credit balances, errors, and next check times. Cheapest source for current status.",
      inputSchema: {
        includeInactive: z
          .boolean()
          .optional()
          .describe("Include accounts that exist only in imported history (default false)"),
        provider: z
          .string()
          .optional()
          .describe("Exact provider name filter, e.g. Google, Codex, OneProvider"),
      },
    },
    async ({ includeInactive, provider }) =>
      textResult(overviewPayload(deps, { includeInactive, provider })),
  )

  server.registerTool(
    "usage_history",
    {
      title: "AI usage history summary",
      description:
        "Compact trend summary per account and quota window. Returns first/last percentages, change in percentage points, min/max, and reset time rather than raw points.",
      inputSchema: {
        accountKey: z
          .string()
          .optional()
          .describe("Optional account key, e.g. codex:default or google:user@example.com"),
        quotaKey: z
          .string()
          .optional()
          .describe("Optional quota key from usage_overview, e.g. codex-weekly"),
        hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe("Lookback window in hours (default 24, max 720)"),
      },
    },
    async ({ accountKey, quotaKey, hours }) =>
      textResult(historySummary(deps, { accountKey, quotaKey, hours })),
  )

  server.registerTool(
    "refresh_usage",
    {
      title: "Refresh AI usage",
      description:
        "Force provider checks and wait for results. Omit accountKeys to check every account. Same manual cooldown as the dashboard (default 60s per account); use only when asked.",
      inputSchema: {
        accountKeys: z
          .array(z.string().min(1))
          .max(100)
          .optional()
          .describe("Account keys to refresh; omit to refresh all accounts"),
      },
    },
    async ({ accountKeys }) => {
      const summary = await deps.scheduler.refresh(
        accountKeys && accountKeys.length > 0 ? accountKeys : null,
        "manual",
      )
      return textResult({
        refreshed: summary.refreshed.map((result) => ({
          accountKey: result.accountKey,
          provider: result.provider,
          label: result.label,
          error: result.error,
          warning: result.warning,
          durationMs: result.durationMs,
          quotas: result.quotas.map(compactQuota),
        })),
        skipped: summary.skipped,
      })
    },
  )

  return server
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post("/mcp", async (request, reply) => {
    reply.hijack()
    const raw = reply.raw
    const server = createMcpServer(deps)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    }
    raw.once("close", close)

    try {
      await server.connect(transport)
      await transport.handleRequest(request.raw, raw, request.body)
    } catch (error) {
      app.log.error({ error }, "MCP request failed")
      if (!raw.headersSent) {
        raw.writeHead(500, { "content-type": "application/json" })
        raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Internal server error" },
          }),
        )
      } else if (!raw.writableEnded) {
        raw.end()
      }
    } finally {
      if (raw.writableEnded) close()
    }
  })

  app.get("/mcp", (_request, reply) => {
    reply.header("allow", "POST")
    return reply.code(405).send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    })
  })

  app.delete("/mcp", (_request, reply) => {
    reply.header("allow", "POST")
    return reply.code(405).send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    })
  })
}
