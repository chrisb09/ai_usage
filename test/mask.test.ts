import { describe, expect, it } from "vitest"
import { maskAccount, sanitizeError, toPublicAccountKey } from "../src/mask.js"

describe("maskAccount", () => {
  it("masks standard emails", () => {
    expect(maskAccount("christian.brinkmann09@gmail.com")).toBe(
      "ch*******************@gmail.com",
    )
    expect(maskAccount("dulouser@googlemail.com")).toBe("du******@googlemail.com")
  })

  it("handles short emails", () => {
    expect(maskAccount("a@example.com")).toBe("*@example.com")
    expect(maskAccount("ab@example.com")).toBe("a*@example.com")
    expect(maskAccount("abc@example.com")).toBe("a**@example.com")
    expect(maskAccount("abcd@example.com")).toBe("ab**@example.com")
  })

  it("preserves trailing parenthetical suffixes", () => {
    expect(maskAccount("christian.brinkmann09@gmail.com (Codex)")).toBe(
      "ch*******************@gmail.com (Codex)",
    )
    expect(maskAccount("OpenCode Go Account (Go)")).toBe(
      "Op***************** (Go)",
    )
  })

  it("preserves keys that already contain ellipses", () => {
    expect(maskAccount("sk-…3e18 (OneProvider)")).toBe(
      "sk-…3e18 (OneProvider)",
    )
    expect(maskAccount("sk-...uqJS (VNAI Pro)")).toBe(
      "sk-...uqJS (VNAI Pro)",
    )
  })

  it("masks plain identifiers without @", () => {
    expect(maskAccount("admin")).toBe("ad***")
    expect(maskAccount("abc")).toBe("***")
  })

  it("handles falsy inputs", () => {
    expect(maskAccount("")).toBe("")
    expect(maskAccount(null as unknown as string)).toBe(null)
  })
})

describe("toPublicAccountKey", () => {
  it("creates deterministic, opaque keys without exposing emails", () => {
    const key1 = toPublicAccountKey("google:christian.brinkmann09@gmail.com")
    const key2 = toPublicAccountKey("google:christian.brinkmann09@gmail.com")
    const key3 = toPublicAccountKey("google:other@gmail.com")

    expect(key1).toBe(key2)
    expect(key1).not.toBe(key3)
    expect(key1.startsWith("google:")).toBe(true)
    expect(key1).not.toContain("christian")
    expect(key1).not.toContain("@")
  })
})

describe("sanitizeError", () => {
  it("strips server paths and masks emails", () => {
    const raw =
      "Failed to read /config/opencode/antigravity-accounts.json for user christian.brinkmann09@gmail.com"
    const sanitized = sanitizeError(raw)
    expect(sanitized).not.toContain("/config/opencode")
    expect(sanitized).not.toContain("christian.brinkmann09")
    expect(sanitized).toContain("ch*******************@gmail.com")
    expect(sanitized).toContain("[path]")
  })
})
