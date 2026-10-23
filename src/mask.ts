import { createHash } from "node:crypto"

/**
 * Masks an account name or email for public display, matching check_usage.mjs
 */
export function maskAccount(name: string): string {
  if (!name || typeof name !== "string") return name

  // Handle trailing parenthetical suffixes like " (Go)" or " (Codex)"
  const suffixMatch = name.match(/^(.*?)(\s*\([^)]+\))$/)
  const core = suffixMatch ? suffixMatch[1]! : name
  const suffix = suffixMatch ? suffixMatch[2]! : ""

  let maskedCore: string
  const atIndex = core.indexOf("@")
  if (atIndex > 0) {
    const local = core.slice(0, atIndex)
    const domain = core.slice(atIndex)
    let maskedLocal: string
    if (local.length <= 1) {
      maskedLocal = "*"
    } else if (local.length <= 3) {
      maskedLocal = local[0]! + "*".repeat(local.length - 1)
    } else {
      maskedLocal = local.slice(0, 2) + "*".repeat(local.length - 2)
    }
    maskedCore = maskedLocal + domain
  } else {
    // Non-email identifier (like an API key or account name)
    if (core.includes("…") || core.includes("...")) {
      maskedCore = core
    } else if (core.length <= 3) {
      maskedCore = "*".repeat(core.length)
    } else {
      maskedCore = core.slice(0, 2) + "*".repeat(core.length - 2)
    }
  }

  return maskedCore + suffix
}

/**
 * Maps an internal accountKey to a deterministic, opaque public key
 * so internal email addresses or keys are never leaked to unauthenticated users.
 */
export function toPublicAccountKey(accountKey: string): string {
  if (!accountKey) return accountKey
  const parts = accountKey.split(":")
  const provider = parts[0] || "acc"
  const hash = createHash("sha256").update(accountKey).digest("hex").slice(0, 10)
  return `${provider}:${hash}`
}

/**
 * Sanitizes error strings by removing server file paths and masking emails.
 */
export function sanitizeError(error: string | null): string | null {
  if (!error) return null
  let sanitized = error.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    (email) => maskAccount(email),
  )
  sanitized = sanitized.replace(/(?:\/[a-zA-Z0-9._-]+)+/g, "[path]")
  return sanitized
}
