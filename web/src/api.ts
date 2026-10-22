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

export function getUsage(): Promise<UsageResponse> {
  return request<UsageResponse>("/api/usage")
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
  return request<HistoryResponse>(`/api/history?${params.toString()}`)
}

export function refreshAccounts(accountKeys?: string[]): Promise<RefreshResponse> {
  return request<RefreshResponse>("/api/refresh", {
    method: "POST",
    body: JSON.stringify(accountKeys ? { accountKeys } : {}),
  })
}
