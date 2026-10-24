import { rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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
  quotaKey,
  readJsonFile,
  successResult,
} from "./util.js"

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const CODEX_REFRESH_URL = "https://auth.openai.com/oauth/token"
const DEFAULT_CLIENT_IDS = [
  "app_69a1d78e929881919bba0dbda1f6436d",
  "app_EMoamEEZ73f0CkXaXp7hrann",
]

interface CodexData {
  accessToken: string
  refreshToken: string | null
  accountId: string
  email: string | null
}

interface TokenCacheEntry {
  accessToken: string
  expiresAt: number
}

interface RefreshResult {
  accessToken: string
  refreshToken: string
  idToken: string | null
  warning: string | null
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1]
  if (!payload) return null
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8")
    return asRecord(JSON.parse(json) as unknown)
  } catch {
    return null
  }
}

export function decodeJwtExp(token: string): number | null {
  const payload = decodeJwtPayload(token)
  const exp = asNumber(payload?.exp)
  return exp
}

export function decodeEmailFromIdToken(idToken: string): string | null {
  return asString(decodeJwtPayload(idToken)?.email)
}

export function needsRefresh(
  accessToken: string | null,
  now: Date,
  skewSec: number,
): boolean {
  if (!accessToken) return true
  const exp = decodeJwtExp(accessToken)
  if (exp === null) return false
  return exp * 1000 <= now.getTime() + skewSec * 1000
}

export function buildUpdatedAuth(
  current: Record<string, unknown>,
  update: { accessToken: string; refreshToken: string | null; idToken: string | null },
  now: Date,
): Record<string, unknown> {
  const tokens = { ...(asRecord(current.tokens) ?? {}) }
  tokens.access_token = update.accessToken
  if (update.refreshToken) tokens.refresh_token = update.refreshToken
  if (update.idToken) tokens.id_token = update.idToken
  return {
    ...current,
    tokens,
    last_refresh: now.toISOString(),
  }
}

function windowLabel(seconds: unknown): string {
  if (typeof seconds !== "number") return "Primary"
  if (seconds >= 604_800) return "Weekly"
  if (seconds >= 86_400) return "Daily"
  if (seconds >= 18_000) return "5h"
  if (seconds >= 3_600) return "Hourly"
  if (seconds >= 1_800) return "30m"
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`
  return "Primary"
}

function windowResetAt(
  window: Record<string, unknown> | null,
  now: Date,
): string | null {
  if (!window) return null
  const resetAt = asNumber(window.reset_at)
  if (resetAt !== null) return new Date(resetAt * 1000).toISOString()
  const resetAfter = asNumber(window.reset_after_seconds)
  if (resetAfter !== null) return new Date(now.getTime() + resetAfter * 1000).toISOString()
  return null
}

export function parseCodexUsage(data: unknown, now = new Date()): Quota[] {
  const root = asRecord(data)
  const rateLimit = asRecord(root?.rate_limit)
  if (!rateLimit) return []

  const quotas: Quota[] = []
  const usedKeys = new Set<string>()

  const addWindow = (
    windowValue: unknown,
    role: "primary" | "secondary",
  ): void => {
    const window = asRecord(windowValue)
    if (!window) return

    const label = `Codex — ${windowLabel(window.limit_window_seconds)}`
    let key = quotaKey(label)
    if (usedKeys.has(key)) key = `${key}-${role}`
    usedKeys.add(key)

    const usedPercent = asNumber(window.used_percent) ?? 0
    const windowSec = asNumber(window.limit_window_seconds)
    quotas.push({
      key,
      label,
      remaining: clampFraction((100 - usedPercent) / 100),
      resetAt: windowResetAt(window, now),
      raw: {
        window: label,
        windowSec,
        usedPercent,
        resetAfterSeconds: asNumber(window.reset_after_seconds),
      },
    })
  }

  addWindow(rateLimit.primary_window, "primary")
  addWindow(rateLimit.secondary_window, "secondary")

  return quotas
}

export class CodexCollector implements Collector {
  readonly id = "codex"
  readonly provider = "Codex"

  private readonly tokenCache = new Map<string, TokenCacheEntry>()

  constructor(private readonly config: AppConfig) {}

  async discover(): Promise<AccountRef[]> {
    const result = await readJsonFile(this.config.paths.codexAuth)
    if (!result.ok) {
      if (result.kind === "missing") return []
      return [
        {
          accountKey: "codex:default",
          provider: this.provider,
          label: "Codex",
          collectorId: this.id,
          discoveryError: result.error,
        },
      ]
    }

    const root = asRecord(result.value)
    const tokens = asRecord(root?.tokens)
    const accessToken = asString(tokens?.access_token) || ""
    const refreshToken = asString(tokens?.refresh_token)
    const accountId = asString(tokens?.account_id) || ""
    const idToken = asString(tokens?.id_token)
    const email = idToken ? decodeEmailFromIdToken(idToken) : null
    const label = `${email || accountId || "Codex"} (Codex)`

    if (!accountId || (!accessToken && !refreshToken)) {
      return [
        {
          accountKey: "codex:default",
          provider: this.provider,
          label,
          collectorId: this.id,
          discoveryError:
            "Missing Codex credentials in auth.json (run `codex login`)",
        },
      ]
    }

    return [
      {
        accountKey: "codex:default",
        provider: this.provider,
        label,
        collectorId: this.id,
        data: { accessToken, refreshToken, accountId, email } satisfies CodexData,
      },
    ]
  }

  async collect(ref: AccountRef): Promise<CollectResult> {
    const startedAt = Date.now()
    if (ref.discoveryError) {
      return errorResult(ref, ref.discoveryError, Date.now() - startedAt)
    }

    const data = ref.data as CodexData | undefined
    if (!data) {
      return errorResult(ref, "Missing Codex auth data", Date.now() - startedAt)
    }

    let warning: string | null = null

    try {
      const current = await this.reload(data)
      const token = await this.accessToken(ref.accountKey, current)
      warning = token.warning

      let response = await this.fetchUsage(token.accessToken, current.accountId)
      if (response.status === 401 || response.status === 403) {
        this.tokenCache.delete(ref.accountKey)
        const forced = await this.forceRefresh(ref.accountKey, current)
        warning = forced.warning
        response = await this.fetchUsage(forced.accessToken, current.accountId)
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error("Codex auth expired (run `codex login`)")
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      const quotas = parseCodexUsage(await response.json())
      if (quotas.length === 0) {
        throw new Error("No rate_limit in Codex usage response")
      }

      return successResult(
        ref,
        `${current.email || current.accountId} (Codex)`,
        quotas,
        Date.now() - startedAt,
        warning,
      )
    } catch (error) {
      return errorResult(ref, errorMessage(error), Date.now() - startedAt, warning)
    }
  }

  private async reload(data: CodexData): Promise<CodexData> {
    const result = await readJsonFile(this.config.paths.codexAuth)
    if (!result.ok) return data

    const root = asRecord(result.value)
    const tokens = asRecord(root?.tokens)
    const idToken = asString(tokens?.id_token)
    return {
      accessToken: asString(tokens?.access_token) || "",
      refreshToken: asString(tokens?.refresh_token),
      accountId: asString(tokens?.account_id) || data.accountId,
      email: idToken ? decodeEmailFromIdToken(idToken) : data.email,
    }
  }

  private async accessToken(
    accountKey: string,
    data: CodexData,
  ): Promise<{ accessToken: string; warning: string | null }> {
    const cached = this.tokenCache.get(accountKey)
    if (
      cached &&
      cached.expiresAt > Date.now() + 60_000 &&
      (!data.accessToken || cached.accessToken === data.accessToken)
    ) {
      return { accessToken: cached.accessToken, warning: null }
    }

    const now = new Date()
    if (!needsRefresh(data.accessToken, now, this.config.codexRefreshSkewSec)) {
      this.cacheToken(accountKey, data.accessToken)
      return { accessToken: data.accessToken, warning: null }
    }

    return this.forceRefresh(accountKey, data)
  }

  private async forceRefresh(
    accountKey: string,
    data: CodexData,
  ): Promise<{ accessToken: string; warning: string | null }> {
    if (!this.config.codexRefresh) {
      throw new Error("Codex access token expired and refresh is disabled")
    }
    if (!data.refreshToken) {
      throw new Error("Codex refresh token missing (run `codex login`)")
    }

    const refreshed = await this.requestRefresh(data.refreshToken)
    const persisted = await this.persist(accountKey, data, refreshed)
    this.cacheToken(accountKey, persisted.accessToken)
    return { accessToken: persisted.accessToken, warning: persisted.warning }
  }

  private async requestRefresh(refreshToken: string): Promise<{
    accessToken: string
    refreshToken: string
    idToken: string | null
  }> {
    const clientIds = [
      this.config.codexClientId,
      process.env.CODEX_CLIENT_ID,
      ...DEFAULT_CLIENT_IDS,
    ].filter((value, index, list): value is string => {
      return Boolean(value) && list.indexOf(value) === index
    })

    let lastError = "unknown error"
    for (const clientId of clientIds) {
      const response = await fetchWithTimeout(
        process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || CODEX_REFRESH_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: refreshToken,
          }),
        },
        this.config.requestTimeoutMs,
      )

      if (response.ok) {
        const payload = asRecord(await response.json())
        const accessToken = asString(payload?.access_token)
        if (!accessToken) {
          throw new Error("Codex token refresh returned no access token")
        }
        return {
          accessToken,
          refreshToken: asString(payload?.refresh_token) || refreshToken,
          idToken: asString(payload?.id_token),
        }
      }

      let code: string | null = null
      let description: string | null = null
      try {
        const body = asRecord(await response.json())
        code = asString(body?.error)
        description = asString(body?.error_description)
      } catch {
        code = null
      }

      lastError = `HTTP ${response.status}${code ? ` (${code})` : ""}`
      if (description) lastError = `${lastError}: ${description}`

      if (code && code !== "invalid_client") break
    }

    throw new Error(
      `Codex token refresh failed (${lastError}). Run \`codex login\` to sign in again.`,
    )
  }

  private async persist(
    accountKey: string,
    expected: CodexData,
    refreshed: { accessToken: string; refreshToken: string; idToken: string | null },
  ): Promise<{ accessToken: string; warning: string | null }> {
    const result = await readJsonFile(this.config.paths.codexAuth)
    if (!result.ok) {
      return {
        accessToken: refreshed.accessToken,
        warning: "Codex token refreshed but auth.json could not be read back",
      }
    }

    const current = asRecord(result.value) ?? {}
    const tokens = asRecord(current.tokens) ?? {}
    const storedRefresh = asString(tokens.refresh_token)
    const storedAccess = asString(tokens.access_token)

    if (expected.refreshToken && storedRefresh && storedRefresh !== expected.refreshToken) {
      if (storedAccess) this.cacheToken(accountKey, storedAccess)
      return {
        accessToken: storedAccess || refreshed.accessToken,
        warning: null,
      }
    }

    const updated = buildUpdatedAuth(
      current,
      {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        idToken: refreshed.idToken,
      },
      new Date(),
    )

    const authPath = this.config.paths.codexAuth
    const tmpPath = join(dirname(authPath), `.auth.json.tmp-${process.pid}-${Date.now()}`)

    try {
      const mode = await stat(authPath)
        .then((info) => info.mode & 0o777)
        .catch(() => 0o600)
      await writeFile(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, { mode })
      await rename(tmpPath, authPath)
      return { accessToken: refreshed.accessToken, warning: null }
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined)
      return {
        accessToken: refreshed.accessToken,
        warning: `Codex token refreshed in memory but could not be saved (${errorMessage(
          error,
        )}); mount the Codex directory writable to persist it`,
      }
    }
  }

  private cacheToken(accountKey: string, accessToken: string): void {
    const exp = decodeJwtExp(accessToken)
    this.tokenCache.set(accountKey, {
      accessToken,
      expiresAt: exp !== null ? exp * 1000 : Date.now() + 600_000,
    })
  }

  private fetchUsage(accessToken: string, accountId: string) {
    return fetchWithTimeout(
      CODEX_USAGE_URL,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-Id": accountId,
          "User-Agent": "codex-cli",
        },
      },
      this.config.requestTimeoutMs,
    )
  }
}
