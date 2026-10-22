import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import type { AccountRef } from "./domain.js"
import { loadConfig } from "./config.js"
import { UsageDatabase } from "./db.js"
import { slugify } from "./policy.js"

interface ImportRow {
  timestamp: string
  account: string
  provider: string
  metric: string
  remainingPct: number
}

interface ImportGroup {
  checkedAt: string
  ref: AccountRef
  quotas: Array<{
    key: string
    label: string
    remaining: number | null
    resetAt: string | null
  }>
}

export function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i]

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (char === "\r") {
    } else {
      field += char
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

export function parseRows(content: string): ImportRow[] {
  const rows = parseCsv(content.replace(/^\uFEFF/, ""))
  const header = rows.shift()?.map((value) => value.trim()) ?? []
  const index = {
    timestamp: header.indexOf("timestamp"),
    account: header.indexOf("account"),
    provider: header.indexOf("provider"),
    metric: header.indexOf("metric"),
    remaining: header.indexOf("remaining_pct"),
  }

  if (Object.values(index).some((value) => value < 0)) {
    throw new Error(
      "CSV must contain timestamp,account,provider,metric,remaining_pct columns",
    )
  }

  const parsed: ImportRow[] = []
  for (const row of rows) {
    if (row.length === 0 || row.every((value) => value.trim() === "")) continue

    const timestampRaw = row[index.timestamp]?.trim() ?? ""
    const timestampMs = Date.parse(timestampRaw)
    const remainingRaw = row[index.remaining]?.trim() ?? ""
    const remaining = Number.parseFloat(remainingRaw)

    if (!Number.isFinite(timestampMs) || !Number.isFinite(remaining)) continue

    parsed.push({
      timestamp: new Date(timestampMs).toISOString(),
      account: row[index.account]?.trim() || "Unknown",
      provider: row[index.provider]?.trim() || "Other",
      metric: row[index.metric]?.trim() || "Usage",
      remainingPct: remaining,
    })
  }

  return parsed
}

export function accountRef(row: ImportRow): AccountRef {
  const account = row.account.toLowerCase()

  switch (row.provider) {
    case "Google":
      return {
        accountKey: `google:${account}`,
        provider: "Google",
        label: row.account,
        collectorId: "antigravity",
      }
    case "OpenCode Go":
      return {
        accountKey: "opencode-go:default",
        provider: "OpenCode Go",
        label: row.account,
        collectorId: "opencode-go",
      }
    case "Codex":
      return {
        accountKey: "codex:default",
        provider: "Codex",
        label: row.account,
        collectorId: "codex",
      }
    case "OneProvider":
      return {
        accountKey: "oneprovider:default",
        provider: "OneProvider",
        label: row.account,
        collectorId: "oneprovider",
      }
    default:
      return {
        accountKey: `${slugify(row.provider) || "other"}:default`,
        provider: row.provider,
        label: row.account,
        collectorId: slugify(row.provider) || "other",
      }
  }
}

async function main(): Promise<void> {
  const csvPath = process.argv[2]
  if (!csvPath) {
    console.error("Usage: npm run import:csv -- /path/to/usage_history.csv")
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  const rows = parseRows(await readFile(csvPath, "utf8"))
  const groups = new Map<string, ImportGroup>()

  for (const row of rows) {
    const ref = accountRef(row)
    const groupKey = `${row.timestamp}|${ref.accountKey}`
    const group = groups.get(groupKey) ?? {
      checkedAt: row.timestamp,
      ref,
      quotas: [],
    }
    group.quotas.push({
      key: slugify(row.metric),
      label: row.metric,
      remaining: Math.max(0, Math.min(1, row.remainingPct / 100)),
      resetAt: null,
    })
    groups.set(groupKey, group)
  }

  const db = new UsageDatabase(config.databasePath)
  let inserted = 0
  let existing = 0
  try {
    for (const group of groups.values()) {
      const wasInserted = db.insertImportedCheck({
        ref: group.ref,
        checkedAt: group.checkedAt,
        quotas: group.quotas,
        minIntervalSec: config.policy.minIntervalSec,
      })
      if (wasInserted) inserted += 1
      else existing += 1
    }
  } finally {
    db.close()
  }

  console.log(
    JSON.stringify(
      {
        csv: csvPath,
        rows: rows.length,
        groups: groups.size,
        insertedChecks: inserted,
        existingChecks: existing,
        database: config.databasePath,
      },
      null,
      2,
    ),
  )
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error("ai-usage CSV import failed", error)
    process.exitCode = 1
  })
}
