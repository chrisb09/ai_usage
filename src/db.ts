import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  AccountRef,
  AccountStateRow,
  AccountView,
  HistoryPoint,
  Quota,
  Trigger,
} from "./domain.js"
import type { StateUpdate } from "./policy.js"
import { quotaWindowSec } from "./quota-window.js"

interface AccountDbRow {
  account_key: string
  provider: string
  label: string
  active: number
  created_at: string
  updated_at: string
}

interface StateDbRow {
  account_key: string
  fingerprint: string | null
  interval_sec: number
  unchanged_streak: number
  error_interval_sec: number
  last_attempt_at: string | null
  last_success_at: string | null
  last_change_at: string | null
  next_check_at: string | null
  last_error: string | null
  last_warning: string | null
  last_manual_at: string | null
  last_duration_ms: number | null
}

interface QuotaDbRow {
  account_key: string
  quota_key: string
  quota_label: string
  remaining: number | null
  reset_at: string | null
  raw_json: string | null
}

interface HistoryDbRow {
  checkedAt: string
  accountKey: string
  quotaKey: string
  label: string
  remaining: number | null
  resetAt: string | null
}

interface ImportedQuota {
  key: string
  label: string
  remaining: number | null
  resetAt: string | null
}

const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    account_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE account_state (
    account_key TEXT PRIMARY KEY REFERENCES accounts(account_key) ON DELETE CASCADE,
    fingerprint TEXT,
    interval_sec INTEGER NOT NULL,
    unchanged_streak INTEGER NOT NULL DEFAULT 0,
    error_interval_sec INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_change_at TEXT,
    next_check_at TEXT,
    last_error TEXT,
    last_manual_at TEXT,
    last_duration_ms INTEGER
  );

  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_key TEXT NOT NULL REFERENCES accounts(account_key) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    trigger TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    duration_ms INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX checks_import_unique
    ON checks(account_key, started_at)
    WHERE trigger = 'import';

  CREATE INDEX checks_account_started
    ON checks(account_key, started_at);

  CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    account_key TEXT NOT NULL REFERENCES accounts(account_key) ON DELETE CASCADE,
    quota_key TEXT NOT NULL,
    quota_label TEXT NOT NULL,
    remaining REAL,
    reset_at TEXT,
    raw_json TEXT
  );

  CREATE INDEX observations_account_quota
    ON observations(account_key, quota_key, check_id);

  CREATE INDEX observations_check
    ON observations(check_id);

  CREATE INDEX account_state_next
    ON account_state(next_check_at);
  `,
  `
  ALTER TABLE accounts ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
  `,
  `
  ALTER TABLE account_state ADD COLUMN last_warning TEXT;
  `,
]

function mapState(row: StateDbRow): AccountStateRow {
  return {
    accountKey: row.account_key,
    fingerprint: row.fingerprint,
    intervalSec: row.interval_sec,
    unchangedStreak: row.unchanged_streak,
    errorIntervalSec: row.error_interval_sec,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastChangeAt: row.last_change_at,
    nextCheckAt: row.next_check_at,
    lastError: row.last_error,
    lastWarning: row.last_warning,
    lastManualAt: row.last_manual_at,
    lastDurationMs: row.last_duration_ms,
  }
}

function mapQuota(row: QuotaDbRow): Quota {
  let raw: Record<string, unknown> | null = null
  if (row.raw_json) {
    try {
      raw = JSON.parse(row.raw_json) as Record<string, unknown>
    } catch {
      raw = null
    }
  }
  return {
    key: row.quota_key,
    label: row.quota_label,
    remaining: row.remaining,
    resetAt: row.reset_at,
    raw,
  }
}

export class UsageDatabase {
  private readonly db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")
    this.db.pragma("busy_timeout = 5000")
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      const sql = MIGRATIONS[version]
      if (!sql) continue
      const migration = this.db.transaction(() => {
        this.db.exec(sql)
        this.db.pragma(`user_version = ${version + 1}`)
      })
      migration()
    }
  }

  upsertAccount(ref: AccountRef, now = new Date()): void {
    const timestamp = now.toISOString()
    this.db
      .prepare(
        `INSERT INTO accounts (account_key, provider, label, active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(account_key) DO UPDATE SET
           provider = excluded.provider,
           label = excluded.label,
           active = 1,
           updated_at = excluded.updated_at`,
      )
      .run(ref.accountKey, ref.provider, ref.label, timestamp, timestamp)
  }

  private upsertImportedAccount(ref: AccountRef, now: Date): void {
    const timestamp = now.toISOString()
    this.db
      .prepare(
        `INSERT INTO accounts (account_key, provider, label, active, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(account_key) DO UPDATE SET
           provider = excluded.provider,
           label = excluded.label,
           updated_at = excluded.updated_at`,
      )
      .run(ref.accountKey, ref.provider, ref.label, timestamp, timestamp)
  }

  ensureState(accountKey: string, minIntervalSec: number, now = new Date()): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO account_state
           (account_key, interval_sec, unchanged_streak, next_check_at)
         VALUES (?, ?, 0, ?)`,
      )
      .run(accountKey, minIntervalSec, now.toISOString())
  }

  deactivateAccountsExcept(accountKeys: string[]): void {
    if (accountKeys.length === 0) {
      this.db.prepare("UPDATE accounts SET active = 0").run()
      return
    }
    const placeholders = accountKeys.map(() => "?").join(", ")
    this.db
      .prepare(`UPDATE accounts SET active = 0 WHERE account_key NOT IN (${placeholders})`)
      .run(...accountKeys)
  }

  getAccount(accountKey: string): AccountDbRow | null {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE account_key = ?")
      .get(accountKey) as AccountDbRow | undefined
    return row ?? null
  }

  getAccounts(): AccountDbRow[] {
    return this.db
      .prepare("SELECT * FROM accounts ORDER BY provider ASC, label ASC")
      .all() as AccountDbRow[]
  }

  getState(accountKey: string): AccountStateRow | null {
    const row = this.db
      .prepare("SELECT * FROM account_state WHERE account_key = ?")
      .get(accountKey) as StateDbRow | undefined
    return row ? mapState(row) : null
  }

  getAllStates(): Map<string, AccountStateRow> {
    const rows = this.db.prepare("SELECT * FROM account_state").all() as StateDbRow[]
    return new Map(rows.map((row) => [row.account_key, mapState(row)]))
  }

  getLatestQuotas(accountKey: string): Quota[] {
    const latest = this.db
      .prepare(
        `SELECT id FROM checks
         WHERE account_key = ? AND ok = 1
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
      )
      .get(accountKey) as { id: number } | undefined
    if (!latest) return []

    const rows = this.db
      .prepare(
        `SELECT account_key, quota_key, quota_label, remaining, reset_at, raw_json
         FROM observations WHERE check_id = ? ORDER BY quota_key ASC`,
      )
      .all(latest.id) as QuotaDbRow[]
    return rows.map(mapQuota)
  }

  getLatestQuotasForAll(): Map<string, Quota[]> {
    const rows = this.db
      .prepare(
        `WITH latest AS (
           SELECT account_key, MAX(id) AS check_id
           FROM checks WHERE ok = 1
           GROUP BY account_key
         )
         SELECT o.account_key, o.quota_key, o.quota_label, o.remaining, o.reset_at, o.raw_json
         FROM observations o
         JOIN latest l ON l.check_id = o.check_id
         ORDER BY o.account_key ASC, o.quota_key ASC`,
      )
      .all() as QuotaDbRow[]

    const result = new Map<string, Quota[]>()
    for (const row of rows) {
      const list = result.get(row.account_key) ?? []
      list.push(mapQuota(row))
      result.set(row.account_key, list)
    }
    return result
  }

  recordCheck(args: {
    result: {
      accountKey: string
      provider: string
      label: string
      quotas: Quota[]
      error: string | null
      warning: string | null
      durationMs: number
    }
    update: StateUpdate
    trigger: Trigger
    startedAt: string
    finishedAt: string
  }): number {
    const { result, update, trigger, startedAt, finishedAt } = args
    const manual = trigger === "manual" ? 1 : 0

    const transaction = this.db.transaction(() => {
      this.upsertAccount(
        {
          accountKey: result.accountKey,
          provider: result.provider,
          label: result.label,
          collectorId: "",
        },
        new Date(finishedAt),
      )

      const check = this.db
        .prepare(
          `INSERT INTO checks
             (account_key, started_at, finished_at, trigger, ok, error, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          result.accountKey,
          startedAt,
          finishedAt,
          trigger,
          result.error ? 0 : 1,
          result.error,
          result.durationMs,
        )

      const checkId = Number(check.lastInsertRowid)
      if (!result.error) {
        const insertObservation = this.db.prepare(
          `INSERT INTO observations
             (check_id, account_key, quota_key, quota_label, remaining, reset_at, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const quota of result.quotas) {
          insertObservation.run(
            checkId,
            result.accountKey,
            quota.key,
            quota.label,
            quota.remaining,
            quota.resetAt,
            quota.raw ? JSON.stringify(quota.raw) : null,
          )
        }
      }

      this.db
        .prepare(
          `UPDATE account_state SET
             fingerprint = ?,
             interval_sec = ?,
             unchanged_streak = ?,
             error_interval_sec = ?,
             last_attempt_at = ?,
             last_success_at = ?,
             last_change_at = ?,
             next_check_at = ?,
             last_error = ?,
             last_warning = ?,
             last_duration_ms = ?,
             last_manual_at = CASE WHEN ? = 1 THEN ? ELSE last_manual_at END
           WHERE account_key = ?`,
        )
        .run(
          update.fingerprint,
          update.intervalSec,
          update.unchangedStreak,
          update.errorIntervalSec,
          update.lastAttemptAt,
          update.lastSuccessAt,
          update.lastChangeAt,
          update.nextCheckAt,
          update.lastError,
          update.lastWarning,
          update.lastDurationMs,
          manual,
          finishedAt,
          result.accountKey,
        )

      return checkId
    })

    return transaction()
  }

  insertImportedCheck(args: {
    ref: AccountRef
    checkedAt: string
    quotas: ImportedQuota[]
    minIntervalSec?: number
    now?: Date
  }): boolean {
    const { ref, checkedAt, quotas } = args
    const now = args.now ?? new Date()

    const transaction = this.db.transaction(() => {
      this.upsertImportedAccount(ref, now)
      this.ensureState(ref.accountKey, args.minIntervalSec ?? 600, now)

      const existing = this.db
        .prepare(
          `SELECT id FROM checks
           WHERE account_key = ? AND started_at = ? AND trigger = 'import'`,
        )
        .get(ref.accountKey, checkedAt) as { id: number } | undefined
      if (existing) return false

      const check = this.db
        .prepare(
          `INSERT INTO checks
             (account_key, started_at, finished_at, trigger, ok, error, duration_ms)
           VALUES (?, ?, ?, 'import', 1, NULL, 0)`,
        )
        .run(ref.accountKey, checkedAt, checkedAt)
      const checkId = Number(check.lastInsertRowid)

      const insertObservation = this.db.prepare(
        `INSERT INTO observations
           (check_id, account_key, quota_key, quota_label, remaining, reset_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      for (const quota of quotas) {
        insertObservation.run(
          checkId,
          ref.accountKey,
          quota.key,
          quota.label,
          quota.remaining,
          quota.resetAt,
        )
      }

      this.db
        .prepare(
          `UPDATE account_state SET
             last_success_at = CASE
               WHEN last_success_at IS NULL OR last_success_at < ? THEN ?
               ELSE last_success_at
             END
           WHERE account_key = ?`,
        )
        .run(checkedAt, checkedAt, ref.accountKey)

      return true
    })

    return transaction()
  }

  getEarliestCheckAt(args: { accountKey?: string; quotaKey?: string }): string | null {
    const where: string[] = ["c.ok = 1"]
    const params: string[] = []
    if (args.accountKey) {
      where.push("o.account_key = ?")
      params.push(args.accountKey)
    }
    if (args.quotaKey) {
      where.push("o.quota_key = ?")
      params.push(args.quotaKey)
    }

    const row = this.db
      .prepare(
        `SELECT MIN(c.started_at) AS earliest
         FROM observations o
         JOIN checks c ON c.id = o.check_id
         WHERE ${where.join(" AND ")}`,
      )
      .get(...params) as { earliest: string | null }
    return row.earliest
  }

  getHistory(args: {
    accountKey?: string
    quotaKey?: string
    from?: string
    to?: string
    bucketSec?: number
    limit?: number
  }): HistoryPoint[] {
    const where: string[] = ["c.ok = 1"]
    const params: Array<string | number> = []

    if (args.accountKey) {
      where.push("o.account_key = ?")
      params.push(args.accountKey)
    }
    if (args.quotaKey) {
      where.push("o.quota_key = ?")
      params.push(args.quotaKey)
    }
    if (args.from) {
      where.push("c.started_at >= ?")
      params.push(args.from)
    }
    if (args.to) {
      where.push("c.started_at <= ?")
      params.push(args.to)
    }

    const whereSql = where.join(" AND ")
    const defaultLimit = args.bucketSec && args.bucketSec > 0 ? 50_000 : 5000
    const limit = Math.min(Math.max(args.limit ?? defaultLimit, 1), 50_000)

    if (args.bucketSec && args.bucketSec > 0) {
      const rows = this.db
        .prepare(
          `WITH filtered AS (
             SELECT c.started_at AS checkedAt,
                    o.account_key AS accountKey,
                    o.quota_key AS quotaKey,
                    o.quota_label AS label,
                    o.remaining AS remaining,
                    o.reset_at AS resetAt,
                    CAST(strftime('%s', c.started_at) AS INTEGER) / ? AS bucket
             FROM observations o
             JOIN checks c ON c.id = o.check_id
             WHERE ${whereSql}
           ), ranked AS (
             SELECT *,
                    ROW_NUMBER() OVER (
                      PARTITION BY accountKey, quotaKey, bucket
                      ORDER BY checkedAt DESC
                    ) AS rn
             FROM filtered
           )
           SELECT checkedAt, accountKey, quotaKey, label, remaining, resetAt
           FROM ranked WHERE rn = 1
           ORDER BY checkedAt ASC
           LIMIT ?`,
        )
        .all(args.bucketSec, ...params, limit) as HistoryDbRow[]
      return rows
    }

    const rows = this.db
      .prepare(
        `SELECT c.started_at AS checkedAt,
                o.account_key AS accountKey,
                o.quota_key AS quotaKey,
                o.quota_label AS label,
                o.remaining AS remaining,
                o.reset_at AS resetAt
         FROM observations o
         JOIN checks c ON c.id = o.check_id
         WHERE ${whereSql}
         ORDER BY c.started_at DESC, o.quota_key DESC
         LIMIT ?`,
      )
      .all(...params, limit) as HistoryDbRow[]
    return rows.reverse()
  }

  getCounts(): {
    accounts: number
    checks: number
    observations: number
    lastCheckAt: string | null
  } {
    const accounts = this.db
      .prepare("SELECT COUNT(*) AS count FROM accounts")
      .get() as { count: number }
    const checks = this.db
      .prepare("SELECT COUNT(*) AS count FROM checks")
      .get() as { count: number }
    const observations = this.db
      .prepare("SELECT COUNT(*) AS count FROM observations")
      .get() as { count: number }
    const last = this.db
      .prepare("SELECT MAX(started_at) AS lastCheckAt FROM checks")
      .get() as { lastCheckAt: string | null }
    return {
      accounts: accounts.count,
      checks: checks.count,
      observations: observations.count,
      lastCheckAt: last.lastCheckAt,
    }
  }

  buildViews(args: {
    refreshing: (accountKey: string) => boolean
    isStale: (lastSuccessAt: string | null) => boolean
  }): AccountView[] {
    const accounts = this.getAccounts()
    const states = this.getAllStates()
    const quotas = this.getLatestQuotasForAll()

    return accounts.map((account) => {
      const state = states.get(account.account_key)
      return {
        accountKey: account.account_key,
        provider: account.provider,
        label: account.label,
        active: account.active === 1,
        quotas: (quotas.get(account.account_key) ?? []).map((quota) => ({
          ...quota,
          windowSec: quotaWindowSec(quota),
        })),
        lastAttemptAt: state?.lastAttemptAt ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lastChangeAt: state?.lastChangeAt ?? null,
        nextCheckAt: state?.nextCheckAt ?? null,
        intervalSec: state?.intervalSec ?? 0,
        unchangedStreak: state?.unchangedStreak ?? 0,
        errorIntervalSec: state?.errorIntervalSec ?? 0,
        lastError: state?.lastError ?? null,
        lastWarning: state?.lastWarning ?? null,
        lastDurationMs: state?.lastDurationMs ?? null,
        stale: args.isStale(state?.lastSuccessAt ?? null),
        refreshing: args.refreshing(account.account_key),
      }
    })
  }
}
