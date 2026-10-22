import type { FastifyBaseLogger } from "fastify"
import type { AppConfig } from "./config.js"
import type { CollectResult, Collector, Trigger } from "./domain.js"
import { UsageDatabase } from "./db.js"
import {
  createCollectors,
  discoverAccounts,
  type DiscoveredAccount,
} from "./collectors/index.js"
import { computeStateUpdate, isDue } from "./policy.js"
import { errorResult } from "./collectors/util.js"

const TICK_INTERVAL_MS = 30_000

export interface RefreshSummary {
  refreshed: CollectResult[]
  skipped: Array<{ accountKey: string; reason: string }>
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let index = 0

  const runners = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (true) {
        const current = index
        index += 1
        if (current >= items.length) return
        const item = items[current]
        if (item === undefined) return
        results[current] = await worker(item)
      }
    },
  )

  await Promise.all(runners)
  return results
}

export class UsageScheduler {
  private readonly collectors: Collector[]
  private accounts = new Map<string, DiscoveredAccount>()
  private readonly inFlight = new Map<string, Promise<CollectResult>>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private lastTickAt: string | null = null

  constructor(
    private readonly db: UsageDatabase,
    private readonly config: AppConfig,
    private readonly log: FastifyBaseLogger,
  ) {
    this.collectors = createCollectors(config)
  }

  start(): void {
    if (this.timer) return
    void this.tick("startup")
    this.timer = setInterval(() => {
      void this.tick("schedule")
    }, TICK_INTERVAL_MS)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await Promise.allSettled([...this.inFlight.values()])
  }

  getLastTickAt(): string | null {
    return this.lastTickAt
  }

  isRefreshing(accountKey: string): boolean {
    return this.inFlight.has(accountKey)
  }

  isTicking(): boolean {
    return this.ticking
  }

  getDiscoveredAccountKeys(): string[] {
    return [...this.accounts.keys()]
  }

  async triggerDue(trigger: Extract<Trigger, "startup" | "schedule" | "request">): Promise<void> {
    await this.tick(trigger)
  }

  async refresh(
    accountKeys: string[] | null,
    trigger: Extract<Trigger, "manual" | "request">,
  ): Promise<RefreshSummary> {
    await this.syncAccounts()

    const keys =
      accountKeys && accountKeys.length > 0
        ? [...new Set(accountKeys)]
        : [...this.accounts.keys()]

    const now = Date.now()
    const skipped: RefreshSummary["skipped"] = []
    const eligible: string[] = []

    for (const key of keys) {
      if (!this.accounts.has(key)) {
        skipped.push({ accountKey: key, reason: "Unknown account" })
        continue
      }

      if (trigger === "manual") {
        const state = this.db.getState(key)
        const lastManual = state?.lastManualAt ? Date.parse(state.lastManualAt) : null
        if (
          lastManual !== null &&
          Number.isFinite(lastManual) &&
          now - lastManual < this.config.policy.manualCooldownSec * 1000
        ) {
          skipped.push({ accountKey: key, reason: "Manual refresh cooldown" })
          continue
        }
      }

      eligible.push(key)
    }

    const refreshed = await mapLimit(
      eligible,
      this.config.concurrency,
      (key) => this.collectAccount(key, trigger),
    )

    return {
      refreshed: refreshed.filter((result): result is CollectResult => result !== null),
      skipped,
    }
  }

  private async tick(trigger: Trigger): Promise<void> {
    if (this.ticking) return
    this.ticking = true

    try {
      await this.syncAccounts()
      const now = new Date()
      const due: string[] = []

      for (const [accountKey] of this.accounts) {
        const state = this.db.getState(accountKey)
        if (!state || isDue(state.nextCheckAt, now)) due.push(accountKey)
      }

      if (due.length > 0) {
        this.log.debug(
          { trigger, accounts: due.length },
          "refreshing due usage accounts",
        )
        await mapLimit(due, this.config.concurrency, (key) =>
          this.collectAccount(key, trigger),
        )
      }

      this.lastTickAt = new Date().toISOString()
    } catch (error) {
      this.log.error({ error, trigger }, "usage scheduler tick failed")
    } finally {
      this.ticking = false
    }
  }

  private async syncAccounts(): Promise<void> {
    const discovered = await discoverAccounts(this.collectors)
    const now = new Date()

    for (const [accountKey, account] of discovered) {
      this.db.upsertAccount(account.ref, now)
      this.db.ensureState(accountKey, this.config.policy.minIntervalSec, now)
    }

    this.db.deactivateAccountsExcept([...discovered.keys()])
    this.accounts = discovered
  }

  private collectAccount(
    accountKey: string,
    trigger: Trigger,
  ): Promise<CollectResult | null> {
    const existing = this.inFlight.get(accountKey)
    if (existing) return existing

    const account = this.accounts.get(accountKey)
    if (!account) return Promise.resolve(null)

    const promise = this.doCollect(account, trigger)
      .catch((error: unknown) => {
        const result = errorResult(
          account.ref,
          error instanceof Error ? error.message : String(error),
          0,
        )
        this.log.error({ error, accountKey }, "usage check crashed")
        return result
      })
      .finally(() => {
        this.inFlight.delete(accountKey)
      })

    this.inFlight.set(accountKey, promise)
    return promise
  }

  private async doCollect(
    account: DiscoveredAccount,
    trigger: Trigger,
  ): Promise<CollectResult> {
    const { ref, collector } = account
    const previous = this.db.getState(ref.accountKey)
    const previousQuotas =
      previous?.lastSuccessAt !== null && previous?.lastSuccessAt !== undefined
        ? this.db.getLatestQuotas(ref.accountKey)
        : null

    const startedAt = new Date()
    let result: CollectResult
    try {
      result = await collector.collect(ref)
    } catch (error) {
      result = errorResult(
        ref,
        error instanceof Error ? error.message : String(error),
        Date.now() - startedAt.getTime(),
      )
    }
    const finishedAt = new Date()

    const update = computeStateUpdate({
      previous,
      previousQuotas,
      result,
      now: finishedAt,
      config: this.config.policy,
    })

    this.db.recordCheck({
      result,
      update,
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    })

    if (result.error) {
      this.log.warn(
        {
          accountKey: ref.accountKey,
          provider: result.provider,
          trigger,
          durationMs: result.durationMs,
          error: result.error,
          nextCheckAt: update.nextCheckAt,
        },
        "usage check failed",
      )
    } else {
      this.log.info(
        {
          accountKey: ref.accountKey,
          provider: result.provider,
          trigger,
          durationMs: result.durationMs,
          quotas: result.quotas.length,
          intervalSec: update.intervalSec,
          nextCheckAt: update.nextCheckAt,
        },
        "usage check complete",
      )
    }

    return result
  }
}
