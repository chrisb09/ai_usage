import { describe, expect, it } from "vitest"
import type { Quota } from "../src/domain.js"
import { quotaWindowSec } from "../src/quota-window.js"

function quota(overrides: Partial<Quota>): Quota {
  return {
    key: "test",
    label: "Test",
    remaining: 1,
    resetAt: null,
    ...overrides,
  }
}

describe("quotaWindowSec", () => {
  it("prefers the explicit window length", () => {
    expect(quotaWindowSec(quota({ windowSec: 1_234 }))).toBe(1_234)
    expect(quotaWindowSec(quota({ raw: { windowSec: 4_567 } }))).toBe(4_567)
    expect(quotaWindowSec(quota({ raw: { windowSeconds: 7_890 } }))).toBe(7_890)
  })

  it("infers common windows from the key or label", () => {
    expect(quotaWindowSec(quota({ key: "claude-5h" }))).toBe(18_000)
    expect(quotaWindowSec(quota({ label: "Codex — 5 hour" }))).toBe(18_000)
    expect(quotaWindowSec(quota({ key: "gemini-weekly" }))).toBe(604_800)
    expect(quotaWindowSec(quota({ label: "OpenCode Go — Monthly" }))).toBe(2_592_000)
  })

  it("does not invent a window for balance-style quotas", () => {
    expect(quotaWindowSec(quota({ key: "oneprovider", label: "OneProvider" }))).toBeNull()
    expect(quotaWindowSec(quota({ key: "vnai-pro", label: "VNAI Pro" }))).toBeNull()
    expect(quotaWindowSec(quota({ key: "free-trial-credit" }))).toBeNull()
  })
})
