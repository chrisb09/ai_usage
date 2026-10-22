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

interface OpenCodeGoData {
  cookie: string
  workspaceId: string
  email: string
}

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
    const used = meterNumber(meter.usedMicroCents ?? 0)
    const limit = meterNumber(meter.limitMicroCents)
    if (used === null || limit === null) throw new Error(`Invalid OpenCode Go ${window.toLowerCase()} usage meter`)
    const label = `OpenCode Go — ${window}`
    quotas.push({
      key: quotaKey(label),
      label,
      remaining: limit > 0 ? clampFraction((limit - used) / limit) : 0,
      resetAt: isoDate(meter.resetsAt) ?? (name === "month" ? isoDate(access.endsAt) : null),
      raw: { usedMicroCents: used, limitMicroCents: limit },
    })
  }
  if (quotas.length === 0) throw new Error("Could not parse usage meters from OpenCode Go status")
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
          discoveryError: "Missing OpenCode Go console session cookie and workspaceId/orgId in opencode-go.json. The inference API key cannot access subscription usage meters.",
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
    const cookie = openCodeGoCookie(root)
    const workspaceId = asString(root?.workspaceId) || asString(root?.orgId) || ""
    const email = asString(root?.email) || "OpenCode Go Account"

    if (!cookie || !workspaceId) {
      return [
        {
          accountKey: "opencode-go:default",
          provider: this.provider,
          label: email,
          collectorId: this.id,
          discoveryError: "Missing authCookie/consoleSession or workspaceId/orgId in opencode-go.json",
        },
      ]
    }

    return [
      {
        accountKey: "opencode-go:default",
        provider: this.provider,
        label: `${email} (Go)`,
        collectorId: this.id,
        data: {
          cookie,
          workspaceId,
          email,
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

    try {
      const response = await fetchWithTimeout(
        "https://opencode.ai/console/api/go/status",
        {
          headers: {
            Cookie: data.cookie,
            "x-org-id": data.workspaceId,
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
        throw new Error("Session expired or unauthorized (check authCookie / __Host-console_session)")
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      const quotas = parseOpenCodeGoStatus(await response.json())

      return successResult(
        ref,
        `${data.email} (Go)`,
        quotas,
        Date.now() - startedAt,
      )
    } catch (error) {
      return errorResult(ref, errorMessage(error).replaceAll(data.cookie, "[redacted]"), Date.now() - startedAt)
    }
  }
}
