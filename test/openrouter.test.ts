import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/config.js"
import { OpenRouterCollector, parseOpenRouterCredits, parseOpenRouterKey } from "../src/collectors/openrouter.js"
import * as http from "../src/collectors/http.js"
import * as util from "../src/collectors/util.js"

afterEach(() => vi.restoreAllMocks())

const apiKey = "sk-or-v1-normal-secret-12345678"
const managementKey = "sk-or-v1-management-secret-87654321"
const config = loadConfig({ OPENCODE_AUTH_PATH: "/test/auth.json" })

function response(body: unknown, status = 200): http.HttpResponse {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    redirected: false,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  }
}

describe("OpenRouter collector", () => {
  it("discovers both keys in the shared auth store and masks the label", async () => {
    vi.spyOn(util, "readJsonFile").mockResolvedValue({
      ok: true,
      value: {
        openrouter: { type: "api", key: apiKey },
        "openrouter-management": { type: "api", key: managementKey },
      },
    })
    const refs = await new OpenRouterCollector(config).discover()

    expect(refs).toHaveLength(1)
    expect(refs[0]?.accountKey).toBe("openrouter:default")
    expect(refs[0]?.label).toBe("sk-…5678 (OpenRouter)")
    expect(refs[0]?.data).toEqual({ apiKey, managementKey })
  })

  it("falls back to the management key when no normal key exists", async () => {
    vi.spyOn(util, "readJsonFile").mockResolvedValue({
      ok: true,
      value: { "openrouter-management": { type: "api", key: managementKey } },
    })
    const refs = await new OpenRouterCollector(config).discover()

    expect(refs[0]?.label).toBe("sk-…4321 (OpenRouter)")
    expect(refs[0]?.data).toEqual({ apiKey: managementKey, managementKey: undefined })
  })

  it("parses account credits into a remaining fraction", () => {
    const quota = parseOpenRouterCredits({
      data: { total_credits: 30, total_usage: 19.729343725 },
    })

    expect(quota.remaining).toBeCloseTo((30 - 19.729343725) / 30)
    expect(quota.raw).toMatchObject({
      balanceUsd: 30 - 19.729343725,
      quotaUsd: 30,
      usedUsd: 19.729343725,
    })
    expect(parseOpenRouterCredits({ data: { total_credits: 0, total_usage: 0 } }).remaining).toBeNull()
  })

  it("parses limited and unlimited key payloads", () => {
    const limited = parseOpenRouterKey({
      data: { limit: 100, limit_remaining: 74.5, usage: 25.5 },
    })
    expect(limited.remaining).toBeCloseTo(0.745)
    expect(limited.raw).toMatchObject({ balanceUsd: 74.5, quotaUsd: 100, usedUsd: 25.5 })

    const unlimited = parseOpenRouterKey({
      data: { limit: null, limit_remaining: null, usage: 7.19 },
    })
    expect(unlimited.remaining).toBeNull()
    expect(unlimited.raw).toEqual({ usedUsd: 7.19, unlimited: true })
  })

  it("prefers management credits and never leaks keys", async () => {
    const fetch = vi.spyOn(http, "fetchWithTimeout").mockResolvedValue(
      response({ data: { total_credits: 30, total_usage: 19.729343725 } }),
    )
    const ref = {
      accountKey: "openrouter:default",
      provider: "OpenRouter",
      label: "sk-…5678 (OpenRouter)",
      collectorId: "openrouter",
      data: { apiKey, managementKey },
    }
    const result = await new OpenRouterCollector(config).collect(ref)

    expect(result.error).toBeNull()
    expect(result.quotas[0]?.remaining).toBeCloseTo(0.342355)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/credits")
    expect(fetch.mock.calls[0]?.[1]?.headers?.Authorization).toBe(`Bearer ${managementKey}`)
    expect(JSON.stringify(result)).not.toContain(apiKey)
    expect(JSON.stringify(result)).not.toContain(managementKey)
  })

  it("falls back to the key limit when credits are unavailable", async () => {
    const fetch = vi
      .spyOn(http, "fetchWithTimeout")
      .mockResolvedValueOnce(response({ error: { message: "Only management keys can perform this operation" } }, 403))
      .mockResolvedValueOnce(response({ error: { message: "Only management keys can perform this operation" } }, 403))
      .mockResolvedValueOnce(response({ data: { limit: 100, limit_remaining: 74.5, usage: 25.5 } }))
    const ref = {
      accountKey: "openrouter:default",
      provider: "OpenRouter",
      label: "sk-…5678 (OpenRouter)",
      collectorId: "openrouter",
      data: { apiKey, managementKey },
    }
    const result = await new OpenRouterCollector(config).collect(ref)

    expect(result.error).toBeNull()
    expect(result.warning).toContain("Account-wide credits are unavailable")
    expect(result.quotas[0]?.remaining).toBeCloseTo(0.745)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/credits",
      "https://openrouter.ai/api/v1/credits",
      "https://openrouter.ai/api/v1/key",
    ])
  })

  it("redacts both keys from error messages", async () => {
    vi.spyOn(http, "fetchWithTimeout")
      .mockResolvedValueOnce(response({ error: { message: `bad ${managementKey}` } }, 401))
      .mockResolvedValueOnce(response({ error: { message: `bad ${apiKey}` } }, 401))
      .mockResolvedValueOnce(response({ error: { message: `bad ${apiKey} ${managementKey}` } }, 401))
    const ref = {
      accountKey: "openrouter:default",
      provider: "OpenRouter",
      label: "sk-…5678 (OpenRouter)",
      collectorId: "openrouter",
      data: { apiKey, managementKey },
    }
    const result = await new OpenRouterCollector(config).collect(ref)

    expect(result.error).toContain("[redacted]")
    expect(JSON.stringify(result)).not.toContain(apiKey)
    expect(JSON.stringify(result)).not.toContain(managementKey)
  })
})
