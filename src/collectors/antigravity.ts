import type { AppConfig } from "../config.js"
import type { AccountRef, CollectResult, Collector, Quota } from "../domain.js"
import { fetchWithTimeout } from "./http.js"
import {
  asNumber,
  asRecord,
  asString,
  clampFraction,
  earliestIso,
  errorMessage,
  errorResult,
  quotaKey,
  readJsonFile,
  successResult,
} from "./util.js"

const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLOUD_CODE_BASE = "https://daily-cloudcode-pa.googleapis.com"
const FALLBACK_PROJECT_ID = "default-cli-project"
const USER_AGENT = "antigravity/cli/1.1.13 (aidev_client; linux; amd64)"

interface AntigravityData {
  account: Record<string, unknown>
  index: number
}

interface TokenCacheEntry {
  accessToken: string
  expiresAt: number
}

export function summarizeQuotaSummary(summary: unknown): Quota[] {
  const root = asRecord(summary)
  const groups = Array.isArray(root?.groups) ? root.groups : []
  const quotas: Quota[] = []

  for (const groupValue of groups) {
    const group = asRecord(groupValue)
    const groupName = asString(group?.displayName) || asString(group?.groupName) || ""
    const lowerGroup = groupName.toLowerCase()

    let family: string
    if (lowerGroup.includes("gemini")) family = "Gemini"
    else if (lowerGroup.includes("claude") || lowerGroup.includes("gpt"))
      family = "Claude"
    else family = groupName || "Other"

    const buckets = Array.isArray(group?.buckets) ? group.buckets : []
    for (const bucketValue of buckets) {
      const bucket = asRecord(bucketValue)
      const bucketId = asString(bucket?.bucketId) || ""
      const displayName = asString(bucket?.displayName) || ""
      const window = asString(bucket?.window) || ""
      const combo = `${window} ${bucketId} ${displayName}`.toLowerCase()
      const isWeekly = combo.includes("weekly")
      const windowSec = isWeekly ? 7 * 86_400 : 5 * 3_600

      const remainingRecord = asRecord(bucket?.remaining)
      const remaining = clampFraction(
        remainingRecord?.remainingFraction ?? bucket?.remainingFraction,
      )
      const resetAt =
        asString(remainingRecord?.resetTime) ?? asString(bucket?.resetTime) ?? null
      const description = asString(bucket?.description)

      const label = `${family} — ${isWeekly ? "Weekly" : "5h"}`
      quotas.push({
        key: quotaKey(label),
        label,
        remaining,
        resetAt,
        raw: { description, modelCount: 1, window, windowSec },
      })
    }
  }

  return mergeQuotas(quotas)
}

function antigravityModelGroup(
  modelName: string,
  entry: Record<string, unknown> | null,
): string | null {
  const name =
    `${modelName} ${asString(entry?.displayName) || asString(entry?.modelName) || ""}`.toLowerCase()

  if (name.includes("claude")) return "Claude"
  if (!name.includes("gemini-3") && !name.includes("gemini 3")) return null
  return name.includes("flash") ? "Gemini 3 Flash" : "Gemini 3 Pro"
}

export function summarizeAntigravityModels(models: unknown): Quota[] {
  const root = asRecord(models)
  if (!root) return []

  const groups = new Map<string, { quota: Quota; modelCount: number }>()

  for (const [modelName, entryValue] of Object.entries(root)) {
    const entry = asRecord(entryValue)
    const name = antigravityModelGroup(modelName, entry)
    if (!name) continue

    const quotaInfo = asRecord(entry?.quotaInfo)
    const remaining = clampFraction(quotaInfo?.remainingFraction)
    const resetAt = asString(quotaInfo?.resetTime) ?? null

    const current = groups.get(name) ?? {
      quota: {
        key: quotaKey(name),
        label: name,
        remaining: null,
        resetAt: null,
        raw: { modelCount: 0 },
      },
      modelCount: 0,
    }

    current.modelCount += 1
    if (
      remaining !== null &&
      (current.quota.remaining === null || remaining > current.quota.remaining)
    ) {
      current.quota.remaining = remaining
    }
    current.quota.resetAt = earliestIso(current.quota.resetAt, resetAt)
    current.quota.raw = { modelCount: current.modelCount }
    groups.set(name, current)
  }

  return [...groups.values()].map((entry) => entry.quota)
}

function mergeQuotas(quotas: Quota[]): Quota[] {
  const merged = new Map<string, Quota>()
  for (const quota of quotas) {
    const existing = merged.get(quota.key)
    if (!existing) {
      merged.set(quota.key, { ...quota })
      continue
    }
    if (
      quota.remaining !== null &&
      (existing.remaining === null || quota.remaining < existing.remaining)
    ) {
      existing.remaining = quota.remaining
    }
    existing.resetAt = earliestIso(existing.resetAt, quota.resetAt)
    const modelCount =
      (asNumber(existing.raw?.modelCount) ?? 0) + (asNumber(quota.raw?.modelCount) ?? 0)
    existing.raw = { ...existing.raw, ...quota.raw, modelCount }
  }
  return [...merged.values()]
}

export class AntigravityCollector implements Collector {
  readonly id = "antigravity"
  readonly provider = "Google"

  private readonly tokenCache = new Map<string, TokenCacheEntry>()
  private readonly projectCache = new Map<string, string>()

  constructor(private readonly config: AppConfig) {}

  async discover(): Promise<AccountRef[]> {
    const result = await readJsonFile(this.config.paths.antigravityAccounts)
    if (!result.ok) {
      if (result.kind === "missing") return []
      return [
        {
          accountKey: "google:config",
          provider: this.provider,
          label: "Google Antigravity",
          collectorId: this.id,
          discoveryError: result.error,
        },
      ]
    }

    const root = asRecord(result.value)
    const accounts = Array.isArray(root?.accounts) ? root.accounts : null
    if (!accounts) {
      return [
        {
          accountKey: "google:config",
          provider: this.provider,
          label: "Google Antigravity",
          collectorId: this.id,
          discoveryError: "Invalid antigravity-accounts.json: missing accounts array",
        },
      ]
    }

    const refs: AccountRef[] = []
    accounts.forEach((accountValue, index) => {
      const account = asRecord(accountValue)
      if (!account) return
      if (account.enabled === false && !this.config.includeDisabled) return

      const email = asString(account.email) || `Account ${index + 1}`
      refs.push({
        accountKey: `google:${email.toLowerCase()}`,
        provider: this.provider,
        label: email,
        collectorId: this.id,
        data: { account, index } satisfies AntigravityData,
      })
    })
    return refs
  }

  async collect(ref: AccountRef): Promise<CollectResult> {
    const startedAt = Date.now()
    const finish = (result: CollectResult): CollectResult => ({
      ...result,
      durationMs: Date.now() - startedAt,
    })

    if (ref.discoveryError) {
      return errorResult(ref, ref.discoveryError, Date.now() - startedAt)
    }

    const data = ref.data as AntigravityData | undefined
    const account = data?.account
    if (!account) {
      return errorResult(ref, "Missing Antigravity account data", Date.now() - startedAt)
    }

    try {
      const refreshToken = asString(account.refreshToken)
      if (!refreshToken) throw new Error("Account has no refresh token")

      const token = await this.accessToken(ref.accountKey, refreshToken)
      const projectId = await this.resolveProjectId(ref.accountKey, account, token)
      const body = { project: projectId }

      const [summaryResult, modelsResult] = await Promise.allSettled([
        this.retrieveQuotaSummary(token, projectId),
        this.postJson(
          "fetchAvailableModels",
          token,
          body,
          USER_AGENT,
        ),
      ])

      const summaryQuotas =
        summaryResult.status === "fulfilled"
          ? summarizeQuotaSummary(summaryResult.value)
          : []
      const modelQuotas =
        modelsResult.status === "fulfilled"
          ? summarizeAntigravityModels(asRecord(modelsResult.value)?.models)
          : []
      const quotas = summaryQuotas.length > 0 ? summaryQuotas : modelQuotas

      if (quotas.length === 0) {
        const errors = [summaryResult, modelsResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => errorMessage(result.reason))
          .filter(Boolean)
        throw new Error(
          errors.length > 0
            ? errors.join("; ")
            : "No quota data returned for Antigravity account",
        )
      }

      return finish(successResult(ref, ref.label, quotas, 0))
    } catch (error) {
      return finish(errorResult(ref, errorMessage(error), 0))
    }
  }

  private async accessToken(accountKey: string, refreshToken: string): Promise<string> {
    const cached = this.tokenCache.get(accountKey)
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.accessToken
    }
    const clientSecret = this.config.antigravityClientSecret
    if (!clientSecret) throw new Error("Missing ANTIGRAVITY_CLIENT_SECRET in .env (OAuth client configuration from check_usage)")

    const response = await fetchWithTimeout(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
          client_secret: clientSecret,
        }),
      },
      this.config.requestTimeoutMs,
    )

    if (!response.ok) {
      throw new Error(`OAuth refresh failed (HTTP ${response.status})`)
    }

    const payload = asRecord(await response.json())
    const accessToken = asString(payload?.access_token)
    if (!accessToken) throw new Error("OAuth refresh returned no access token")

    const expiresIn = asNumber(payload?.expires_in) ?? 3600
    this.tokenCache.set(accountKey, {
      accessToken,
      expiresAt: Date.now() + Math.max(60, expiresIn - 120) * 1000,
    })
    return accessToken
  }

  private async resolveProjectId(
    accountKey: string,
    account: Record<string, unknown>,
    token: string,
  ): Promise<string> {
    const managedProjectId = asString(account.managedProjectId)
    if (managedProjectId) return managedProjectId

    const cached = this.projectCache.get(accountKey)
    if (cached) return cached

    try {
      const payload = asRecord(
        await this.postJson(
          "loadCodeAssist",
          token,
          {
            metadata: {
              ideType: "ANTIGRAVITY",
            },
          },
          USER_AGENT,
        ),
      )

      const direct = asString(payload?.cloudaicompanionProject)
      if (direct) {
        this.projectCache.set(accountKey, direct)
        return direct
      }

      const nested = asRecord(payload?.cloudaicompanionProject)
      const nestedId = asString(nested?.id)
      if (nestedId) {
        this.projectCache.set(accountKey, nestedId)
        return nestedId
      }
    } catch {
    }

    return asString(account.projectId) || FALLBACK_PROJECT_ID
  }

  private async retrieveQuotaSummary(
    token: string,
    projectId: string,
  ): Promise<unknown> {
    return this.postJson(
      "retrieveUserQuotaSummary",
      token,
      { project: projectId },
      USER_AGENT,
    )
  }

  private async postJson(
    action: string,
    token: string,
    body: unknown,
    userAgent: string,
  ): Promise<unknown> {
    const response = await fetchWithTimeout(
      `${CLOUD_CODE_BASE}/v1internal:${action}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        body: JSON.stringify(body),
      },
      this.config.requestTimeoutMs,
    )

    if (!response.ok) {
      throw new Error(`${action} failed (HTTP ${response.status})`)
    }

    return response.json()
  }
}
