import Fastify from "fastify"
import rateLimit from "@fastify/rate-limit"
import { afterEach, describe, expect, it } from "vitest"
import { registerApi } from "../src/api.js"
import { loadConfig } from "../src/config.js"
import { UsageDatabase } from "../src/db.js"
import type { AccountRef } from "../src/domain.js"
import type { UsageScheduler } from "../src/scheduler.js"

const config = loadConfig({
  ...process.env,
  DATABASE_PATH: ":memory:",
  OPENCODE_CONFIG_DIR: "/nonexistent/opencode",
  CODEX_HOME: "/nonexistent/codex",
})

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.()
  }
})

async function buildTestApp() {
  const db = new UsageDatabase(":memory:")
  const ref: AccountRef = {
    accountKey: "google:test@example.com",
    provider: "Google",
    label: "test@example.com",
    collectorId: "antigravity",
  }

  db.upsertAccount(ref)
  db.ensureState(ref.accountKey, 600)
  db.insertImportedCheck({
    ref,
    checkedAt: "2026-10-01T00:00:00.000Z",
    quotas: [
      {
        key: "gemini-weekly",
        label: "Gemini — Weekly",
        remaining: 0.75,
        resetAt: null,
      },
    ],
  })

  const scheduler = {
    isRefreshing: () => false,
    getLastTickAt: () => "2026-10-22T12:00:00.000Z",
    isTicking: () => false,
    getDiscoveredAccountKeys: () => [ref.accountKey],
    triggerDue: async () => undefined,
    refresh: async () => ({
      refreshed: [],
      skipped: [{ accountKey: ref.accountKey, reason: "Manual refresh cooldown" }],
    }),
  } as unknown as UsageScheduler

  const app = Fastify()
  await app.register(rateLimit, { global: false })
  registerApi(app, { config, db, scheduler })
  cleanup.push(async () => {
    await app.close()
    db.close()
  })

  return { app, ref }
}

describe("HTTP API", () => {
  it("returns the current usage snapshot", async () => {
    const { app, ref } = await buildTestApp()
    const response = await app.inject({ method: "GET", url: "/api/usage" })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.accounts).toHaveLength(1)
    expect(body.accounts[0].accountKey).toBe(ref.accountKey)
    expect(body.accounts[0].active).toBe(true)
    expect(body.accounts[0].quotas[0].remaining).toBeCloseTo(0.75)
    expect(body.policy.minIntervalSec).toBe(600)
  })

  it("returns history with a bucket", async () => {
    const { app, ref } = await buildTestApp()
    const response = await app.inject({
      method: "GET",
      url: `/api/history?accountKey=${encodeURIComponent(ref.accountKey)}&from=2026-09-01T00:00:00Z`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.points).toHaveLength(1)
    expect(body.points[0].remaining).toBeCloseTo(0.75)
    expect(body.bucketSec).toBeGreaterThan(0)
  })

  it("reports manual refresh skips", async () => {
    const { app, ref } = await buildTestApp()
    const response = await app.inject({
      method: "POST",
      url: "/api/refresh",
      payload: { accountKeys: [ref.accountKey] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().skipped).toHaveLength(1)
  })

  it("serves health and meta", async () => {
    const { app } = await buildTestApp()
    const health = await app.inject({ method: "GET", url: "/api/health" })
    const meta = await app.inject({ method: "GET", url: "/api/meta" })

    expect(health.statusCode).toBe(200)
    expect(health.json().counts.accounts).toBe(1)
    expect(meta.statusCode).toBe(200)
    expect(meta.json().policy.maxIntervalSec).toBe(21_600)
  })

  it("rejects invalid history dates", async () => {
    const { app } = await buildTestApp()
    const response = await app.inject({
      method: "GET",
      url: "/api/history?from=not-a-date",
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("invalid_request")
  })

  it("serves redacted public usage overview", async () => {
    const { app, ref } = await buildTestApp()
    const response = await app.inject({ method: "GET", url: "/api/public/usage" })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.isPublic).toBe(true)
    expect(body.accounts).toHaveLength(1)

    const account = body.accounts[0]
    expect(account.label).toBe("te**@example.com")
    expect(account.accountKey).not.toBe(ref.accountKey)
    expect(account.accountKey).not.toContain("test@example.com")
    expect(account.accountKey.startsWith("google:")).toBe(true)
    expect(account.quotas[0].remaining).toBeCloseTo(0.75)
  })

  it("serves redacted public history with public keys", async () => {
    const { app } = await buildTestApp()
    const usageRes = await app.inject({ method: "GET", url: "/api/public/usage" })
    const publicKey = usageRes.json().accounts[0].accountKey

    const response = await app.inject({
      method: "GET",
      url: `/api/public/history?accountKey=${encodeURIComponent(publicKey)}&from=2026-09-01T00:00:00Z`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.points).toHaveLength(1)
    expect(body.points[0].accountKey).toBe(publicKey)
    expect(body.points[0].remaining).toBeCloseTo(0.75)
  })
})
