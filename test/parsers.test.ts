import { describe, expect, it } from "vitest"
import {
  summarizeAntigravityModels,
  summarizeQuotaSummary,
} from "../src/collectors/antigravity.js"
import {
  buildUpdatedAuth,
  decodeJwtExp,
  needsRefresh,
  parseCodexUsage,
} from "../src/collectors/codex.js"
import { parseOneProviderPayload } from "../src/collectors/oneprovider.js"
import { parseOpenCodeGoStatus } from "../src/collectors/opencode-go.js"

describe("OpenCode Go parser", () => {
  it("extracts rolling, weekly, and monthly usage", () => {
    const quotas = parseOpenCodeGoStatus({ access: { meters: {
      fiveHour: { usedMicroCents: 12, limitMicroCents: 100, resetsAt: "2026-10-22T13:00:00Z" },
      week: { usedMicroCents: 34, limitMicroCents: 100, resetsAt: "2026-10-22T14:00:00Z" },
      month: { usedMicroCents: 56, limitMicroCents: 100, resetsAt: "2026-10-23T12:00:00Z" },
    } } })

    expect(quotas.map((quota) => quota.key)).toEqual([
      "opencode-go-monthly",
      "opencode-go-weekly",
      "opencode-go-5h",
    ])
    expect(quotas[0]?.remaining).toBeCloseTo(0.44)
    expect(quotas[1]?.remaining).toBeCloseTo(0.66)
    expect(quotas[2]?.remaining).toBeCloseTo(0.88)
    expect(quotas[1]?.resetAt).toBe("2026-10-22T14:00:00.000Z")
  })

  it("rejects missing subscription access", () => {
    expect(() => parseOpenCodeGoStatus({ access: null })).toThrow("No active OpenCode Go subscription")
  })
})

describe("Codex parser", () => {
  it("parses both rate-limit windows", () => {
    const quotas = parseCodexUsage({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          limit_window_seconds: 18_000,
          used_percent: 25,
          reset_after_seconds: 3600,
        },
        secondary_window: {
          limit_window_seconds: 604_800,
          used_percent: 10,
          reset_at: 1_800_000_000,
        },
      },
    })

    expect(quotas.map((quota) => quota.label)).toEqual([
      "Codex — 5h",
      "Codex — Weekly",
    ])
    expect(quotas[0]?.remaining).toBeCloseTo(0.75)
    expect(quotas[1]?.remaining).toBeCloseTo(0.9)
    expect(quotas[1]?.resetAt).toBe("2027-01-15T08:00:00.000Z")
  })

  it("returns an empty list without a rate limit", () => {
    expect(parseCodexUsage({})).toEqual([])
  })
})

describe("Antigravity parsers", () => {
  it("summarizes quota groups and merges duplicate labels", () => {
    const quotas = summarizeQuotaSummary({
      groups: [
        {
          displayName: "Gemini",
          buckets: [
            {
              window: "weekly",
              remaining: {
                remainingFraction: 0.9,
                resetTime: "2026-10-29T00:00:00.000Z",
              },
            },
            {
              bucketId: "gemini-weekly",
              remainingFraction: 0.8,
              resetTime: "2026-10-28T00:00:00.000Z",
            },
          ],
        },
        {
          displayName: "Claude",
          buckets: [
            {
              window: "5h",
              remainingFraction: 0.4,
              resetTime: "2026-10-22T14:00:00.000Z",
            },
          ],
        },
      ],
    })

    expect(quotas).toHaveLength(2)
    expect(quotas[0]?.label).toBe("Gemini — Weekly")
    expect(quotas[0]?.remaining).toBeCloseTo(0.8)
    expect(quotas[0]?.resetAt).toBe("2026-10-28T00:00:00.000Z")
    expect(quotas[1]?.label).toBe("Claude — 5h")
    expect(quotas[1]?.remaining).toBeCloseTo(0.4)
  })

  it("falls back to the model list", () => {
    const quotas = summarizeAntigravityModels({
      "gemini-3-pro": {
        displayName: "Gemini 3 Pro",
        quotaInfo: {
          remainingFraction: 0.7,
          resetTime: "2026-10-29T00:00:00.000Z",
        },
      },
      "gemini-3-flash": {
        quotaInfo: { remainingFraction: 0.9 },
      },
      "claude-sonnet": {
        quotaInfo: { remainingFraction: 0.3 },
      },
      "gemini-2.0": {
        quotaInfo: { remainingFraction: 0.1 },
      },
    })

    expect(quotas.map((quota) => quota.label)).toEqual([
      "Gemini 3 Pro",
      "Gemini 3 Flash",
      "Claude",
    ])
    expect(quotas[0]?.key).toBe("gemini-3-pro")
  })
})

describe("OneProvider parser", () => {
  it("extracts balance, quota, and expiry", () => {
    const parsed = parseOneProviderPayload({
      status: "ok",
      snapshot: {
        quota_used_usd: 25,
        quota_usd: 100,
        balance_usd: 75,
      },
      key: {
        masked: "sk-…abcd",
        expires_at: "2027-01-01T00:00:00.000Z",
        is_active: true,
        base_url: "https://example.invalid",
      },
    })

    expect(parsed.label).toBe("sk-…abcd")
    expect(parsed.quotas[0]?.remaining).toBeCloseTo(0.75)
    expect(parsed.quotas[0]?.raw?.balanceUsd).toBe(75)
    expect(parsed.quotas[0]?.resetAt).toBe("2027-01-01T00:00:00.000Z")
  })

  it("throws on unsuccessful lookups", () => {
    expect(() => parseOneProviderPayload({ status: "error", reason: "nope" })).toThrow(
      "nope",
    )
  })
})

function fakeJwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url")
  return `header.${payload}.signature`
}

describe("Codex token helpers", () => {
  it("decodes JWT expiry", () => {
    expect(decodeJwtExp(fakeJwt(1_800_000_000))).toBe(1_800_000_000)
    expect(decodeJwtExp("not-a-jwt")).toBeNull()
  })

  it("decides when a refresh is needed", () => {
    const now = new Date("2026-10-22T12:00:00.000Z")
    const nowSec = Math.floor(now.getTime() / 1000)
    expect(needsRefresh(fakeJwt(nowSec + 600), now, 300)).toBe(false)
    expect(needsRefresh(fakeJwt(nowSec + 60), now, 300)).toBe(true)
    expect(needsRefresh(null, now, 300)).toBe(true)
  })

  it("updates auth.json while preserving other fields", () => {
    const current = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        account_id: "acct",
        access_token: "old",
        refresh_token: "old-refresh",
        id_token: "old-id",
      },
    }
    const updated = buildUpdatedAuth(
      current,
      { accessToken: "new", refreshToken: "new-refresh", idToken: "new-id" },
      new Date("2026-10-22T12:00:00.000Z"),
    )

    expect(updated.auth_mode).toBe("chatgpt")
    expect(updated.last_refresh).toBe("2026-10-22T12:00:00.000Z")
    const tokens = updated.tokens as Record<string, unknown>
    expect(tokens.account_id).toBe("acct")
    expect(tokens.access_token).toBe("new")
    expect(tokens.refresh_token).toBe("new-refresh")
    expect(tokens.id_token).toBe("new-id")
  })
})
