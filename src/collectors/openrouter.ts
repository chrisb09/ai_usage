import type { AppConfig } from "../config.js"
import type { AccountRef, CollectResult, Collector, Quota } from "../domain.js"
import { fetchWithTimeout } from "./http.js"
import {
  asNumber,
  asRecord,
  asString,
  clampFraction,
  errorMessage,
  errorResult,
  maskApiKey,
  quotaKey,
  readJsonFile,
  successResult,
} from "./util.js"

const CREDITS_URL = "https://openrouter.ai/api/v1/credits"
const KEY_URL = "https://openrouter.ai/api/v1/key"

interface OpenRouterData {
  apiKey: string
  managementKey?: string
}

function payloadError(data: unknown, fallback: string): string {
  const root = asRecord(data)
  const error = asRecord(root?.error)
  return (
    asString(error?.message) ||
    asString(root?.message) ||
    asString(root?.error) ||
    fallback
  )
}

export function parseOpenRouterCredits(data: unknown): Quota {
  const root = asRecord(data)
  const payload = asRecord(root?.data)
  if (!payload) {
    throw new Error(payloadError(data, "No credits returned from OpenRouter"))
  }

  const total = asNumber(payload.total_credits)
  const used = asNumber(payload.total_usage)
  if (total === null || used === null) {
    throw new Error("Invalid OpenRouter credits payload")
  }

  const balance = Math.max(0, total - used)
  return {
    key: quotaKey("OpenRouter"),
    label: "OpenRouter",
    remaining: total > 0 ? clampFraction(balance / total) : null,
    resetAt: null,
    raw: { balanceUsd: balance, quotaUsd: total, usedUsd: used },
  }
}

export function parseOpenRouterKey(data: unknown): Quota {
  const root = asRecord(data)
  const payload = asRecord(root?.data)
  if (!payload) {
    throw new Error(payloadError(data, "No key data returned from OpenRouter"))
  }

  const limit = asNumber(payload.limit)
  const limitRemaining = asNumber(payload.limit_remaining)
  const usage = asNumber(payload.usage) ?? 0

  if (limit !== null && limitRemaining !== null) {
    return {
      key: quotaKey("OpenRouter"),
      label: "OpenRouter",
      remaining: limit > 0 ? clampFraction(limitRemaining / limit) : 0,
      resetAt: null,
      raw: {
        balanceUsd: limitRemaining,
        quotaUsd: limit,
        usedUsd: usage,
      },
    }
  }

  return {
    key: quotaKey("OpenRouter"),
    label: "OpenRouter",
    remaining: null,
    resetAt: null,
    raw: { usedUsd: usage, unlimited: true },
  }
}

async function responseError(
  response: { json: () => Promise<unknown> },
  fallback: string,
): Promise<string> {
  try {
    return payloadError(await response.json(), fallback)
  } catch {
    return fallback
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  }
}

function redact(message: string, keys: string[]): string {
  return keys.reduce((result, key) => result.replaceAll(key, "[redacted]"), message)
}

export class OpenRouterCollector implements Collector {
  readonly id = "openrouter"
  readonly provider = "OpenRouter"

  constructor(private readonly config: AppConfig) {}

  async discover(): Promise<AccountRef[]> {
    const ref: AccountRef = {
      accountKey: "openrouter:default",
      provider: this.provider,
      label: this.provider,
      collectorId: this.id,
    }
    const result = await readJsonFile(this.config.paths.opencodeAuth)
    if (!result.ok) {
      return result.kind === "missing" ? [] : [{ ...ref, discoveryError: result.error }]
    }

    const root = asRecord(result.value)
    const entry = asRecord(root?.openrouter)
    const managementEntry = asRecord(root?.["openrouter-management"])
    const apiKey =
      asString(entry?.key) ||
      asString(entry?.apiKey) ||
      asString(managementEntry?.key) ||
      asString(managementEntry?.apiKey)
    const managementKey =
      asString(managementEntry?.key) || asString(managementEntry?.apiKey)

    if (!apiKey) return []

    return [
      {
        ...ref,
        label: `${maskApiKey(apiKey)} (OpenRouter)`,
        data: {
          apiKey,
          managementKey: managementKey && managementKey !== apiKey ? managementKey : undefined,
        } satisfies OpenRouterData,
      },
    ]
  }

  async collect(ref: AccountRef): Promise<CollectResult> {
    const startedAt = Date.now()
    if (ref.discoveryError) {
      return errorResult(ref, ref.discoveryError, Date.now() - startedAt)
    }

    const data = ref.data as OpenRouterData | undefined
    if (!data?.apiKey) {
      return errorResult(ref, "Missing OpenRouter API key", Date.now() - startedAt)
    }

    const keys = [data.managementKey, data.apiKey].filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    )

    try {
      for (const key of [...new Set(keys)]) {
        const credits = await fetchWithTimeout(
          CREDITS_URL,
          { headers: authHeaders(key) },
          this.config.requestTimeoutMs,
        )
        if (credits.ok) {
          return successResult(
            ref,
            ref.label,
            [parseOpenRouterCredits(await credits.json())],
            Date.now() - startedAt,
          )
        }
      }

      const response = await fetchWithTimeout(
        KEY_URL,
        { headers: authHeaders(data.apiKey) },
        this.config.requestTimeoutMs,
      )
      if (!response.ok) {
        throw new Error(
          await responseError(
            response,
            `HTTP ${response.status} ${response.statusText}`,
          ),
        )
      }

      return successResult(
        ref,
        ref.label,
        [parseOpenRouterKey(await response.json())],
        Date.now() - startedAt,
        "Account-wide credits are unavailable; showing this API key's usage instead.",
      )
    } catch (error) {
      return errorResult(
        ref,
        redact(errorMessage(error), keys),
        Date.now() - startedAt,
      )
    }
  }
}
