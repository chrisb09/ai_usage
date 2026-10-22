import { describe, expect, it } from "vitest"
import { overviewPool, overviewQuotas, overviewWindow } from "./overview"

describe("overview quota selection", () => {
  it("recognizes explicit weekly and monthly limits and excludes short or unspecified windows", () => {
    for (const label of ["Weekly", "7d", "7 days", "7-day limit"]) expect(overviewWindow({ label })).toBe("weekly")
    for (const label of ["Monthly", "30d", "30 days", "30-day limit"]) expect(overviewWindow({ label })).toBe("monthly")
    for (const label of ["5h", "Daily", "Rolling", "OneProvider", "VNAI Pro"]) expect(overviewWindow({ label })).toBeNull()
  })

  it("uses the same long-term-only selection for overview statistics", () => {
    const quotas = [
      { key: "codex-5h", label: "Codex — 5h", remaining: 0.01 },
      { key: "codex-weekly", label: "Codex — Weekly", remaining: 0.52 },
    ]
    expect(overviewQuotas(quotas).filter((quota) => quota.remaining < 0.2)).toHaveLength(0)
  })

  it("groups Google's long-term allowances by independent model family", () => {
    expect(overviewPool("Google", { label: "Gemini — Weekly" })).toBe("Google · Gemini")
    expect(overviewPool("Google", { label: "Claude — Weekly" })).toBe("Google · Claude")
    expect(overviewPool("Codex", { label: "Codex — Weekly" })).toBe("Codex")
  })
})
