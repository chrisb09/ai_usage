import { readFile } from "node:fs/promises"
import type { AccountRef, CollectResult } from "../domain.js"
import { slugify } from "../policy.js"

export function clampFraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null
}

export function earliestIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  const aMs = Date.parse(a)
  const bMs = Date.parse(b)
  if (!Number.isFinite(aMs)) return b
  if (!Number.isFinite(bMs)) return a
  return aMs <= bMs ? a : b
}

export function quotaKey(label: string): string {
  return slugify(label)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function errorResult(
  ref: AccountRef,
  error: string,
  durationMs: number,
  warning: string | null = null,
): CollectResult {
  return {
    accountKey: ref.accountKey,
    provider: ref.provider,
    label: ref.label,
    quotas: [],
    error,
    warning,
    durationMs,
  }
}

export function successResult(
  ref: AccountRef,
  label: string,
  quotas: CollectResult["quotas"],
  durationMs: number,
  warning: string | null = null,
): CollectResult {
  return {
    accountKey: ref.accountKey,
    provider: ref.provider,
    label,
    quotas,
    error: null,
    warning,
    durationMs,
  }
}

export type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: "missing" }
  | { ok: false; kind: "error"; error: string }

export async function readJsonFile(path: string): Promise<JsonReadResult> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, kind: "missing" }
    }
    return {
      ok: false,
      kind: "error",
      error: `Could not read ${path}: ${errorMessage(error)}`,
    }
  }

  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false, kind: "error", error: `Invalid JSON in ${path}` }
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "Configured key"
  return `${key.startsWith("sk-") ? "sk-" : key.slice(0, 3)}…${key.slice(-4)}`
}

export function isoDate(value: unknown): string | null {
  if (typeof value === "string") {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000
    return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null
  }
  return null
}
