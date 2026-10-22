import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/config.js"
import { UsageDatabase } from "../src/db.js"
import type { AccountRef, Quota } from "../src/domain.js"
import { registerMcp } from "../src/mcp.js"
import type { UsageScheduler } from "../src/scheduler.js"

const config = loadConfig({
  ...process.env,
  DATABASE_PATH: ":memory:",
  OPENCODE_CONFIG_DIR: "/nonexistent/opencode",
  CODEX_HOME: "/nonexistent/codex",
})

const reference: AccountRef = {
  accountKey: "google:test@example.com",
  provider: "Google",
  label: "test@example.com",
  collectorId: "antigravity",
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

function quota(key: string, label: string, remaining: number): Quota {
  return { key, label, remaining, resetAt: null }
}

async function buildApp(): Promise<{
  app: FastifyInstance
  url: string
  refreshCalls: Array<string[] | null>
}> {
  const db = new UsageDatabase(":memory:")
  const now = Date.now()
  db.upsertAccount(reference)
  db.ensureState(reference.accountKey, 600)
  db.insertImportedCheck({
    ref: reference,
    checkedAt: new Date(now - 3600_000).toISOString(),
    quotas: [
      quota("gemini-weekly", "Gemini — Weekly", 0.8),
      quota("gemini-5h", "Gemini — 5h", 1),
    ],
  })
  db.insertImportedCheck({
    ref: reference,
    checkedAt: new Date(now).toISOString(),
    quotas: [
      quota("gemini-weekly", "Gemini — Weekly", 0.75),
      quota("gemini-5h", "Gemini — 5h", 0.9),
    ],
  })

  const refreshCalls: Array<string[] | null> = []
  const scheduler = {
    isRefreshing: () => false,
    refresh: async (accountKeys: string[] | null) => {
      refreshCalls.push(accountKeys)
      return {
        refreshed: [
          {
            accountKey: reference.accountKey,
            provider: reference.provider,
            label: reference.label,
            quotas: [quota("gemini-weekly", "Gemini — Weekly", 0.7)],
            error: null,
            warning: null,
            durationMs: 12,
          },
        ],
        skipped: [],
      }
    },
  } as unknown as UsageScheduler

  const app = Fastify()
  registerMcp(app, { config, db, scheduler })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  if (!address || typeof address === "string") throw new Error("Missing test server address")
  cleanup.push(async () => {
    await app.close()
    db.close()
  })
  return { app, url: `http://127.0.0.1:${address.port}/mcp`, refreshCalls }
}

async function rpc(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; contentType: string | null; json: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    json: text ? JSON.parse(text) : null,
  }
}

async function initialize(url: string): Promise<void> {
  const result = await rpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    },
  })
  expect(result.status).toBe(200)
  expect(result.contentType).toContain("application/json")
  expect(result.json.result.serverInfo.name).toBe("ai-usage")
  await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" })
}

describe("MCP endpoint", () => {
  it("lists the three usage tools", async () => {
    const { url } = await buildApp()
    await initialize(url)
    const result = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" })

    expect(result.status).toBe(200)
    expect(result.json.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "refresh_usage",
      "usage_history",
      "usage_overview",
    ])
  })

  it("returns a compact overview and history summary", async () => {
    const { url } = await buildApp()
    await initialize(url)
    const overview = await rpc(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "usage_overview", arguments: {} },
    })
    const overviewPayload = JSON.parse(overview.json.result.content[0].text)
    expect(overviewPayload.summary.accounts).toBe(1)
    expect(overviewPayload.accounts[0].quotas).toHaveLength(2)
    expect(
      overviewPayload.accounts[0].quotas.find(
        (quota: { key: string }) => quota.key === "gemini-weekly",
      ).remainingPct,
    ).toBe(75)

    const history = await rpc(url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "usage_history", arguments: { hours: 2 } },
    })
    const historyPayload = JSON.parse(history.json.result.content[0].text)
    expect(historyPayload.seriesCount).toBe(2)
    const weekly = historyPayload.series.find(
      (series: { quotaKey: string }) => series.quotaKey === "gemini-weekly",
    )
    expect(weekly.firstPct).toBe(80)
    expect(weekly.lastPct).toBe(75)
    expect(weekly.changePp).toBe(-5)
  })

  it("refreshes the requested accounts and respects the scheduler", async () => {
    const { url, refreshCalls } = await buildApp()
    await initialize(url)
    const result = await rpc(url, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "refresh_usage",
        arguments: { accountKeys: [reference.accountKey] },
      },
    })
    const payload = JSON.parse(result.json.result.content[0].text)
    expect(refreshCalls).toEqual([[reference.accountKey]])
    expect(payload.refreshed[0].accountKey).toBe(reference.accountKey)
    expect(payload.refreshed[0].quotas[0].remainingPct).toBe(70)
  })

  it("rejects unsupported methods", async () => {
    const { url } = await buildApp()
    const response = await fetch(url)
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
    expect((await response.json()).error.code).toBe(-32000)
  })
})
