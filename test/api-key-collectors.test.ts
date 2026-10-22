import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/config.js"
import { OneProviderCollector, parseOneProviderPayload } from "../src/collectors/oneprovider.js"
import { VnaiProCollector, parseVnaiProPayload } from "../src/collectors/vnai-pro.js"
import * as http from "../src/collectors/http.js"
import * as util from "../src/collectors/util.js"

afterEach(() => vi.restoreAllMocks())

const key = "sk-test-secret-12345678"
const config = loadConfig({ OPENCODE_AUTH_PATH: "/test/auth.json", ONEPROVIDER_CONFIG_PATH: "/test/oneprovider.json" })

function response(body: unknown): http.HttpResponse {
  return { ok: true, status: 200, statusText: "OK", redirected: false, text: async () => JSON.stringify(body), json: async () => body }
}

describe("API key collectors", () => {
  it("discovers both providers in the existing shared auth store and masks labels", async () => {
    vi.spyOn(util, "readJsonFile").mockImplementation(async (path) => path === "/test/auth.json"
      ? { ok: true, value: { oneprovider: { key }, vnaipro: { key } } }
      : { ok: false, kind: "missing" })
    const one = await new OneProviderCollector(config).discover()
    const vnai = await new VnaiProCollector(config).discover()
    expect(one[0]?.accountKey).toBe("oneprovider:default")
    expect(vnai[0]?.accountKey).toBe("vnai-pro:default")
    expect(one[0]?.label).toBe("sk-…5678 (OneProvider)")
    expect(vnai[0]?.label).toBe("sk-…5678 (VNAI Pro)")
  })

  it("prefers OneProvider's explicit config over its shared-store key", async () => {
    const read = vi.spyOn(util, "readJsonFile").mockResolvedValue({ ok: true, value: { apiKey: key } })
    const refs = await new OneProviderCollector(config).discover()
    expect(refs[0]?.data).toEqual({ apiKey: key })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith("/test/oneprovider.json")
  })

  it("uses OneProvider's live balance and original purchased budget", () => {
    const parsed = parseOneProviderPayload({
      status: "ok",
      snapshot: { balance_usd: 40.06, quota_usd: 100, quota_used_usd: 0 },
      key: { masked: "sk-…1234", initial_balance_usd: 220, expires_at: "2027-01-01T00:00:00Z" },
    })
    expect(parsed.quotas[0]?.remaining).toBeCloseTo(40.06 / 220)
    expect(parsed.quotas[0]?.raw).toMatchObject({ balanceUsd: 40.06, quotaUsd: 220, usedUsd: 179.94 })
  })

  it("requests a live OneProvider snapshot", async () => {
    const fetch = vi.spyOn(http, "fetchWithTimeout").mockResolvedValue(response({ status: "ok", snapshot: { balance_usd: 40, quota_usd: 100 }, key: { masked: "sk-…5678" } }))
    const result = await new OneProviderCollector(config).collect({ accountKey: "oneprovider:default", provider: "OneProvider", label: "sk-…5678", collectorId: "oneprovider", data: { apiKey: key } })
    expect(result.error).toBeNull()
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ key_value: key, days: 0, live: true })
    expect(JSON.stringify(result)).not.toContain(key)
  })

  it("parses VNAI Pro credit and expiry", () => {
    const quotas = parseVnaiProPayload({ account: { status: "active", days_until_expiry: 5 }, quota: { limit: 100, remaining: 0.44, used: 99.56 } }, new Date("2026-10-22T00:00:00Z"))
    expect(quotas[0]?.remaining).toBeCloseTo(0.0044)
    expect(quotas[0]?.raw).toMatchObject({ balanceUsd: 0.44, quotaUsd: 100, usedUsd: 99.56 })
    expect(quotas[0]?.resetAt).toBe("2026-10-27T00:00:00.000Z")
    expect(parseVnaiProPayload({ quota: { limit: 100, remaining: 0 } })[0]?.remaining).toBe(0)
  })

  it("rejects invalid VNAI Pro accounts and missing quota payloads", () => {
    expect(() => parseVnaiProPayload({ account: { is_valid: false }, quota: {} })).toThrow("Account status")
    expect(() => parseVnaiProPayload({ error: "Invalid key" })).toThrow("Invalid key")
  })

  it("collects VNAI Pro with the reference request and redacts echoed keys from errors", async () => {
    const fetch = vi.spyOn(http, "fetchWithTimeout").mockResolvedValue(response({ quota: { remaining: 0.44, limit: 100 } }))
    const ref = { accountKey: "vnai-pro:default", provider: "VNAI Pro", label: "sk-…5678 (VNAI Pro)", collectorId: "vnai-pro", data: { apiKey: key } }
    const collector = new VnaiProCollector(config)
    const result = await collector.collect(ref)
    expect(result.error).toBeNull()
    expect(fetch.mock.calls[0]?.[0]).toBe("https://vibi.top/docs-setup/api/usage")
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ apiKey: key, startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(JSON.stringify(result)).not.toContain(key)
    fetch.mockResolvedValue(response({ error: `Invalid key ${key}` }))
    const failure = await collector.collect(ref)
    expect(failure.error).toContain("[redacted]")
    expect(JSON.stringify(failure)).not.toContain(key)
  })
})
