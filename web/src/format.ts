export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "?"
  return `${Math.round(value * 100)}%`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  if (seconds < 90) return `${Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 48) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function formatRelative(value: string | null, now = Date.now()): string {
  if (!value) return "never"
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return "unknown"
  const delta = Math.max(0, now - ms)
  if (delta < 45_000) return "just now"
  return `${formatDuration(delta / 1000)} ago`
}

export function formatCountdown(value: string | null, now = Date.now()): string {
  if (!value) return "soon"
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return "soon"
  const delta = ms - now
  if (delta <= 0) return "now"
  return `in ${formatDuration(delta / 1000)}`
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return date.toLocaleString()
}

export function formatMoney(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return `$${value.toFixed(2)}`
}

export function barTone(value: number | null): "good" | "warn" | "bad" | "unknown" {
  if (value === null || !Number.isFinite(value)) return "unknown"
  if (value >= 0.5) return "good"
  if (value >= 0.2) return "warn"
  return "bad"
}

export function providerOrder(provider: string): number {
  switch (provider) {
    case "Google":
      return 0
    case "OpenCode Go":
      return 1
    case "Codex":
      return 2
    case "OneProvider":
      return 3
    default:
      return 9
  }
}

const SERIES_COLORS = [
  "#89b4fa",
  "#a6e3a1",
  "#f9e2af",
  "#f38ba8",
  "#cba6f7",
  "#fab387",
  "#94e2d5",
  "#f5c2e7",
]

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? "#89b4fa"
}
