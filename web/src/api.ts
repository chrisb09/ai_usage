import type {
  ApiErrorBody,
  HistoryResponse,
  RefreshResponse,
  UsageResponse,
} from "./types"

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as ApiErrorBody
      message = body.error?.message || message
    } catch {
    }
    throw new Error(message)
  }

  return (await response.json()) as T
}

export function isPublicPath(): boolean {
  if (typeof window === "undefined") return false
  const path = window.location.pathname
  return path === "/public" || path.startsWith("/public/")
}

export function getUsage(): Promise<UsageResponse> {
  const url = isPublicPath() ? "/api/public/usage" : "/api/usage"
  return request<UsageResponse>(url)
}

export function getHistory(args: {
  accountKey?: string
  from?: string
  to?: string
  bucketSec?: number
}): Promise<HistoryResponse> {
  const params = new URLSearchParams()
  if (args.accountKey) params.set("accountKey", args.accountKey)
  if (args.from) params.set("from", args.from)
  if (args.to) params.set("to", args.to)
  if (args.bucketSec) params.set("bucketSec", String(args.bucketSec))
  const endpoint = isPublicPath() ? "/api/public/history" : "/api/history"
  return request<HistoryResponse>(`${endpoint}?${params.toString()}`)
}

export function refreshAccounts(accountKeys?: string[]): Promise<RefreshResponse> {
  if (isPublicPath()) {
    return Promise.reject(new Error("Manual refresh is not available in public mode."))
  }
  return request<RefreshResponse>("/api/refresh", {
    method: "POST",
    body: JSON.stringify(accountKeys ? { accountKeys } : {}),
  })
}
