import { execFile } from "node:child_process"
import { rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AppConfig } from "../config.js"
import type { AccountRef, CollectResult, Collector, Quota } from "../domain.js"
import {
  asNumber,
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

const USAGE_URL =
  "https://chat.mistral.ai/api/code-trpc/apiKey.getUsage?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%7D"
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0"
const STATUS_SENTINEL = "__AI_USAGE_HTTP_STATUS__"

export interface CurlRunResult {
  status: number
  body: string
}

export type CurlRunner = (args: string[], timeoutMs: number) => Promise<CurlRunResult>

function execRunner(binary: string): CurlRunner {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        args,
        { timeout: timeoutMs + 5_000, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const marker = stdout.lastIndexOf(STATUS_SENTINEL)
          if (marker === -1) {
            const detail = error?.message || stderr.trim() || "no response"
            if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
              reject(new Error(`curl-impersonate binary not found at ${binary}`))
            } else {
              reject(new Error(`curl-impersonate failed: ${detail}`))
            }
            return
          }
          const status = Number(stdout.slice(marker + STATUS_SENTINEL.length).trim())
          resolve({
            status: Number.isFinite(status) ? status : 0,
            body: stdout.slice(0, marker),
          })
        },
      )
    })
}

export function parseMistralUsage(data: unknown): Quota {
  const entry = asRecord(Array.isArray(data) ? data[0] : data)
  const result = asRecord(entry?.result)
  const payload = asRecord(asRecord(result?.data)?.json)
  if (!payload) {
    throw new Error("No usage data returned from Mistral")
  }

  const used = asNumber(payload.usagePercentage)
  if (used === null) {
    throw new Error("Invalid Mistral usage payload")
  }

  return {
    key: quotaKey("Mistral Code"),
    label: "Mistral Code — Monthly",
    remaining: clampFraction(1 - used / 100),
    resetAt: isoDate(payload.resetAt),
    raw: {
      usagePercent: Math.round(used * 100) / 100,
      paygEnabled: payload.paygEnabled === true,
    },
  }
}

interface MistralCodeData {
  cookie: string
}

export async function persistMistralCookie(
  path: string,
  cookie: string,
): Promise<string | null> {
  const existing = await readJsonFile(path)
  if (!existing.ok && existing.kind === "error") {
    return existing.error
  }
  const current = existing.ok ? (asRecord(existing.value) ?? {}) : {}

  const updated = { ...current, orySessionCookie: cookie }
  const tmpPath = join(path, "..", `.mistral.json.tmp-${process.pid}-${Date.now()}`)
  try {
    const mode = await stat(path)
      .then((info) => info.mode & 0o777)
      .catch(() => 0o600)
    await writeFile(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, { mode })
    await rename(tmpPath, path)
    return null
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    return errorMessage(error)
  }
}

export class MistralCodeCollector implements Collector {
  readonly id = "mistral-code"
  readonly provider = "Mistral Code"
  private readonly run: CurlRunner

  constructor(
    private readonly config: AppConfig,
    run?: CurlRunner,
  ) {
    this.run = run ?? execRunner(config.curlImpersonatePath)
  }

  async discover(): Promise<AccountRef[]> {
    const ref: AccountRef = {
      accountKey: "mistral-code:default",
      provider: this.provider,
      label: this.provider,
      collectorId: this.id,
    }
    const result = await readJsonFile(this.config.paths.mistralCodeConfig)
    if (!result.ok) {
      return result.kind === "missing" ? [] : [{ ...ref, discoveryError: result.error }]
    }

    const root = asRecord(result.value)
    const cookie = asString(root?.orySessionCookie) || asString(root?.cookie)
    if (!cookie) {
      return [
        {
          ...ref,
          discoveryError:
            "Missing orySessionCookie in mistral.json. Copy the ory_session_* cookie from a logged-in chat.mistral.ai browser session.",
        },
      ]
    }

    return [{ ...ref, data: { cookie } satisfies MistralCodeData }]
  }

  async collect(
    ref: AccountRef,
    options: { reloadFromDisk?: boolean } = {},
  ): Promise<CollectResult> {
    const startedAt = Date.now()
    if (ref.discoveryError) {
      return errorResult(ref, ref.discoveryError, Date.now() - startedAt)
    }

    const data = ref.data as MistralCodeData | undefined
    if (!data?.cookie && !options.reloadFromDisk) {
      return errorResult(ref, "Missing Mistral session cookie", Date.now() - startedAt)
    }

    // The browser addon may have rotated the cookie file after discovery;
    // prefer the freshest value from disk unless the caller is testing a
    // specific candidate cookie.
    let cookie = data?.cookie ?? ""
    if (options.reloadFromDisk) {
      const result = await readJsonFile(this.config.paths.mistralCodeConfig)
      if (result.ok) {
        const root = asRecord(result.value)
        cookie =
          asString(root?.orySessionCookie) || asString(root?.cookie) || cookie
      }
    }
    if (!cookie) {
      return errorResult(ref, "Missing Mistral session cookie", Date.now() - startedAt)
    }

    const timeoutSec = Math.max(1, Math.ceil(this.config.requestTimeoutMs / 1000))
    const args = [
      "--impersonate",
      this.config.curlImpersonateTarget,
      "-s",
      "--compressed",
      "--max-time",
      String(timeoutSec),
      "-w",
      `\n${STATUS_SENTINEL}%{http_code}`,
      USAGE_URL,
      "-A",
      USER_AGENT,
      "-H",
      "Accept: */*",
      "-H",
      "Accept-Language: en-US,en;q=0.5",
      "-H",
      "Referer: https://chat.mistral.ai/code/extensions",
      "-H",
      "DNT: 1",
      "-H",
      "Sec-GPC: 1",
      "-H",
      "Sec-Fetch-Dest: empty",
      "-H",
      "Sec-Fetch-Mode: cors",
      "-H",
      "Sec-Fetch-Site: same-origin",
      "-H",
      "TE: trailers",
      "-H",
      `Cookie: ${cookie}`,
    ]

    try {
      const { status, body } = await this.run(args, this.config.requestTimeoutMs)

      if (status === 401 || (status === 403 && !body.trimStart().startsWith("<"))) {
        throw new Error(
          "Session expired or unauthorized (copy a fresh ory_session_* cookie into mistral.json)",
        )
      }
      if (status === 403) {
        throw new Error("Blocked by a Cloudflare challenge (curl-impersonate target may be outdated)")
      }
      if (status !== 200) {
        throw new Error(`HTTP ${status}`)
      }

      const parsed = JSON.parse(body) as unknown
      return successResult(
        ref,
        ref.label,
        [parseMistralUsage(parsed)],
        Date.now() - startedAt,
      )
    } catch (error) {
      return errorResult(
        ref,
        errorMessage(error).replaceAll(cookie, "[redacted]"),
        Date.now() - startedAt,
      )
    }
  }
}
