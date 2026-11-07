import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/config.js"
import { MistralCodeCollector, parseMistralUsage } from "../src/collectors/mistral-code.js"
import type { CurlRunResult } from "../src/collectors/mistral-code.js"
import * as util from "../src/collectors/util.js"

afterEach(() => vi.restoreAllMocks())

const cookie =
  'ory_session_testfixture="MTc5Mzk3NTAyOHxYQnVvRWZyYUxTSVlXWnVQdkxsNXpIVzN1VE9zdGVzdA=="'
const config = loadConfig({
  OPENCODE_CONFIG_DIR: "/test/opencode",
  CURL_IMPERSONATE_PATH: "/test/curl-impersonate",
})

const usageBody = JSON.stringify([
  {
    result: {
      data: {
        json: { usagePercentage: 0.3638459133333333, paygEnabled: false, resetAt: "2026-12-01T00:00:00Z" },
      },
    },
  },
])

function okRun(body: string, status = 200): (args: string[]) => Promise<CurlRunResult> {
  return async () => ({ status, body })
}

function refWithCookie(): Parameters<MistralCodeCollector["collect"]>[0] {
  return {
    accountKey: "mistral-code:default",
    provider: "Mistral Code",
    label: "Mistral Code",
    collectorId: "mistral-code",
    data: { cookie },
  }
}

describe("Mistral Code collector", () => {
  it("parses the tRPC usage envelope into a monthly quota", () => {
    const quota = parseMistralUsage(JSON.parse(usageBody))

    expect(quota.key).toBe("mistral-code")
    expect(quota.label).toBe("Mistral Code — Monthly")
    expect(quota.remaining).toBeCloseTo(1 - 0.3638459133333333 / 100)
    expect(quota.resetAt).toBe("2026-12-01T00:00:00.000Z")
    expect(quota.raw).toEqual({ usagePercent: 0.36, paygEnabled: false })
  })

  it("rejects payloads without usage data", () => {
    expect(() => parseMistralUsage([{ result: { data: { json: {} } } }])).toThrow(
      "Invalid Mistral usage payload",
    )
    expect(() => parseMistralUsage({})).toThrow("No usage data returned from Mistral")
  })

  it("discovers the session cookie from mistral.json", async () => {
    vi.spyOn(util, "readJsonFile").mockResolvedValue({
      ok: true,
      value: { orySessionCookie: cookie },
    })
    const refs = await new MistralCodeCollector(config).discover()

    expect(refs).toHaveLength(1)
    expect(refs[0]?.accountKey).toBe("mistral-code:default")
    expect(refs[0]?.data).toEqual({ cookie })
  })

  it("reports a discovery error when the cookie is missing", async () => {
    vi.spyOn(util, "readJsonFile").mockResolvedValue({ ok: true, value: {} })
    const refs = await new MistralCodeCollector(config).discover()

    expect(refs[0]?.discoveryError).toContain("orySessionCookie")
  })

  it("collects usage through curl-impersonate with the session cookie", async () => {
    const seen: string[][] = []
    const collector = new MistralCodeCollector(config, async (args) => {
      seen.push(args)
      return { status: 200, body: usageBody }
    })
    const result = await collector.collect(refWithCookie())

    expect(result.error).toBeNull()
    expect(result.quotas[0]?.remaining).toBeCloseTo(1 - 0.3638459133333333 / 100)
    expect(seen[0]?.join(" ")).toContain("apiKey.getUsage")
    expect(seen[0]).toContain("--impersonate")
    expect(seen[0]).toContain(config.curlImpersonateTarget)
    expect(seen[0]?.join(" ")).toContain("Sec-Fetch-Site: same-origin")
    expect(seen[0]?.join(" ")).toContain(cookie)
  })

  it("reports an expired session on 401 without leaking the cookie", async () => {
    const collector = new MistralCodeCollector(config, async () => ({
      status: 401,
      body: JSON.stringify([{ error: { json: { message: "Unauthorized" } } }]),
    }))
    const result = await collector.collect(refWithCookie())

    expect(result.error).toContain("Session expired")
    expect(JSON.stringify(result)).not.toContain(cookie)
  })

  it("distinguishes a Cloudflare challenge from an app-level 403", async () => {
    const challenge = new MistralCodeCollector(
      config,
      async () => ({ status: 403, body: "<!DOCTYPE html><html>Just a moment...</html>" }),
    )
    expect((await challenge.collect(refWithCookie())).error).toContain("Cloudflare")

    const forbidden = new MistralCodeCollector(
      config,
      async () => ({ status: 403, body: JSON.stringify({ error: "forbidden" }) }),
    )
    expect((await forbidden.collect(refWithCookie())).error).toContain("Session expired")
  })

  it("redacts the cookie from runner failures", async () => {
    const collector = new MistralCodeCollector(config, async () => {
      throw new Error(`curl-impersonate failed: bad header ${cookie}`)
    })
    const result = await collector.collect(refWithCookie())

    expect(result.error).toContain("[redacted]")
    expect(result.error).not.toContain(cookie)
  })
})
