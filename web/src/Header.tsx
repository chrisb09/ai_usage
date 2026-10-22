import type { UsageResponse } from "./types"
import { formatRelative } from "./format"
import { Icon } from "./Icon"

export function Header(props: {
  usage: UsageResponse | null
  refreshing: boolean
  onRefresh: () => void
  now: number
}) {
  const { usage, refreshing, onRefresh, now } = props
  const accounts = (usage?.accounts ?? []).filter((account) => account.active)
  const issues = accounts.filter((account) => account.lastError || account.lastWarning || account.stale).length
  const latestSuccess = accounts.map((account) => account.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null

  return (
    <header className="topbar" id="overview">
      <h1>AI Usage</h1>
      <div className="topbar-actions">
        <span className={`connection-status ${!usage ? "" : issues ? "tone-warn" : "tone-good"}`}>
          <span className="status-light" />
          {!usage ? "Connecting" : issues ? `${issues} ${issues === 1 ? "needs" : "need"} attention` : `${accounts.length} accounts healthy`}
        </span>
        <span className="last-sync">Updated {formatRelative(latestSuccess, now)}</span>
        <button className="button button-primary" onClick={onRefresh} disabled={refreshing || !usage}>
          {refreshing ? <span className="spinner" /> : <Icon name="refresh" />}
          {refreshing ? "Checking…" : "Refresh all"}
        </button>
      </div>
    </header>
  )
}
