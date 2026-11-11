import Fastify from "fastify"
import rateLimit from "@fastify/rate-limit"
import { afterEach, describe, expect, it } from "vitest"
import { registerApi } from "../src/api.js"
import { loadConfig } from "../src/config.js"
import { UsageDatabase } from "../src/db.js"
import { overviewPayload } from "../src/mcp.js"
import { UsageScheduler } from "../src/scheduler.js"

const secret = "test-ingest-token-that-is-long-enough"
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.() })

async function fixture(enabled = true) {
  const config = loadConfig({ DATABASE_PATH: ":memory:", ...(enabled ? { SAIA_INGEST_TOKEN: secret } : {}) })
  const db = new UsageDatabase(":memory:")
  const scheduler = {
    isRefreshing: () => false, getDiscoveredAccountKeys: () => [],
    getLastTickAt: () => null, isTicking: () => false, triggerDue: async () => undefined,
  } as unknown as UsageScheduler
  const app = Fastify()
  await app.register(rateLimit, { global: false })
  registerApi(app, { config, db, scheduler })
  cleanup.push(async () => { await app.close(); db.close() })
  return { app, db, config, scheduler }
}

const payload = (observedAt: string) => ({
  observedAt,
  windows: [
    { window: "10s", limit: 10, remaining: 9 },
    { window: "hour", limit: 400, remaining: 399 },
    { window: "day", limit: 800, remaining: 799 },
  ],
})

describe("SAIA passive observations", () => {
  it("requires a configured dedicated token and does not expose it", async () => {
    const f = await fixture()
    const send = (token?: string) => f.app.inject({ method: "POST", url: "/api/saia/observations", headers: token ? { "x-ai-usage-token": token } : {}, payload: payload(new Date().toISOString()) })
    expect((await send()).statusCode).toBe(401)
    expect((await send("wrong")).statusCode).toBe(401)
    const response = await send(secret)
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: true })
    expect(JSON.stringify(f.db.buildViews({ refreshing: () => false, isStale: () => false }))).not.toContain(secret)
    const disabled = await fixture(false)
    expect((await disabled.app.inject({ method: "POST", url: "/api/saia/observations", headers: { "x-ai-usage-token": secret }, payload: payload(new Date().toISOString()) })).statusCode).toBe(404)
  })

  it("validates counts, windows, timestamps and unexpected fields", async () => {
    const { app } = await fixture()
    const now = new Date(Date.now() - 1000).toISOString()
    for (const bad of [
      { ...payload(now), apiKey: "do-not-store" },
      { ...payload(now), windows: [{ window: "day", limit: 0, remaining: 0 }] },
      { ...payload(now), windows: [{ window: "day", limit: 3, remaining: 4 }] },
      { ...payload(now), windows: [{ window: "day", limit: 3, remaining: -1 }] },
      { ...payload(now), windows: [{ window: "day", limit: 3, remaining: 1 }, { window: "day", limit: 3, remaining: 1 }] },
      { ...payload(now), windows: [] },
      { ...payload(now), observedAt: "not-a-date" },
      { ...payload(now), observedAt: new Date(Date.now() + 60_000).toISOString() },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/saia/observations", headers: { "x-ai-usage-token": secret }, payload: bad })
      expect(response.statusCode).toBe(400)
      expect(response.body).not.toContain("do-not-store")
    }
  })

  it("stores newer observations, omits missing windows, stays active and exposes counts", async () => {
    const { app, db, config, scheduler } = await fixture()
    const now = Date.now()
    const send = (body: unknown) => app.inject({ method: "POST", url: "/api/saia/observations", headers: { "x-ai-usage-token": secret, authorization: "Basic cHJveHk=" }, payload: body })
    const older = new Date(now - 3000).toISOString(), newer = new Date(now - 2000).toISOString()
    expect((await send(payload(older))).json().accepted).toBe(true)
    expect((await send({ observedAt: newer, windows: [{ window: "day", limit: 800, remaining: 500 }] })).json().accepted).toBe(true)
    expect((await send(payload(older))).json().accepted).toBe(false)
    expect((await send(payload(newer))).json().accepted).toBe(false)
    db.deactivateAccountsExcept(["saia:default", "other:default"])
    const view = db.buildViews({ refreshing: () => false, isStale: () => false })[0]!
    expect(view.active).toBe(true)
    expect(view.nextCheckAt).toBeNull()
    expect(view.lastSuccessAt).toBe(newer)
    expect(view.quotas).toHaveLength(1)
    expect(view.quotas[0]).toMatchObject({ key: "saia-day", remaining: 0.625, resetAt: null, raw: { requestLimit: 800, requestsRemaining: 500 } })
    const overview = overviewPayload({ config, db, scheduler }) as any
    expect(overview.accounts[0].quotas[0]).toMatchObject({ requestLimit: 800, requestsRemaining: 500 })
    expect(db.getHistory({ accountKey: "saia:default", quotaKey: "saia-day" })).toHaveLength(2)
    db.insertImportedCheck({ ref: { accountKey: "saia:default", provider: "SAIA", label: "SAIA", collectorId: "" }, checkedAt: older, quotas: [{ key: "old-import", label: "Old", remaining: 0, resetAt: null }] })
    expect(db.getLatestQuotasForAll().get("saia:default")?.[0]?.key).toBe("saia-day")
  })

  it("keeps push accounts active only while ingestion is enabled during scheduler sync", async () => {
    const f = await fixture()
    await f.app.inject({ method: "POST", url: "/api/saia/observations", headers: { "x-ai-usage-token": secret }, payload: payload(new Date(Date.now() - 1000).toISOString()) })
    const env = { OPENCODE_CONFIG_DIR: "/nonexistent/ai-usage-opencode", OPENCODE_AUTH_PATH: "/nonexistent/ai-usage-auth", CODEX_HOME: "/nonexistent/ai-usage-codex" }
    const enabled = new UsageScheduler(f.db, loadConfig({ ...env, SAIA_INGEST_TOKEN: secret }), f.app.log)
    const result = await enabled.refresh(["saia:default"], "manual")
    expect(result.refreshed).toHaveLength(0)
    expect(f.db.getAccount("saia:default")?.active).toBe(1)
    const disabled = new UsageScheduler(f.db, loadConfig(env), f.app.log)
    await disabled.refresh(["saia:default"], "manual")
    expect(f.db.getAccount("saia:default")?.active).toBe(0)
  })

  it("accepts fully remaining calendar windows without guessing reset or duration", async () => {
    const { app, db } = await fixture()
    const response = await app.inject({ method: "POST", url: "/api/saia/observations", headers: { "x-ai-usage-token": secret }, payload: { observedAt: new Date(Date.now() + 10_000).toISOString(), windows: [{ window: "month", limit: 3000, remaining: 3000 }] } })
    expect(response.statusCode).toBe(202)
    const view = db.buildViews({ refreshing: () => false, isStale: () => false })[0]!
    expect(Date.parse(view.lastSuccessAt!)).toBeLessThanOrEqual(Date.now())
    expect(view.quotas[0]).toMatchObject({ remaining: 1, resetAt: null, windowSec: null })
  })
})
