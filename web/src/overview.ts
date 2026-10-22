interface WindowedQuota {
  key?: string
  quotaKey?: string
  label: string
}

export function isApiKeyProvider(provider: string): boolean {
  return provider === "OneProvider" || provider === "VNAI Pro"
}

export function overviewPool(provider: string, quota: WindowedQuota): string {
  if (provider !== "Google") return provider
  const name = `${quota.key ?? quota.quotaKey ?? ""} ${quota.label}`.toLowerCase()
  if (name.includes("gemini")) return "Google · Gemini"
  if (name.includes("claude") || name.includes("gpt")) return "Google · Claude"
  return "Google · Other"
}

export function overviewWindow(quota: WindowedQuota): "weekly" | "monthly" | null {
  const name = `${quota.key ?? quota.quotaKey ?? ""} ${quota.label}`
  if (/(?:^|[^a-z0-9])(?:monthly|30[\s-]*(?:d|days?))(?:$|[^a-z0-9])/i.test(name)) return "monthly"
  if (/(?:^|[^a-z0-9])(?:weekly|7[\s-]*(?:d|days?))(?:$|[^a-z0-9])/i.test(name)) return "weekly"
  return null
}

// A monthly plan and its weekly sublimit describe the same allowance.
// Prefer the monthly window when available rather than counting both.
export function overviewQuotas<T extends WindowedQuota>(quotas: T[]): T[] {
  const window = quotas.some((quota) => overviewWindow(quota) === "monthly")
    ? "monthly"
    : "weekly"
  return quotas.filter((quota) => overviewWindow(quota) === window)
}
