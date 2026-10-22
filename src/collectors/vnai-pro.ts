import type { AppConfig } from "../config.js"
import type { AccountRef, CollectResult, Collector, Quota } from "../domain.js"
import { fetchWithTimeout } from "./http.js"
import { asNumber, asRecord, asString, clampFraction, errorMessage, errorResult, isoDate, maskApiKey, readJsonFile, successResult } from "./util.js"

const USAGE_URL = "https://vibi.top/docs-setup/api/usage"

export function parseVnaiProPayload(data: unknown, now = new Date()): Quota[] {
  const root = asRecord(data)
  const account = asRecord(root?.account)
  const status = asString(account?.status)
  if (account?.is_valid === false || (status && status !== "active")) {
    throw new Error(`Account status: ${status || "invalid"}`)
  }
  const quota = asRecord(root?.quota)
  if (!quota) throw new Error(asString(root?.message) || asString(root?.error) || "No quota returned from VNAI Pro")

  const limit = asNumber(quota.limit)
  const balance = asNumber(quota.remaining)
  const days = asNumber(account?.days_until_expiry)
  const expiresAt = isoDate(account?.expires_at) ?? (days !== null ? isoDate(now.getTime() + days * 86_400_000) : null)
  return [{
    key: "vnai-pro",
    label: "VNAI Pro",
    remaining: limit !== null && limit > 0 && balance !== null ? clampFraction(balance / limit) : null,
    resetAt: expiresAt,
    raw: { balanceUsd: balance, quotaUsd: limit, usedUsd: asNumber(quota.used), expiresAt },
  }]
}

export class VnaiProCollector implements Collector {
  readonly id = "vnai-pro"
  readonly provider = "VNAI Pro"

  constructor(private readonly config: AppConfig) {}

  async discover(): Promise<AccountRef[]> {
    const ref: AccountRef = { accountKey: "vnai-pro:default", provider: this.provider, label: this.provider, collectorId: this.id }
    const result = await readJsonFile(this.config.paths.vnaiProAuth)
    if (!result.ok) return result.kind === "missing" ? [] : [{ ...ref, discoveryError: result.error }]
    const root = asRecord(result.value)
    const entry = asRecord(root?.vnaipro)
    const apiKey = asString(entry?.key) || asString(entry?.apiKey) || asString(root?.apiKey) || asString(root?.key)
    if (!apiKey) return []
    return [{ ...ref, label: `${maskApiKey(apiKey)} (VNAI Pro)`, data: { apiKey } }]
  }

  async collect(ref: AccountRef): Promise<CollectResult> {
    const startedAt = Date.now()
    if (ref.discoveryError) return errorResult(ref, ref.discoveryError, Date.now() - startedAt)
    const apiKey = asString(asRecord(ref.data)?.apiKey)
    if (!apiKey) return errorResult(ref, "Missing VNAI Pro API key", Date.now() - startedAt)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const response = await fetchWithTimeout(USAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
          Accept: "*/*",
          Referer: "https://vibi.top/docs-setup/en/usage",
          Origin: "https://vibi.top",
        },
        body: JSON.stringify({ apiKey, startDate: today, endDate: today }),
      }, this.config.requestTimeoutMs)
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      return successResult(ref, ref.label, parseVnaiProPayload(await response.json()), Date.now() - startedAt)
    } catch (error) {
      return errorResult(ref, errorMessage(error).replaceAll(apiKey, "[redacted]"), Date.now() - startedAt)
    }
  }
}
