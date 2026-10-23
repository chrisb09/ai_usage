import { useEffect, useMemo, useState } from "react"
import { AccountCard } from "./AccountCard"
import { Header } from "./Header"
import { HistoryChart } from "./HistoryChart"
import { Icon } from "./Icon"
import { getUsage, isPublicPath, refreshAccounts } from "./api"
import { providerOrder } from "./format"
import type { AccountView, UsageResponse } from "./types"

function groupAccounts(accounts: AccountView[]): Array<[string, AccountView[]]> {
  const groups = new Map<string, AccountView[]>()
  for (const account of accounts) {
    const list = groups.get(account.provider) ?? []
    list.push(account)
    groups.set(account.provider, list)
  }

  return [...groups.entries()]
    .sort(([a], [b]) => providerOrder(a) - providerOrder(b) || a.localeCompare(b))
    .map(([provider, list]) => [
      provider,
      [...list].sort((a, b) => a.label.localeCompare(b.label)),
    ])
}

export default function App() {
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [providerFilter, setProviderFilter] = useState("All providers")
  const [search, setSearch] = useState("")
  const isPublic = isPublicPath() || Boolean(usage?.isPublic)

  useEffect(() => {
    if (isPublic) {
      document.title = "AI Usage (Public Overview)"
    }
  }, [isPublic])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let inFlight = false

    const tick = async (): Promise<void> => {
      if (inFlight || cancelled) return
      inFlight = true
      let delay = 30_000
      try {
        const data = await getUsage()
        if (cancelled) return
        setUsage(data)
        setPollError(null)
        delay = data.refreshing ? 2_000 : 30_000
      } catch (error) {
        if (cancelled) return
        setPollError(error instanceof Error ? error.message : String(error))
        delay = 15_000
      } finally {
        inFlight = false
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void tick()
          }, delay)
        }
      }
    }

    void tick()

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        if (timer) window.clearTimeout(timer)
        void tick()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  const activeAccounts = useMemo(
    () => (usage?.accounts ?? []).filter((account) => account.active),
    [usage],
  )
  const groups = useMemo(() => groupAccounts(activeAccounts), [activeAccounts])
  const visibleGroups = groups
    .filter(([provider]) => providerFilter === "All providers" || providerFilter === provider)
    .map(([provider, accounts]): [string, AccountView[]] => [provider, accounts.filter((account) => `${account.label} ${account.provider}`.toLowerCase().includes(search.toLowerCase()))])
    .filter(([, accounts]) => accounts.length > 0)

  const reload = async (): Promise<void> => {
    const data = await getUsage()
    setUsage(data)
    setPollError(null)
  }

  const handleRefreshAll = async (): Promise<void> => {
    setRefreshingAll(true)
    setActionMessage(null)
    try {
      const result = await refreshAccounts()
      const failures = result.refreshed.filter((entry) => entry.error)
      const skipped = result.skipped.length
      if (failures.length > 0) {
        setActionMessage(
          `${failures.length} check${failures.length === 1 ? "" : "s"} failed: ${failures
            .map((entry) => `${entry.label}: ${entry.error}`)
            .join("; ")}`,
        )
      } else if (skipped > 0) {
        setActionMessage(`${skipped} account(s) skipped (manual refresh cooldown).`)
      }
      await reload()
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshingAll(false)
    }
  }

  const handleRefreshAccount = async (accountKey: string): Promise<void> => {
    setActionMessage(null)
    try {
      const result = await refreshAccounts([accountKey])
      const failure = result.refreshed.find((entry) => entry.error)
      if (failure?.error) setActionMessage(`${failure.label}: ${failure.error}`)
      const skipped = result.skipped[0]
      if (skipped) setActionMessage(skipped.reason)
      await reload()
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="app">
      <Header usage={usage} now={now} refreshing={refreshingAll} onRefresh={() => void handleRefreshAll()} isPublic={isPublic} />

      <main>
        {pollError && <div role="alert" className="banner banner-error">API error: {pollError}</div>}
        {actionMessage && <div role="status" className="banner banner-warn">{actionMessage}</div>}

        {!usage ? (
          <div className="loading-state">
            <span className="spinner spinner-large" />
            Loading usage…
          </div>
        ) : (
          <>
            {usage.accounts.length > 0 && <HistoryChart accounts={usage.accounts} />}

            <section className="accounts-section" id="accounts" aria-labelledby="accounts-title">
              <div className="accounts-toolbar">
              <h2 id="accounts-title">Accounts <span className="heading-count">{activeAccounts.length}</span></h2>
              <div className="provider-filters" aria-label="Filter accounts by provider">
                {["All providers", ...groups.map(([provider]) => provider)].map((provider) => <button key={provider} className={`filter-button ${providerFilter === provider ? "filter-active" : ""}`} aria-pressed={providerFilter === provider} onClick={() => setProviderFilter(provider)}>{provider}<span>{provider === "All providers" ? activeAccounts.length : groups.find(([name]) => name === provider)?.[1].length}</span></button>)}
              </div>
              <label className="search-field"><Icon name="search" /><input type="search" aria-label="Search accounts" placeholder="Search accounts…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              </div>
            {activeAccounts.length === 0 && (
              <section className="panel setup-panel">
                <h2>No provider accounts found</h2>
                <p>
                  Mount your credential files into the container and make sure they are
                  readable. The collector looks for Antigravity, OpenCode Go, Codex, and
                   OneProvider configuration files, plus VNAI Pro in the OpenCode auth store.
                </p>
                {usage.scheduler.ticking && (
                  <p className="muted">
                    <span className="spinner" /> Waiting for the first discovery cycle…
                  </p>
                )}
              </section>
            )}

                <div className="account-list">
                  {visibleGroups.flatMap(([, accounts]) => accounts).map((account) => (
                    <AccountCard
                      key={account.accountKey}
                      account={account}
                      now={now}
                      onRefresh={handleRefreshAccount}
                      isPublic={isPublic}
                    />
                  ))}
                </div>
            {activeAccounts.length > 0 && visibleGroups.length === 0 && <div className="history-empty">No accounts match your search.</div>}
            </section>
          </>
        )}
      </main>

    </div>
  )
}
