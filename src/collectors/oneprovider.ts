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
  isoDate,
  maskApiKey,
  quotaKey,
  readJsonFile,
  successResult,
} from "./util.js"

const LOOKUP_BASE = "https://dashboard.oneprovider.dev"

interface OneProviderData {
  apiKey: string
}

export function parseOneProviderPayload(data: unknown): {
  label: string
  quotas: Quota[]
} {
  const root = asRecord(data)
  if (!root) return { label: "OneProvider", quotas: [] }

  if (root.status !== "ok") {
    const reason = asString(root.reason)
    throw new Error(reason || `Lookup returned status "${String(root.status)}"`)
  }

  const snapshot = asRecord(root.snapshot)
  const keyInfo = asRecord(root.key)
  const label = asString(keyInfo?.masked) || "OneProvider"

  if (!snapshot) return { label, quotas: [] }

  const used = asNumber(snapshot.quota_used_usd) ?? asNumber(snapshot.quota_used_usd_raw) ?? 0
  const total = asNumber(keyInfo?.initial_balance_usd) ?? asNumber(snapshot.quota_usd) ?? asNumber(snapshot.quota_usd_raw) ?? 0
  const expiresAt = isoDate(keyInfo?.expires_at)
  const balance =
    asNumber(snapshot.balance_usd) ?? asNumber(snapshot.balance_usd_raw) ?? Math.max(0, total - used)
  const remaining = total > 0 ? balance / total : null

  return {
    label,
    quotas: [
      {
        key: quotaKey("OneProvider"),
        label: "OneProvider",
        remaining: clampFraction(remaining),
        resetAt: expiresAt,
        raw: {
          balanceUsd: balance,
          quotaUsd: total,
          usedUsd: Math.max(0, total - balance),
          expiresAt,
          isActive:
            typeof keyInfo?.is_active === "boolean" ? keyInfo.is_active : null,
          baseUrl: asString(keyInfo?.base_url),
        },
      },
    ],
  }
}

export class OneProviderCollector implements Collector {
  readonly id = "oneprovider"
  readonly provider = "OneProvider"

  constructor(private readonly config: AppConfig) {}

  async discover(): Promise<AccountRef[]> {
    let result = await readJsonFile(this.config.paths.oneProviderConfig)
    let sharedAuth = false
    if (!result.ok && result.kind === "missing") {
      result = await readJsonFile(this.config.paths.opencodeAuth)
      sharedAuth = true
    }
    if (!result.ok) {
      if (result.kind === "missing") return []
      return [
        {
          accountKey: "oneprovider:default",
          provider: this.provider,
          label: "OneProvider",
          collectorId: this.id,
          discoveryError: result.error,
        },
      ]
    }

    const auth = asRecord(result.value)
    const root = sharedAuth ? asRecord(auth?.oneprovider) : auth
    if (sharedAuth && !root) return []
    const apiKey = asString(root?.apiKey) || asString(root?.key) || ""
    if (!apiKey) {
      return [
        {
          accountKey: "oneprovider:default",
          provider: this.provider,
          label: "OneProvider",
          collectorId: this.id,
          discoveryError: sharedAuth ? "Missing key in the OneProvider auth entry" : "Missing apiKey in oneprovider.json",
        },
      ]
    }

    return [
      {
        accountKey: "oneprovider:default",
        provider: this.provider,
        label: `${maskApiKey(apiKey)} (OneProvider)`,
        collectorId: this.id,
        data: { apiKey } satisfies OneProviderData,
      },
    ]
  }

  async collect(ref: AccountRef): Promise<CollectResult> {
    const startedAt = Date.now()
    if (ref.discoveryError) {
      return errorResult(ref, ref.discoveryError, Date.now() - startedAt)
    }

    const data = ref.data as OneProviderData | undefined
    if (!data) {
      return errorResult(ref, "Missing OneProvider config", Date.now() - startedAt)
    }

    try {
      const response = await fetchWithTimeout(
        `${LOOKUP_BASE}/api/dashboard/lookup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "ai-usage/0.1",
          },
          body: JSON.stringify({ key_value: data.apiKey, days: 0, live: true }),
        },
        this.config.requestTimeoutMs,
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      const parsed = parseOneProviderPayload(await response.json())
      if (parsed.quotas.length === 0) {
        throw new Error("Lookup returned no snapshot")
      }

      return successResult(
        ref,
        `${parsed.label} (OneProvider)`,
        parsed.quotas,
        Date.now() - startedAt,
      )
    } catch (error) {
      return errorResult(ref, errorMessage(error).replaceAll(data.apiKey, "[redacted]"), Date.now() - startedAt)
    }
  }
}
