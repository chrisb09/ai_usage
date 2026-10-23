import { useState } from "react"
import { Icon } from "./Icon"
import type { AccountView, Quota } from "./types"
import {
  barTone,
  formatCountdown,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatPercent,
  formatRelative,
} from "./format"

export function needsLogin(error: string | null): boolean {
  if (!error) return false
  return /expired|unauthorized|forbidden|\b401\b|\b403\b|missing .*(cookie|token)|codex login/i.test(
    error,
  )
}

function quotaHint(quota: Quota): string | null {
  const balance = formatMoney(quota.raw?.balanceUsd)
  const total = formatMoney(quota.raw?.quotaUsd)
  if (balance && total) return `${balance} / ${total}`
  return null
}

function QuotaRow(props: { quota: Quota; provider: string; now: number }) {
  const { quota, provider, now } = props
  const tone = barTone(quota.remaining)
  const width =
    quota.remaining === null
      ? 0
      : Math.max(0, Math.min(100, quota.remaining * 100))
  const hint = quotaHint(quota)
  const label = hint ? "Credit" : quota.label
    .replace(`${provider} — `, provider === "Google" ? `${provider} — ` : "")
    .replace(" — ", " · ")
    .replace("Weekly", "7d")
    .replace("Monthly", "30d")

  return (
    <div className="quota">
      <div className="quota-head">
        <span className="quota-label" title={quota.label}>{label}</span>
        <span className={`quota-value ${hint ? "quota-value-balance" : ""} tone-${tone}`}>{hint ?? formatPercent(quota.remaining)}</span>
      </div>
      <div className="bar" role="progressbar" aria-label={`${quota.label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quota.remaining === null ? undefined : Math.round(width)}>
        <div className={`bar-fill tone-${tone}`} style={{ width: `${width}%` }} />
      </div>
      <div className="quota-meta">
        {hint && <span>{formatPercent(quota.remaining)} remaining</span>}
        {quota.resetAt && <span title={formatDateTime(quota.resetAt)}>{hint ? "Expires" : "Reset"} {formatCountdown(quota.resetAt, now)}</span>}
      </div>
    </div>
  )
}

export function AccountCard(props: {
  account: AccountView
  now: number
  onRefresh: (accountKey: string) => Promise<void>
  isPublic?: boolean
}) {
  const { account, now, onRefresh, isPublic } = props
  const [busy, setBusy] = useState(false)
  const refreshing = busy || account.refreshing

  const handleRefresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await onRefresh(account.accountKey)
    } finally {
      setBusy(false)
    }
  }

  const status = account.lastError
    ? "error"
    : account.stale
      ? "stale"
      : refreshing
        ? "refreshing"
        : "ok"

  return (
    <article className={`account-card status-${status}`} data-provider={account.provider}>
        <div className="account-title">
          <span className={`dot dot-${status}`} aria-hidden="true" />
          <div>
            <h3>{account.label}</h3>
            <span className="provider-tag">
              {account.provider}
              <span className={`account-state tone-${status === "error" ? "bad" : status === "stale" ? "warn" : "unknown"}`}>
                {refreshing ? "Checking…" : needsLogin(account.lastError) ? "Needs login" : account.lastError ? "Error" : account.stale ? "Stale" : ""}
              </span>
            </span>
          </div>
        </div>

      <div className="quota-list">
        {account.quotas.length === 0 ? (
          <div className="empty-quotas">
            {refreshing ? "Waiting for data…" : "No quota data yet."}
          </div>
        ) : (
          account.quotas.map((quota) => (
            <QuotaRow key={quota.key} quota={quota} provider={account.provider} now={now} />
          ))
        )}
      </div>

      <div className="account-actions">
        <div className="account-timing" title={`Checked: ${formatDateTime(account.lastSuccessAt)} · Next: ${formatDateTime(account.nextCheckAt)} · Interval: ${formatDuration(account.lastError ? account.errorIntervalSec : account.intervalSec)}`}>
          <span>{formatRelative(account.lastSuccessAt, now)}</span>
          <span>Next {formatCountdown(account.nextCheckAt, now)}</span>
        </div>
        {!isPublic && (
          <button className="button button-icon" aria-label={`Refresh ${account.label}`} title="Check usage now" onClick={() => void handleRefresh()} disabled={refreshing}>
            {refreshing ? <span className="spinner" /> : <Icon name="refresh" />}
          </button>
        )}
      </div>

      {(account.lastError || account.lastWarning || account.stale) && (
        <details className={`account-details ${account.lastError ? "tone-bad" : "tone-warn"}`}>
          <summary>{account.lastError ? "Connection details" : account.lastWarning ? "Warning details" : "Stale data details"}</summary>
          {account.lastError && <p>{account.lastError}</p>}
          {account.lastWarning && <p>{account.lastWarning}</p>}
          {!account.lastError && account.stale && <p>Last successful check: {formatRelative(account.lastSuccessAt, now)}.</p>}
        </details>
      )}
    </article>
  )
}
