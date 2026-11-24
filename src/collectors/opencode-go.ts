import type { AppConfig } from "../config.js"
import type { AccountRef, CollectResult, Collector, Quota } from "../domain.js"
import { fetchWithTimeout } from "./http.js"
import {
  asRecord,
  asString,
  clampFraction,
  errorMessage,
  errorResult,
  isoDate,
  quotaKey,
  readJsonFile,
  successResult,
} from "./util.js"

type OpenCodeGoData =
  | { mode: "console"; cookie: string; workspaceId: string }
  | { mode: "apiKey"; apiKey: string }

const USAGE_API_URL = "https://opencode.ai/inference/go/v1/usage"

function meterNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function parseOpenCodeGoStatus(data: unknown): Quota[] {
  const root = asRecord(data)
  const access = asRecord(root?.access)
  if (!access) throw new Error("No active OpenCode Go subscription access found")
  const meters = asRecord(access.meters)
  const quotas: Quota[] = []
  for (const [name, window] of [["month", "Monthly"], ["week", "Weekly"], ["fiveHour", "5h"]] as const) {
    const meter = asRecord(meters?.[name])
    if (!meter) continue
    const used = meterNumber(meter.usedMicroCents)
    const limit = meterNumber(meter.limitMicroCents)
    if ((used === null && meter.usedMicroCents != null) || limit === null) throw new Error(`Invalid OpenCode Go ${window.toLowerCase()} usage meter`)
    const label = `OpenCode Go — ${window}`
    const windowSec = name === "month" ? 30 * 86_400 : name === "week" ? 7 * 86_400 : 5 * 3_600
    quotas.push({
      key: quotaKey(label),
      label,
      remaining: used === null ? null : limit > 0 ? clampFraction((limit - used) / limit) : 0,
      resetAt: isoDate(meter.resetsAt) ?? (name === "month" ? isoDate(access.endsAt) : null),
      raw: { usedMicroCents: used, limitMicroCents: limit, windowSec },
    })
  }
  if (quotas.length === 0) throw new Error("Could not parse usage meters from OpenCode Go status")
  return quotas
}

export function parseOpenCodeGoUsage(data: unknown): Quota[] {
  const usage = asRecord(asRecord(data)?.usage)
  if (!usage) throw new Error("No usage data returned from OpenCode Go")

  const quotas: Quota[] = []
  for (const [name, window, windowSec] of [
    ["monthly", "Monthly", 30 * 86_400],
    ["weekly", "Weekly", 7 * 86_400],
    ["rolling", "5h", 5 * 3_600],
  ] as const) {
    const meter = asRecord(usage[name])
    if (!meter) continue
    const percent = meterNumber(meter.percent)
    if (percent === null || percent > 100) {
      throw new Error(`Invalid OpenCode Go ${window.toLowerCase()} usage meter`)
    }
    const label = `OpenCode Go — ${window}`
    quotas.push({
      key: quotaKey(label),
      label,
      remaining: clampFraction(1 - percent / 100),
      resetAt: isoDate(meter.resetsAt),
      raw: { usedPercent: percent, status: asString(meter.status), windowSec },
    })
  }
  if (quotas.length === 0) {
    throw new Error("Could not parse usage meters from OpenCode Go usage response")
  }
  return quotas
}

export function openCodeGoCookie(config: Record<string, unknown> | null): string {
  const cookie = asString(config?.cookie)
  if (cookie) return cookie
  const authCookie = asString(config?.authCookie)
  const consoleSession = asString(config?.consoleSession)
  const parts: string[] = []
  if (authCookie) {
    parts.push(authCookie.includes("=") || authCookie.includes(";")
      ? authCookie
      : `${authCookie.startsWith("st_") ? "__Host-console_session" : "auth"}=${authCookie}`)
  }
  if (consoleSession && !parts.some((part) => part.includes("__Host-console_session="))) {
    parts.push(consoleSession.startsWith("__Host-console_session=") ? consoleSession : `__Host-console_session=${consoleSession}`)
  }
  return parts.join("; ")
}

export class OpenCodeGoCollector implements Collector {
  readonly id = "opencode-go"
  readonly provider = "OpenCode Go"

  constructor(private readonly config: AppConfig) {}

  async discover(): Promise<AccountRef[]> {
    const result = await readJsonFile(this.config.paths.opencodeGoConfig)
    if (!result.ok) {
      if (result.kind === "missing") {
        const auth = await readJsonFile(this.config.paths.opencodeAuth)
        if (!auth.ok || !asRecord(asRecord(auth.value)?.["opencode-go"])) return []
        return [{
          accountKey: "opencode-go:default", provider: this.provider, label: this.provider, collectorId: this.id,
          discoveryError:
            "Missing OpenCode Go config. Add an apiKey with Usage: Read, or a console session cookie and workspaceId/orgId in opencode-go.json.",
        }]
      }
      return [
        {
          accountKey: "opencode-go:default",
          provider: this.provider,
          label: "OpenCode Go",
          collectorId: this.id,
          discoveryError: result.error,
        },
      ]
    }

    const root = asRecord(result.value)
    const email = asString(root?.email) || "OpenCode Go Account"
    const label = `${email} (Go)`
    const apiKey =
      asString(root?.apiKey)?.trim() || asString(root?.accessToken)?.trim()

    if (apiKey) {
      return [
        {
          accountKey: "opencode-go:default",
          provider: this.provider,
          label,
          collectorId: this.id,
          data: { mode: "apiKey", apiKey } satisfies OpenCodeGoData,
        },
      ]
    }

    const cookie = openCodeGoCookie(root)
    const workspaceId = asString(root?.workspaceId) || asString(root?.orgId) || ""

    if (!cookie || !workspaceId) {
      return [
        {
          accountKey: "opencode-go:default",
          provider: this.provider,
          label,
          collectorId: this.id,
          discoveryError:
            "Missing apiKey, or authCookie/consoleSession and workspaceId/orgId in opencode-go.json",
        },
      ]
    }

    return [
      {
        accountKey: "opencode-go:default",
        provider: this.provider,
        label,
        collectorId: this.id,
        data: {
          mode: "console",
          cookie,
          workspaceId,
        } satisfies OpenCodeGoData,
      },
    ]
  }

  async collect(ref: AccountRef): Promise<CollectResult> {
    const startedAt = Date.now()
    if (ref.discoveryError) {
      return errorResult(ref, ref.discoveryError, Date.now() - startedAt)
    }

    const data = ref.data as OpenCodeGoData | undefined
    if (!data) {
      return errorResult(ref, "Missing OpenCode Go config", Date.now() - startedAt)
    }

    const secret = data.mode === "apiKey" ? data.apiKey : data.cookie
    try {
      const quotas =
        data.mode === "apiKey"
          ? await this.collectApiKey(data.apiKey)
          : await this.collectConsole(data.cookie, data.workspaceId)
      return successResult(ref, ref.label, quotas, Date.now() - startedAt)
    } catch (error) {
      return errorResult(
        ref,
        errorMessage(error).replaceAll(secret, "[redacted]"),
        Date.now() - startedAt,
      )
    }
  }

  private async collectApiKey(apiKey: string): Promise<Quota[]> {
    const response = await fetchWithTimeout(
      USAGE_API_URL,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": "ai-usage/0.1",
        },
      },
      this.config.requestTimeoutMs,
    )

    if (response.status === 401) {
      throw new Error(
        "OpenCode Go API key is invalid or expired (check apiKey in opencode-go.json)",
      )
    }
    if (response.status === 403) {
      throw new Error(
        "OpenCode Go API key is not covered by an active Go subscription (or lacks Usage: Read)",
      )
    }
    if (response.redirected) {
      throw new Error(
        "OpenCode Go usage request was redirected; check apiKey in opencode-go.json",
      )
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    return parseOpenCodeGoUsage(await response.json())
  }

  private async collectConsole(
    cookie: string,
    workspaceId: string,
  ): Promise<Quota[]> {
    const response = await fetchWithTimeout(
      "https://opencode.ai/console/api/go/status",
      {
        headers: {
          Cookie: cookie,
          "x-org-id": workspaceId,
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
      this.config.requestTimeoutMs,
    )

    if (
      response.status === 401 ||
      response.status === 403 ||
      response.redirected
    ) {
      throw new Error(
        "Session expired or unauthorized (check authCookie / __Host-console_session)",
      )
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    return parseOpenCodeGoStatus(await response.json())
  }
}
