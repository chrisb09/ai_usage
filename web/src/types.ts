export interface Quota {
  key: string
  label: string
  remaining: number | null
  resetAt: string | null
  raw?: Record<string, unknown> | null
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

export interface Policy {
  minIntervalSec: number
  maxIntervalSec: number
  changeEpsilonPp: number
  resetShiftSec: number
  resetGraceSec: number
  manualCooldownSec: number
  errorMinSec: number
  errorMaxSec: number
}

export interface UsageResponse {
  serverTime: string
  accounts: AccountView[]
  policy: Policy
  scheduler: {
    lastTickAt: string | null
    ticking: boolean
  }
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

export interface HistoryResponse {
  points: HistoryPoint[]
  bucketSec: number
  from: string | null
  to: string | null
}

export interface RefreshResponse {
  refreshed: Array<{
    accountKey: string
    provider: string
    label: string
    quotas: Quota[]
    error: string | null
    durationMs: number
  }>
  skipped: Array<{ accountKey: string; reason: string }>
}

export interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
  }
}
