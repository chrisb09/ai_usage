import { describe, expect, it } from "vitest"
import { UsageDatabase } from "../src/db.js"
import { accountRef, parseCsv, parseRows } from "../src/import-csv.js"
import { slugify } from "../src/policy.js"

const CSV = `timestamp,account,provider,metric,remaining_pct
2026-10-01T00:00:00.000Z,"user,test@gmail.com",Google,Gemini — Weekly,94.8
2026-10-01T00:00:00.000Z,"user,test@gmail.com",Google,Claude — Weekly,40.0
2026-10-01T00:00:00.000Z,me@example.com,Codex,Codex — Weekly,88.5
`

describe("CSV parsing", () => {
  it("handles quoted fields", () => {
    const rows = parseCsv(CSV)
    expect(rows).toHaveLength(4)
    expect(rows[1]?.[1]).toBe("user,test@gmail.com")
  })

  it("parses valid rows and skips invalid percentages", () => {
    const rows = parseRows(`${CSV}invalid,someone,Google,Gemini — Weekly,nope\n`)
    expect(rows).toHaveLength(3)
    expect(rows[0]?.remainingPct).toBeCloseTo(94.8)
    expect(rows[2]?.provider).toBe("Codex")
  })

  it("maps providers to stable account keys", () => {
    const rows = parseRows(CSV)
    expect(accountRef(rows[0]!).accountKey).toBe("google:user,test@gmail.com")
    expect(accountRef(rows[2]!).accountKey).toBe("codex:default")
  })
})

describe("database import", () => {
  it("inserts grouped observations and ignores duplicates", () => {
    const db = new UsageDatabase(":memory:")
    const rows = parseRows(CSV)
    const first = rows[0]!

    const inserted = db.insertImportedCheck({
      ref: accountRef(first),
      checkedAt: first.timestamp,
      quotas: rows.slice(0, 2).map((row) => ({
        key: slugify(row.metric),
        label: row.metric,
        remaining: row.remainingPct / 100,
        resetAt: null,
      })),
      minIntervalSec: 600,
    })

    expect(inserted).toBe(true)
    expect(db.getCounts().checks).toBe(1)
    expect(db.getCounts().observations).toBe(2)

    const duplicate = db.insertImportedCheck({
      ref: accountRef(first),
      checkedAt: first.timestamp,
      quotas: [],
      minIntervalSec: 600,
    })
    expect(duplicate).toBe(false)

    const history = db.getHistory({ accountKey: "google:user,test@gmail.com" })
    expect(history).toHaveLength(2)
    expect(history.some((point) => point.remaining?.toFixed(3) === "0.948")).toBe(true)
    db.close()
  })
})
