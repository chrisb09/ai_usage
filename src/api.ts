import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppConfig } from "./config.js"
import type { UsageDatabase } from "./db.js"
import { maskAccount, sanitizeError, toPublicAccountKey } from "./mask.js"
import { isStale } from "./policy.js"
import type { UsageScheduler } from "./scheduler.js"
import type { Trigger } from "./domain.js"

const APP_VERSION = "0.1.0"

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

export function registerApi(
  app: FastifyInstance,
  deps: {
    config: AppConfig
    db: UsageDatabase
    scheduler: UsageScheduler
  },
): void {
  const { config, db, scheduler } = deps

  app.get("/api/usage", async () => {
    const now = new Date()
    const views = db.buildViews({
      refreshing: (accountKey) => scheduler.isRefreshing(accountKey),
      isStale: (lastSuccessAt) =>
        isStale(lastSuccessAt, config.policy.maxIntervalSec, now),
    })

    const discovered = new Set(scheduler.getDiscoveredAccountKeys())
    const hasDue = views.some((view) => {
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
      const views = db.buildViews({
        refreshing: (accountKey) => scheduler.isRefreshing(accountKey),
        isStale: (lastSuccessAt) =>
          isStale(lastSuccessAt, config.policy.maxIntervalSec, now),
      })

      const discovered = new Set(scheduler.getDiscoveredAccountKeys())
      const hasDue = views.some((view) => {
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

      const points = db.getHistory({
        accountKey: parsed.data.accountKey,
        quotaKey: parsed.data.quotaKey,
        from,
        to,
        bucketSec,
        limit: parsed.data.limit,
      })

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

        let realAccountKey: string | undefined = undefined
        if (parsed.data.accountKey) {
          const accounts = db.getAccounts()
          const matched = accounts.find(
            (acc) => toPublicAccountKey(acc.account_key) === parsed.data.accountKey,
          )
          if (matched) {
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

        const publicPoints = points.map((point) => ({
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

      return {
        refreshed: summary.refreshed,
        skipped: summary.skipped,
      }
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
