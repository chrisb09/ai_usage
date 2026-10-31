import { createSign } from "node:crypto"
import { z } from "zod"
import type { AppConfig } from "../config.js"
import type { AccountRef, Collector, Quota } from "../domain.js"
import { fetchWithTimeout } from "./http.js"
import { errorMessage, errorResult, readJsonFile, successResult } from "./util.js"

const settingsSchema = z.object({
  serviceAccountPath: z.string().min(1),
  table: z.string().regex(/^[a-z][a-z0-9-]*\.[A-Za-z0-9_]+\.gcp_billing_export_v1_[A-Za-z0-9_]+$/),
  queryProject: z.string().regex(/^[a-z][a-z0-9-]*$/),
  location: z.string().default("EU"),
  grantAmount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/).default("EUR"),
  expiresAt: z.string().datetime(),
  creditId: z.string().min(1).optional(),
  maximumBytesBilled: z.number().int().positive().default(1_000_000_000),
})
type Settings = z.infer<typeof settingsSchema>
const keySchema = z.object({ client_email: z.string().email(), private_key: z.string().min(1) })
const querySchema = z.object({
  jobComplete: z.boolean(),
  errors: z.array(z.object({ message: z.string() })).optional(),
  schema: z.object({ fields: z.array(z.object({ name: z.string() })) }).optional(),
  rows: z.array(z.object({ f: z.array(z.object({ v: z.string().nullable() })) })).optional(),
})

export function buildBillingQuery(settings: Settings): string {
  // Account-wide: other projects can consume the same grant. Never filter by project.id.
  return `SELECT currency, COUNT(*) AS billing_rows, MAX(export_time) AS latest_export,
    SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c
      WHERE c.type = 'PROMOTION' AND (@creditId = '' OR c.id = @creditId)), 0)) AS credits_applied
    FROM \`${settings.table}\` GROUP BY currency`
}

export function billingQuota(settings: Settings, rows: Record<string, string | null>[], now = Date.now()): Quota {
  const hasData = rows.some(row => Number(row.billing_rows) > 0)
  if (rows.some(row => Number(row.billing_rows) > 0 && row.currency !== settings.currency)) {
    throw new Error(`Billing export currency does not match configured ${settings.currency}`)
  }
  const applied = rows.reduce((sum, row) => sum + Number(row.credits_applied ?? 0), 0)
  if (!Number.isFinite(applied)) throw new Error("Invalid credit amount in billing export")
  const expired = now >= Date.parse(settings.expiresAt)
  const balance = expired ? 0 : hasData ? Math.max(0, Math.min(settings.grantAmount, settings.grantAmount + applied)) : null
  const exports = rows.map(row => Number(row.latest_export)).filter(value => Number.isFinite(value) && value > 0)
  return {
    key: "free-trial-credit",
    label: "Free-trial credit (estimated)",
    remaining: balance === null ? null : balance / settings.grantAmount,
    resetAt: settings.expiresAt,
    raw: {
      balance, grantAmount: settings.grantAmount, currency: settings.currency,
      used: hasData ? -applied : null, estimated: true,
      waitingForData: !hasData && !expired, expired,
      latestExportAt: exports.length ? new Date(Math.max(...exports) * 1000).toISOString() : null,
    },
  }
}

export class GcpBillingCollector implements Collector {
  readonly id = "gcp-billing"
  readonly provider = "Google Cloud"
  constructor(private readonly config: AppConfig) {}

  async discover(): Promise<AccountRef[]> {
    const file = await readJsonFile(this.config.paths.gcpBillingConfig)
    if (!file.ok) {
      if (file.kind === "missing") return []
      throw new Error(file.error)
    }
    const settings = settingsSchema.parse(file.value)
    return [{ accountKey: `gcp-billing:${settings.table}`, provider: this.provider,
      label: "Google Cloud free trial", collectorId: this.id, data: settings }]
  }

  async collect(ref: AccountRef) {
    const started = Date.now()
    if (ref.discoveryError) return errorResult(ref, ref.discoveryError, Date.now() - started)
    try {
      const settings = settingsSchema.parse(ref.data)
      const file = await readJsonFile(settings.serviceAccountPath)
      if (!file.ok) throw new Error("Cannot read Google Cloud service account credential")
      const key = keySchema.parse(file.value)
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
      const now = Math.floor(Date.now() / 1000)
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        iss: key.client_email, scope: "https://www.googleapis.com/auth/bigquery",
        aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
      })}`
      const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url")
      const auth = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}`,
        }),
      }, this.config.requestTimeoutMs)
      if (!auth.ok) throw new Error(`Google authentication HTTP ${auth.status}`)
      const token = z.object({ access_token: z.string() }).parse(await auth.json())
      const response = await fetchWithTimeout(`https://bigquery.googleapis.com/bigquery/v2/projects/${settings.queryProject}/queries`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: buildBillingQuery(settings), useLegacySql: false, location: settings.location,
          maximumBytesBilled: String(settings.maximumBytesBilled), timeoutMs: 10000,
          parameterMode: "NAMED", queryParameters: [{ name: "creditId", parameterType: { type: "STRING" }, parameterValue: { value: settings.creditId ?? "" } }],
        }),
      }, this.config.requestTimeoutMs)
      if (!response.ok) throw new Error(`BigQuery HTTP ${response.status}: ${response.status === 403 ? "Check dataset read and query job permissions" : "Billing query failed"}`)
      const result = querySchema.parse(await response.json())
      if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join("; "))
      if (!result.jobComplete) throw new Error("BigQuery query is still running; retry on the next check")
      const rows = (result.rows ?? []).map(row => Object.fromEntries(
        (result.schema?.fields ?? []).map((field, index) => [field.name, row.f[index]?.v ?? null]),
      ))
      const quota = billingQuota(settings, rows)
      const warning = quota.raw?.waitingForData
        ? "Waiting for billing data. The configured starting grant is not a measured balance."
        : "Estimated from the configured grant minus exported promotional credits. Billing data is delayed; missing historical usage can overstate the balance."
      return successResult(ref, ref.label, [quota], Date.now() - started, warning)
    } catch (error) {
      return errorResult(ref, error instanceof z.ZodError ? "Invalid Google Cloud billing configuration or response" : errorMessage(error), Date.now() - started)
    }
  }
}
