import { afterEach, describe, expect, it, vi } from "vitest"
import { AntigravityCollector } from "../src/collectors/antigravity.js"
import * as http from "../src/collectors/http.js"
import { loadConfig } from "../src/config.js"

afterEach(() => vi.restoreAllMocks())

describe("Antigravity collection", () => {
  it("queries the current endpoint and preserves both independent quota pools", async () => {
    const groups = [
      { displayName: "Gemini models", buckets: [
        { window: "weekly", remainingFraction: 0.95 },
        { window: "5h", remainingFraction: 1 },
      ] },
      { displayName: "Claude and GPT models", buckets: [
        { window: "weekly", remainingFraction: 0.8 },
        { window: "5h", remainingFraction: 0.6 },
      ] },
    ]
    const fetch = vi.spyOn(http, "fetchWithTimeout").mockImplementation(async (url, options) => {
      let body: unknown
      if (url === "https://oauth2.googleapis.com/token") {
        body = { access_token: "test-token", expires_in: 3600 }
      } else {
        expect(url).toMatch(/^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:/)
        expect(options?.headers?.["User-Agent"]).toBe("antigravity/cli/1.1.13 (aidev_client; linux; amd64)")
        body = url.endsWith(":retrieveUserQuotaSummary") ? { groups } : { models: {} }
      }
      return { ok: true, status: 200, statusText: "OK", redirected: false, text: async () => JSON.stringify(body), json: async () => body }
    })

    const result = await new AntigravityCollector(loadConfig({ ANTIGRAVITY_CLIENT_SECRET: "test-client-secret" })).collect({
      accountKey: "google:test",
      provider: "Google",
      label: "test",
      collectorId: "antigravity",
      data: { account: { refreshToken: "test-refresh", managedProjectId: "test-project" }, index: 0 },
    })
    expect(result.error).toBeNull()
    expect(result.quotas.map((quota) => [quota.key, quota.remaining])).toEqual([
      ["gemini-weekly", 0.95], ["gemini-5h", 1],
      ["claude-weekly", 0.8], ["claude-5h", 0.6],
    ])
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
