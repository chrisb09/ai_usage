import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/config.js"
import { billingQuota, buildBillingQuery, GcpBillingCollector } from "../src/collectors/gcp-billing.js"
import * as http from "../src/collectors/http.js"
import * as util from "../src/collectors/util.js"

afterEach(() => vi.restoreAllMocks())
const settings = {
  serviceAccountPath: "/test/key.json", queryProject: "test-project",
  table: "test-project.billing.gcp_billing_export_v1_ABC_DEF_GHI", location: "EU",
  grantAmount: 264, currency: "EUR", expiresAt: "2027-01-21T23:00:00Z", maximumBytesBilled: 1_000_000_000,
}
const now = Date.parse("2026-10-24T00:00:00Z")

describe("Google Cloud billing credits", () => {
  it("keeps the balance unknown until billing records exist", () => {
    expect(billingQuota(settings, [], now)).toMatchObject({ remaining: null, raw: { balance: null, waitingForData: true, grantAmount: 264 } })
  })
  it("accounts for negative credit usage and positive corrections", () => {
    const quota = billingQuota(settings, [
      { currency: "EUR", billing_rows: "2", credits_applied: "-30", latest_export: "1792800000.0" },
      { currency: "EUR", billing_rows: "1", credits_applied: "5", latest_export: "1792800100.0" },
    ], now)
    expect(quota.remaining).toBeCloseTo(239 / 264)
    expect(quota.raw).toMatchObject({ balance: 239, used: 25, estimated: true, waitingForData: false, latestExportAt: new Date(1792800100000).toISOString() })
  })
  it("handles zero consumption, exhaustion, expiry, and currency mismatch", () => {
    const row = { currency: "EUR", billing_rows: "1", credits_applied: "0" }
    expect(billingQuota(settings, [row], now).remaining).toBe(1)
    expect(billingQuota(settings, [{ ...row, credits_applied: "-300" }], now).remaining).toBe(0)
    expect(billingQuota(settings, [], Date.parse("2027-01-22T00:00:00Z"))).toMatchObject({ remaining: 0, raw: { expired: true, waitingForData: false } })
    expect(() => billingQuota(settings, [{ ...row, currency: "USD" }], now)).toThrow("currency")
  })
  it("queries account-wide promotional credits with an optional parameterized grant id", () => {
    const sql = buildBillingQuery(settings)
    expect(sql).toContain("c.type = 'PROMOTION'")
    expect(sql).toContain("c.id = @creditId")
    expect(sql).not.toContain("project.id")
  })
  it("authenticates, caps query costs, parses the response, and exposes no credentials", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const private_key = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    vi.spyOn(util, "readJsonFile").mockImplementation(async path => ({ ok: true, value: path === "/test/key.json" ? { client_email: "test@example.com", private_key } : settings }))
    const response = (body: unknown): http.HttpResponse => ({ ok: true, status: 200, statusText: "OK", redirected: false, json: async () => body, text: async () => JSON.stringify(body) })
    const fetch = vi.spyOn(http, "fetchWithTimeout")
      .mockResolvedValueOnce(response({ access_token: "secret-token" }))
      .mockResolvedValueOnce(response({ jobComplete: true, schema: { fields: ["currency", "billing_rows", "latest_export", "credits_applied"].map(name => ({ name })) }, rows: [{ f: ["EUR", "1", "1792800000.0", "-10"].map(v => ({ v })) }] }))
    const collector = new GcpBillingCollector(loadConfig({ GCP_BILLING_CONFIG_PATH: "/test/config.json" }))
    const [ref] = await collector.discover()
    expect(ref).toBeDefined()
    const result = await collector.collect(ref!)
    expect(result.error).toBeNull()
    expect(result.quotas[0]?.raw?.balance).toBe(254)
    expect(fetch.mock.calls[0]?.[1]?.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded")
    const body = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)
    expect(body).toMatchObject({ maximumBytesBilled: "1000000000", location: "EU", useLegacySql: false })
    expect(JSON.stringify(result)).not.toContain("secret-token")
    expect(JSON.stringify(result)).not.toContain(private_key)
  })
})
