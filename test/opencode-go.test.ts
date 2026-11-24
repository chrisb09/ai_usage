import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/config.js"
import { OpenCodeGoCollector, openCodeGoCookie, parseOpenCodeGoStatus, parseOpenCodeGoUsage } from "../src/collectors/opencode-go.js"
import * as http from "../src/collectors/http.js"
import * as util from "../src/collectors/util.js"

afterEach(() => vi.restoreAllMocks())

const config = loadConfig({ OPENCODE_GO_CONFIG_PATH: "/test/go.json", OPENCODE_AUTH_PATH: "/test/auth.json" })

describe("OpenCode Go status collection", () => {
  it("formats current console sessions and legacy cookies without corrupting cookie headers", () => {
    expect(openCodeGoCookie({ authCookie: "legacy" })).toBe("auth=legacy")
    expect(openCodeGoCookie({ authCookie: "st_session" })).toBe("__Host-console_session=st_session")
    expect(openCodeGoCookie({ authCookie: "auth=legacy; another=value", consoleSession: "st_session" })).toBe("auth=legacy; another=value; __Host-console_session=st_session")
    expect(openCodeGoCookie({ cookie: "auth=one; __Host-console_session=st_two" })).toBe("auth=one; __Host-console_session=st_two")
    expect(openCodeGoCookie({ consoleSession: "__Host-console_session=st_session" })).toBe("__Host-console_session=st_session")
  })

  it("discovers orgId and consoleSession and queries the subscription status endpoint", async () => {
    vi.spyOn(util, "readJsonFile").mockResolvedValue({ ok: true, value: { orgId: "org_test", consoleSession: "st_session", email: "test@example.com" } })
    const fetch = vi.spyOn(http, "fetchWithTimeout").mockResolvedValue({ ok: true, status: 200, statusText: "OK", redirected: false, text: async () => "", json: async () => ({ access: { meters: { month: { usedMicroCents: "60", limitMicroCents: "100" } } } }) })
    const collector = new OpenCodeGoCollector(config)
    const refs = await collector.discover()
    const result = await collector.collect(refs[0]!)
    expect(result.error).toBeNull()
    expect(result.quotas[0]?.remaining).toBeCloseTo(0.4)
    expect(fetch).toHaveBeenCalledWith("https://opencode.ai/console/api/go/status", expect.objectContaining({ headers: expect.objectContaining({ Cookie: "__Host-console_session=st_session", "x-org-id": "org_test" }) }), config.requestTimeoutMs)
    expect(JSON.stringify(result)).not.toContain("st_session")
  })

  it("explains that an inference API key alone does not provide console usage access", async () => {
    vi.spyOn(util, "readJsonFile").mockImplementation(async (path) => path === "/test/auth.json"
      ? { ok: true, value: { "opencode-go": { key: "inference-key" } } }
      : { ok: false, kind: "missing" })
    const refs = await new OpenCodeGoCollector(config).discover()
    expect(refs[0]?.discoveryError).toContain("console session cookie")
    expect(JSON.stringify(refs)).not.toContain("inference-key")
  })

  it("handles overages, zero allowance, and the monthly subscription-end fallback", () => {
    const quotas = parseOpenCodeGoStatus({ access: { endsAt: "2026-11-01T00:00:00Z", meters: {
      month: { usedMicroCents: 110, limitMicroCents: 100 },
      week: { usedMicroCents: 0, limitMicroCents: 0 },
    } } })
    expect(quotas.map((q) => q.remaining)).toEqual([0, 0])
    expect(quotas[0]?.resetAt).toBe("2026-11-01T00:00:00.000Z")
  })

  it("rejects missing or malformed meters instead of displaying a full allowance", () => {
    expect(() => parseOpenCodeGoStatus({ access: { meters: {} } })).toThrow("Could not parse usage meters")
    expect(() => parseOpenCodeGoStatus({ access: { meters: { month: { limitMicroCents: "bad" } } } })).toThrow("Invalid OpenCode Go monthly")
  })
})

describe("OpenCode Go usage API", () => {
  it("maps the documented usage response onto the existing quota keys", () => {
    const quotas = parseOpenCodeGoUsage({ usage: {
      rolling: { status: "ok", percent: 12, resetsAt: "2026-11-24T14:00:00Z" },
      weekly: { status: "ok", percent: 34, resetsAt: "2026-11-30T00:00:00Z" },
      monthly: { status: "rate-limited", percent: 56, resetsAt: "2026-12-01T00:00:00Z" },
    } })

    expect(quotas.map((quota) => quota.key)).toEqual([
      "opencode-go-monthly",
      "opencode-go-weekly",
      "opencode-go-5h",
    ])
    expect(quotas[0]?.remaining).toBeCloseTo(0.44)
    expect(quotas[1]?.remaining).toBeCloseTo(0.66)
    expect(quotas[2]?.remaining).toBeCloseTo(0.88)
    expect(quotas[2]?.resetAt).toBe("2026-11-24T14:00:00.000Z")
    expect(quotas[0]?.raw).toEqual({ usedPercent: 56, status: "rate-limited", windowSec: 2_592_000 })
  })

  it("uses the official endpoint and redacts the API key", async () => {
    const apiKey = "oc_sk_test_usage_key"
    vi.spyOn(util, "readJsonFile").mockResolvedValue({ ok: true, value: { apiKey, email: "test@example.com" } })
    const fetch = vi.spyOn(http, "fetchWithTimeout").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      redirected: false,
      text: async () => "",
      json: async () => ({ usage: {
        rolling: { status: "ok", percent: 10, resetsAt: "2026-11-24T14:00:00Z" },
        weekly: { status: "ok", percent: 20, resetsAt: "2026-11-30T00:00:00Z" },
        monthly: { status: "ok", percent: 30, resetsAt: "2026-12-01T00:00:00Z" },
      } }),
    })
    const collector = new OpenCodeGoCollector(config)
    const refs = await collector.discover()
    const result = await collector.collect(refs[0]!)

    expect(result.error).toBeNull()
    expect(result.quotas[0]?.remaining).toBeCloseTo(0.7)
    expect(fetch).toHaveBeenCalledWith(
      "https://opencode.ai/inference/go/v1/usage",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${apiKey}` }) }),
      config.requestTimeoutMs,
    )
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })

  it("reports an invalid API key without leaking it", async () => {
    const apiKey = "oc_sk_test_invalid_key"
    vi.spyOn(util, "readJsonFile").mockResolvedValue({ ok: true, value: { apiKey } })
    vi.spyOn(http, "fetchWithTimeout").mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      redirected: false,
      text: async () => "",
      json: async () => ({}),
    })
    const collector = new OpenCodeGoCollector(config)
    const refs = await collector.discover()
    const result = await collector.collect(refs[0]!)

    expect(result.error).toContain("invalid or expired")
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })
})
