import { describe, expect, it } from "vitest"
import { parseCodexUsage } from "../src/collectors/codex.js"
import { parseOpenCodeGoStatus } from "../src/collectors/opencode-go.js"

describe("unknown quota is not unused allowance", () => {
  it("preserves a missing Codex usage counter as unknown", () => {
    const [quota] = parseCodexUsage({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } })
    expect(quota!.remaining).toBeNull()
    expect(quota!.raw!.usedPercent).toBeNull()
  })
  it("preserves a missing Go usage counter as unknown", () => {
    const [quota] = parseOpenCodeGoStatus({ access: { meters: { month: { limitMicroCents: 100 } } } })
    expect(quota!.remaining).toBeNull()
    expect(quota!.raw!.usedMicroCents).toBeNull()
  })
  it("still recognizes explicitly reported zero usage", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0 } } })[0]!.remaining).toBe(1)
    expect(parseOpenCodeGoStatus({ access: { meters: { month: { usedMicroCents: 0, limitMicroCents: 100 } } } })[0]!.remaining).toBe(1)
  })
})
