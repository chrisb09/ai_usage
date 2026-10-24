export type Trigger = "startup" | "schedule" | "request" | "manual" | "import"

export interface Quota {
  key: string
  label: string
  remaining: number | null
  resetAt: string | null
  windowSec?: number | null
  raw?: Record<string, unknown> | null
}

export interface AccountRef {
  accountKey: string
  provider: string
  label: string
  collectorId: string
  data?: unknown
  discoveryError?: string
}

export interface CollectResult {
  accountKey: string
  provider: string
  label: string
  quotas: Quota[]
  error: string | null
  warning: string | null
  durationMs: number
}

export interface Collector {
  id: string
  provider: string
  discover(): Promise<AccountRef[]>
  collect(ref: AccountRef): Promise<CollectResult>
}

export interface AccountStateRow {
  accountKey: string
  fingerprint: string | null
  intervalSec: number
  unchangedStreak: number
  errorIntervalSec: number
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastChangeAt: string | null
  nextCheckAt: string | null
  lastError: string | null
  lastWarning: string | null
  lastManualAt: string | null
  lastDurationMs: number | null
}

export interface AccountView {
  accountKey: string
  provider: string
  label: string
  active: boolean
  quotas: Quota[]
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastChangeAt: string | null
  nextCheckAt: string | null
  intervalSec: number
  unchangedStreak: number
  errorIntervalSec: number
  lastError: string | null
  lastWarning: string | null
  lastDurationMs: number | null
  stale: boolean
  refreshing: boolean
}

export interface HistoryPoint {
  accountKey: string
  quotaKey: string
  label: string
  remaining: number | null
  resetAt: string | null
  checkedAt: string
}
