import Fastify from "fastify"
import rateLimit from "@fastify/rate-limit"
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { registerApi, type MistralCookieValidator } from "../src/api.js"
import { loadConfig } from "../src/config.js"
import { UsageDatabase } from "../src/db.js"
import type { AccountRef } from "../src/domain.js"
import { toPublicAccountKey } from "../src/mask.js"
import type { UsageScheduler } from "../src/scheduler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.()
  }
})

function seedAccount(db: UsageDatabase, ref: AccountRef, remaining: number): void {
  db.upsertAccount(ref)
  db.ensureState(ref.accountKey, 600)
  db.insertImportedCheck({
    ref,
    checkedAt: "2026-10-01T00:00:00.000Z",
    quotas: [
      {
        key: "gemini-weekly",
        label: "Gemini — Weekly",
        remaining,
        resetAt: null,
      },
    ],
  })
}

function seedQuota(db: UsageDatabase, ref: AccountRef, quota: { key: string; label: string; remaining: number }): void {
  db.insertImportedCheck({
    ref,
    checkedAt: "2026-10-01T00:05:00.000Z",
    quotas: [quota],
  })
}

async function buildTestApp(
  options: {
    extraAccounts?: AccountRef[]
    hiddenProviders?: string
    hiddenQuotas?: string
    pushToken?: string
    mistralValidator?: MistralCookieValidator
    schedulerRefresh?: (accountKeys: string[] | null) => Promise<unknown>
  } = {},
) {
  const config = loadConfig({
    ...process.env,
    DATABASE_PATH: ":memory:",
    OPENCODE_CONFIG_DIR: "/nonexistent/opencode",
    CODEX_HOME: "/nonexistent/codex",
    HIDDEN_PROVIDERS: options.hiddenProviders ?? "",
    HIDDEN_QUOTAS: options.hiddenQuotas ?? "",
    MISTRAL_CODE_CONFIG_PATH: "/tmp/opencode/test-mistral.json",
    CREDENTIAL_PUSH_TOKEN: options.pushToken ?? "",
  })
  const db = new UsageDatabase(":memory:")
  const ref: AccountRef = {
    accountKey: "google:test@example.com",
    provider: "Google",
    label: "test@example.com",
    collectorId: "antigravity",
  }
  const refs = [ref, ...(options.extraAccounts ?? [])]

  seedAccount(db, ref, 0.75)
  for (const extra of options.extraAccounts ?? []) seedAccount(db, extra, 0.1)

  const refreshCalls: Array<string[] | null> = []
  const scheduler = {
    isRefreshing: () => false,
    getLastTickAt: () => "2026-10-22T12:00:00.000Z",
    isTicking: () => false,
    getDiscoveredAccountKeys: () => refs.map((account) => account.accountKey),
    triggerDue: async () => undefined,
    refresh: async (accountKeys: string[] | null) => {
      refreshCalls.push(accountKeys)
      return (
        options.schedulerRefresh?.(accountKeys) ?? {
          refreshed: [],
          skipped: [{ accountKey: ref.accountKey, reason: "Manual refresh cooldown" }],
        }
      )
    },
  } as unknown as UsageScheduler

  const app = Fastify()
  await app.register(rateLimit, { global: false })
  registerApi(app, {
    config,
    db,
    scheduler,
    mistralValidator: options.mistralValidator,
  })
  cleanup.push(async () => {
    await app.close()
    db.close()
  })

  return { app, db, ref, refreshCalls }
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
    expect(body.accounts[0].quotas[0].windowSec).toBe(604_800)
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

  it("hides configured providers from usage and history", async () => {
    const hiddenRef: AccountRef = {
      accountKey: "vnai-pro:default",
      provider: "VNAI Pro",
      label: "sk-…1234 (VNAI Pro)",
      collectorId: "vnai-pro",
    }
    const { app, ref } = await buildTestApp({
      extraAccounts: [hiddenRef],
      hiddenProviders: "VNAI Pro",
    })

    for (const url of ["/api/usage", "/api/public/usage"]) {
      const body = (await app.inject({ method: "GET", url })).json()
      expect(body.accounts.map((account: { accountKey: string }) => account.accountKey)).toEqual([
        url === "/api/usage" ? ref.accountKey : toPublicAccountKey(ref.accountKey),
      ])
    }

    const allHistory = (
      await app.inject({
        method: "GET",
        url: "/api/history?from=2026-09-01T00:00:00Z",
      })
    ).json()
    expect(allHistory.points).toHaveLength(1)
    expect(allHistory.points[0].accountKey).toBe(ref.accountKey)

    const hiddenHistory = (
      await app.inject({
        method: "GET",
        url: `/api/history?accountKey=${encodeURIComponent(hiddenRef.accountKey)}&from=2026-09-01T00:00:00Z`,
      })
    ).json()
    expect(hiddenHistory.points).toEqual([])

    const publicHidden = (
      await app.inject({
        method: "GET",
        url: `/api/public/history?accountKey=${encodeURIComponent(toPublicAccountKey(hiddenRef.accountKey))}&from=2026-09-01T00:00:00Z`,
      })
    ).json()
    expect(publicHidden.points).toEqual([])
  })

  it("hides quotas matching HIDDEN_QUOTAS across usage and history", async () => {
    const { app, db, ref } = await buildTestApp({ hiddenQuotas: "Gemini" })
    seedQuota(db, ref, { key: "claude-weekly", label: "Claude — Weekly", remaining: 0.5 })

    const usage = (await app.inject({ method: "GET", url: "/api/usage" })).json()
    expect(usage.accounts).toHaveLength(1)
    expect(usage.accounts[0].quotas.map((quota: { key: string }) => quota.key)).toEqual([
      "claude-weekly",
    ])

    const publicUsage = (await app.inject({ method: "GET", url: "/api/public/usage" })).json()
    expect(publicUsage.accounts[0].quotas.map((quota: { key: string }) => quota.key)).toEqual([
      "claude-weekly",
    ])

    const history = (
      await app.inject({ method: "GET", url: "/api/history?from=2026-09-01T00:00:00Z" })
    ).json()
    expect(
      history.points.every((point: { quotaKey: string }) => point.quotaKey !== "gemini-weekly"),
    ).toBe(true)
    expect(history.points.length).toBeGreaterThan(0)

    const hiddenQuotaHistory = (
      await app.inject({
        method: "GET",
        url: "/api/history?quotaKey=gemini-weekly&from=2026-09-01T00:00:00Z",
      })
    ).json()
    expect(hiddenQuotaHistory.points).toEqual([])

    const publicHistory = (
      await app.inject({ method: "GET", url: "/api/public/history?from=2026-09-01T00:00:00Z" })
    ).json()
    expect(
      publicHistory.points.every(
        (point: { quotaKey: string }) => point.quotaKey !== "gemini-weekly",
      ),
    ).toBe(true)
  })

  it("drops accounts whose quotas are all hidden", async () => {
    const { app, ref } = await buildTestApp({
      hiddenQuotas: "gemini",
      schedulerRefresh: async () => ({
        refreshed: [
          {
            accountKey: ref.accountKey,
            provider: "Google",
            label: ref.label,
            quotas: [
              { key: "gemini-weekly", label: "Gemini — Weekly", remaining: 0.4, resetAt: null },
            ],
            error: null,
            warning: null,
            durationMs: 10,
          },
        ],
        skipped: [],
      }),
    })

    const usage = (await app.inject({ method: "GET", url: "/api/usage" })).json()
    expect(usage.accounts).toEqual([])

    const refresh = await app.inject({ method: "POST", url: "/api/refresh", payload: {} })
    expect(refresh.json().refreshed).toEqual([])
  })
})

describe("Mistral credential push", () => {
  const cookieValue = "MTc5Mzk3NTAyOHxYQnVvRWZyYUxTSVlXWnVQdkxsNXpIVzN1VE9zdGVzdA=="
  const push = async (
    app: Awaited<ReturnType<typeof buildTestApp>>["app"],
    body: unknown,
    token = "test-token",
  ) =>
    app.inject({
      method: "POST",
      url: "/api/credentials/mistral",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: body as Record<string, unknown>,
    })

  afterEach(async () => {
    await rm("/tmp/opencode/test-mistral.json", { force: true })
  })

  it("is disabled without a push token", async () => {
    const { app } = await buildTestApp()
    const response = await push(app, { cookieName: "ory_session_x", cookieValue })
    expect(response.statusCode).toBe(404)
  })

  it("rejects invalid tokens and bodies", async () => {
    const { app } = await buildTestApp({ pushToken: "test-token" })
    expect((await push(app, { cookieName: "ory_session_x", cookieValue }, "wrong")).statusCode).toBe(401)
    expect(
      (await push(app, { cookieName: "other_cookie", cookieValue })).statusCode,
    ).toBe(400)
    expect((await push(app, { cookieName: "ory_session_x", cookieValue: "short" })).statusCode).toBe(400)
  })

  it("validates, persists, and refreshes on success", async () => {
    const seen: string[] = []
    const validator: MistralCookieValidator = async (cookie) => {
      seen.push(cookie)
      return { ok: true }
    }
    const { app, refreshCalls } = await buildTestApp({
      pushToken: "test-token",
      mistralValidator: validator,
      schedulerRefresh: () => ({
        refreshed: [
          {
            accountKey: "mistral-code:default",
            provider: "Mistral Code",
            label: "Mistral Code",
            quotas: [{ key: "mistral-code", label: "Mistral Code — Monthly", remaining: 0.99, resetAt: null, raw: {} }],
            error: null,
            warning: null,
          },
        ],
        skipped: [],
      }),
    })

    const response = await push(app, { cookieName: "ory_session_x", cookieValue })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.quotas[0].remaining).toBeCloseTo(0.99)
    expect(seen).toEqual([`ory_session_x=${cookieValue}`])
    expect(refreshCalls).toEqual([["mistral-code:default"]])
    expect(JSON.stringify(body)).not.toContain(cookieValue)

    const { readFile, stat } = await import("node:fs/promises")
    const stored = JSON.parse(await readFile("/tmp/opencode/test-mistral.json", "utf8"))
    expect(stored.orySessionCookie).toBe(`ory_session_x=${cookieValue}`)
    expect(((await stat("/tmp/opencode/test-mistral.json")).mode & 0o777)).toBe(0o600)
  })

  it("retries with a quoted cookie when the plain form fails", async () => {
    const seen: string[] = []
    const validator: MistralCookieValidator = async (cookie) => {
      seen.push(cookie)
      return cookie.includes('"') ? { ok: true } : { ok: false, error: "Session expired" }
    }
    const { app } = await buildTestApp({ pushToken: "test-token", mistralValidator: validator })

    const response = await push(app, { cookieName: "ory_session_x", cookieValue })
    expect(response.statusCode).toBe(200)
    expect(seen).toEqual([`ory_session_x=${cookieValue}`, `ory_session_x="${cookieValue}"`])
  })

  it("returns 422 when validation fails for every variant", async () => {
    const validator: MistralCookieValidator = async () => ({
      ok: false,
      error: "Session expired or unauthorized (copy a fresh ory_session_* cookie into mistral.json)",
    })
    const { app } = await buildTestApp({ pushToken: "test-token", mistralValidator: validator })

    const response = await push(app, { cookieName: "ory_session_x", cookieValue })
    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain("Session expired")
    expect(JSON.stringify(body)).not.toContain(cookieValue)
  })
})
