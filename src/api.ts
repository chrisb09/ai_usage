import type { FastifyInstance } from "fastify"
import { createHash, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import {
  filterHiddenQuotas,
  isHiddenProvider,
  isHiddenQuota,
  type AppConfig,
} from "./config.js"
import type { UsageDatabase } from "./db.js"
import { MistralCodeCollector, persistMistralCookie } from "./collectors/mistral-code.js"
import { maskAccount, sanitizeError, toPublicAccountKey } from "./mask.js"
import { isStale } from "./policy.js"
import type { UsageScheduler } from "./scheduler.js"
import type { Trigger } from "./domain.js"

const APP_VERSION = "0.1.0"

const saiaObservationSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  windows: z.array(z.object({
    window: z.enum(["10s", "minute", "hour", "day", "month"]),
    limit: z.number().int().positive().safe(),
    remaining: z.number().int().nonnegative().safe(),
  }).strict().refine((value) => value.remaining <= value.limit)).min(1).max(5),
}).strict().refine((value) => new Set(value.windows.map((window) => window.window)).size === value.windows.length)

const hashToken = (value: string): Buffer => createHash("sha256").update(value).digest()
const saiaWindowSeconds: Record<string, number> = { "10s": 10, minute: 60, hour: 3600, day: 86400 }

const historyQuerySchema = z.object({
  accountKey: z.string().min(1).optional(),
  quotaKey: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  bucketSec: z.coerce.number().int().min(0).max(86_400).optional(),
  limit: z.coerce.number().int().min(1).max(50_000).optional(),
})

const refreshBodySchema = z
  .object({
    accountKeys: z.array(z.string().min(1)).max(100).optional(),
  })
  .optional()

const mistralPushSchema = z.object({
  cookieName: z.string().regex(/^ory_session_[\w-]+$/),
  cookieValue: z.string().min(32).max(8192),
})

export type MistralCookieValidator = (
  cookie: string,
) => Promise<{ ok: true } | { ok: false; error: string }>

function defaultMistralValidator(config: AppConfig): MistralCookieValidator {
  const collector = new MistralCodeCollector(config)
  return async (cookie) => {
    const result = await collector.collect(
      {
        accountKey: "mistral-code:default",
        provider: "Mistral Code",
        label: "Mistral Code",
        collectorId: "mistral-code",
        data: { cookie },
      },
      { reloadFromDisk: false },
    )
    if (result.error) return { ok: false, error: result.error }
    return { ok: true }
  }
}

function parseDate(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be a valid ISO date`,
      },
    ])
  }
  return new Date(ms).toISOString()
}

function autoBucketSec(from: string | undefined, to: string | undefined): number {
  const toMs = to ? Date.parse(to) : Date.now()
  const fromMs = from ? Date.parse(from) : toMs - 7 * 24 * 3600 * 1000
  const span = Math.max(toMs - fromMs, 60_000)
  const targetPoints = 1500
  const raw = span / targetPoints / 1000
  if (raw <= 60) return 60
  if (raw <= 300) return Math.ceil(raw / 60) * 60
  if (raw <= 3600) return Math.ceil(raw / 300) * 300
  return Math.min(86_400, Math.ceil(raw / 3600) * 3600)
}

function badRequest(message: string): { error: { code: string; message: string } } {
  return { error: { code: "invalid_request", message } }
}

function hiddenAccountKeys(config: AppConfig, db: UsageDatabase): Set<string> {
  return new Set(
    db
      .getAccounts()
      .filter((account) => isHiddenProvider(config, account.provider))
      .map((account) => account.account_key),
  )
}

export function registerApi(
  app: FastifyInstance,
  deps: {
    config: AppConfig
    db: UsageDatabase
    scheduler: UsageScheduler
    mistralValidator?: MistralCookieValidator
  },
): void {
  const { config, db, scheduler } = deps

  app.post("/api/saia/observations", {
    bodyLimit: 8192,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!config.saiaIngestToken) return reply.code(404).send({ error: { code: "not_found", message: "Not found" } })
    const token = request.headers["x-ai-usage-token"]
    if (typeof token !== "string" || !timingSafeEqual(hashToken(token), hashToken(config.saiaIngestToken))) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized" } })
    }
    const parsed = saiaObservationSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest("Invalid SAIA observation"))
    const timestamp = Date.parse(parsed.data.observedAt)
    const now = Date.now()
    if (!Number.isFinite(timestamp) || timestamp > now + 30_000) return reply.code(400).send(badRequest("Invalid observation time"))
    const quotas = parsed.data.windows.map(({ window, limit, remaining }) => ({
      key: `saia-${window}`,
      label: `SAIA — ${window}`,
      remaining: remaining / limit,
      resetAt: null,
      raw: { requestLimit: limit, requestsRemaining: remaining, ...(saiaWindowSeconds[window] ? { windowSec: saiaWindowSeconds[window] } : {}) },
    }))
    const accepted = db.recordSaiaObservation(new Date(Math.min(timestamp, now)).toISOString(), quotas, config.policy.minIntervalSec)
    return reply.code(202).send({ accepted })
  })

  app.get("/api/usage", async () => {
    const now = new Date()
    const allViews = db.buildViews({
      refreshing: (accountKey) => scheduler.isRefreshing(accountKey),
      isStale: (lastSuccessAt) =>
        isStale(lastSuccessAt, config.policy.maxIntervalSec, now),
    })
    const hidden = hiddenAccountKeys(config, db)
    const views = filterHiddenQuotas(
      config,
      allViews.filter((view) => !hidden.has(view.accountKey)),
    )

    const discovered = new Set(scheduler.getDiscoveredAccountKeys())
    const hasDue = allViews.some((view) => {
      if (!view.active || !discovered.has(view.accountKey)) return false
      if (!view.nextCheckAt) return true
      const next = Date.parse(view.nextCheckAt)
      return !Number.isFinite(next) || next <= now.getTime()
    })

    if (hasDue) {
      void scheduler.triggerDue("request").catch((error: unknown) => {
        app.log.error({ error }, "request-triggered refresh failed")
      })
    }

    return {
      serverTime: now.toISOString(),
      accounts: views,
      policy: config.policy,
      scheduler: {
        lastTickAt: scheduler.getLastTickAt(),
        ticking: scheduler.isTicking(),
      },
      refreshing: views.some((view) => view.refreshing) || hasDue,
    }
  })

  app.get(
    "/api/public/usage",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
    },
    async () => {
      const now = new Date()
      const allViews = db.buildViews({
        refreshing: (accountKey) => scheduler.isRefreshing(accountKey),
        isStale: (lastSuccessAt) =>
          isStale(lastSuccessAt, config.policy.maxIntervalSec, now),
      })
      const hidden = hiddenAccountKeys(config, db)
      const views = filterHiddenQuotas(
        config,
        allViews.filter((view) => !hidden.has(view.accountKey)),
      )

      const discovered = new Set(scheduler.getDiscoveredAccountKeys())
      const hasDue = allViews.some((view) => {
        if (!view.active || !discovered.has(view.accountKey)) return false
        if (!view.nextCheckAt) return true
        const next = Date.parse(view.nextCheckAt)
        return !Number.isFinite(next) || next <= now.getTime()
      })

      if (hasDue) {
        void scheduler.triggerDue("request").catch((error: unknown) => {
          app.log.error({ error }, "public request-triggered refresh failed")
        })
      }

      const publicViews = views
        .filter((view) => view.active)
        .map((view) => ({
          ...view,
          accountKey: toPublicAccountKey(view.accountKey),
          label: maskAccount(view.label),
          lastError: sanitizeError(view.lastError),
          lastWarning: sanitizeError(view.lastWarning),
        }))

      return {
        serverTime: now.toISOString(),
        accounts: publicViews,
        policy: config.policy,
        scheduler: {
          lastTickAt: scheduler.getLastTickAt(),
          ticking: scheduler.isTicking(),
        },
        refreshing: views.some((view) => view.refreshing) || hasDue,
        isPublic: true,
      }
    },
  )

  app.get("/api/history", async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send(badRequest(parsed.error.issues[0]?.message ?? "Invalid query"))
    }

    try {
      const from = parseDate(parsed.data.from, "from")
      const to = parseDate(parsed.data.to, "to")
      const hidden = hiddenAccountKeys(config, db)
      const hiddenRequest = parsed.data.accountKey
        ? hidden.has(parsed.data.accountKey)
        : false
      const earliest =
        from ??
        db.getEarliestCheckAt({
          accountKey: parsed.data.accountKey,
          quotaKey: parsed.data.quotaKey,
        }) ??
        undefined
      const bucketSec =
        parsed.data.bucketSec && parsed.data.bucketSec > 0
          ? parsed.data.bucketSec
          : autoBucketSec(earliest, to)

      const points = hiddenRequest
        ? []
        : db
            .getHistory({
              accountKey: parsed.data.accountKey,
              quotaKey: parsed.data.quotaKey,
              from,
              to,
              bucketSec,
              limit: parsed.data.limit,
            })
            .filter(
              (point) =>
                !hidden.has(point.accountKey) && !isHiddenQuota(config, point.quotaKey),
            )

      return {
        points,
        bucketSec,
        from: from ?? null,
        to: to ?? null,
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send(badRequest(error.issues[0]?.message ?? "Invalid date"))
      }
      throw error
    }
  })

  app.get(
    "/api/public/history",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const parsed = historyQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.code(400).send(badRequest(parsed.error.issues[0]?.message ?? "Invalid query"))
      }

      try {
        const from = parseDate(parsed.data.from, "from")
        const to = parseDate(parsed.data.to, "to")
        const hidden = hiddenAccountKeys(config, db)

        let realAccountKey: string | undefined = undefined
        if (parsed.data.accountKey) {
          const accounts = db.getAccounts()
          const matched = accounts.find(
            (acc) => toPublicAccountKey(acc.account_key) === parsed.data.accountKey,
          )
          if (matched && !hidden.has(matched.account_key)) {
            realAccountKey = matched.account_key
          } else {
            return {
              points: [],
              bucketSec: 300,
              from: from ?? null,
              to: to ?? null,
            }
          }
        }

        const earliest =
          from ??
          db.getEarliestCheckAt({
            accountKey: realAccountKey,
            quotaKey: parsed.data.quotaKey,
          }) ??
          undefined
        const bucketSec =
          parsed.data.bucketSec && parsed.data.bucketSec > 0
            ? parsed.data.bucketSec
            : autoBucketSec(earliest, to)

        const points = db.getHistory({
          accountKey: realAccountKey,
          quotaKey: parsed.data.quotaKey,
          from,
          to,
          bucketSec,
          limit: parsed.data.limit,
        })

        const publicPoints = points
          .filter(
            (point) =>
              !hidden.has(point.accountKey) && !isHiddenQuota(config, point.quotaKey),
          )
          .map((point) => ({
            ...point,
            accountKey: toPublicAccountKey(point.accountKey),
          }))

        return {
          points: publicPoints,
          bucketSec,
          from: from ?? null,
          to: to ?? null,
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send(badRequest(error.issues[0]?.message ?? "Invalid date"))
        }
        throw error
      }
    },
  )

  app.post(
    "/api/refresh",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const parsed = refreshBodySchema.safeParse(request.body ?? undefined)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(badRequest(parsed.error.issues[0]?.message ?? "Invalid body"))
      }

      const accountKeys = parsed.data?.accountKeys ?? null
      const trigger: Extract<Trigger, "manual"> = "manual"
      const summary = await scheduler.refresh(accountKeys, trigger)
      const hidden = hiddenAccountKeys(config, db)

      return {
        refreshed: filterHiddenQuotas(
          config,
          summary.refreshed.filter((result) => !hidden.has(result.accountKey)),
        ),
        skipped: summary.skipped.filter((skip) => !hidden.has(skip.accountKey)),
      }
    },
  )

  app.post(
    "/api/credentials/mistral",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      if (!config.credentialPushToken) {
        return reply.code(404).send({
          error: { code: "not_found", message: "Credential push is disabled" },
        })
      }
      const auth = request.headers.authorization
      if (auth !== `Bearer ${config.credentialPushToken}`) {
        return reply
          .code(401)
          .send({ error: { code: "unauthorized", message: "Invalid push token" } })
      }

      const parsed = mistralPushSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: "invalid_request",
            message: "Expected { cookieName: ory_session_*, cookieValue }",
          },
        })
      }
      const { cookieName, cookieValue } = parsed.data
      const candidates = [
        ...new Set([`${cookieName}=${cookieValue}`, `${cookieName}="${cookieValue}"`]),
      ]

      const validator = deps.mistralValidator ?? defaultMistralValidator(config)
      let lastError = "Cookie validation failed"
      for (const candidate of candidates) {
        const verdict = await validator(candidate)
        if (verdict.ok) {
          const persistError = await persistMistralCookie(
            config.paths.mistralCodeConfig,
            candidate,
          )
          if (persistError) {
            return reply.code(500).send({
              error: { code: "persist_failed", message: persistError },
            })
          }
          const trigger: Extract<Trigger, "manual"> = "manual"
          const summary = await scheduler.refresh(["mistral-code:default"], trigger)
          const refreshed = summary.refreshed.find(
            (result) => result.accountKey === "mistral-code:default",
          )
          return {
            ok: true,
            quotas:
              refreshed?.quotas.map((quota) => ({
                key: quota.key,
                label: quota.label,
                remaining: quota.remaining,
                raw: quota.raw,
              })) ?? [],
            warning: refreshed?.warning ?? null,
          }
        }
        lastError = verdict.error
      }

      return reply.code(422).send({ ok: false, error: lastError })
    },
  )

  app.get("/api/health", async () => {
    const counts = db.getCounts()
    return {
      ok: true,
      version: APP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      scheduler: {
        lastTickAt: scheduler.getLastTickAt(),
        ticking: scheduler.isTicking(),
      },
      counts,
    }
  })

  app.get("/api/meta", async () => {
    const counts = db.getCounts()
    return {
      version: APP_VERSION,
      policy: config.policy,
      schedulerIntervalSec: 30,
      concurrency: config.concurrency,
      counts,
    }
  })
}
