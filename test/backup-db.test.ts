import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { backupDatabase } from "../src/backup-db.js"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ai-usage-backup-"))
  directories.push(directory)
  return { source: join(directory, "live.db"), destination: join(directory, "snapshot.db") }
}

describe("database snapshots", () => {
  it("includes committed WAL data while the source remains open", async () => {
    const { source, destination } = await fixture()
    const live = new Database(source)
    live.pragma("journal_mode = WAL")
    live.pragma("wal_autocheckpoint = 0")
    live.exec("CREATE TABLE observations (remaining REAL); INSERT INTO observations VALUES (0.5), (0.75)")
    try {
      expect(existsSync(`${source}-wal`)).toBe(true)
      await backupDatabase(source, destination)
      live.exec("INSERT INTO observations VALUES (1)")
      const snapshot = new Database(destination, { readonly: true })
      try {
        expect(snapshot.prepare("SELECT remaining FROM observations").all()).toEqual([{ remaining: 0.5 }, { remaining: 0.75 }])
        expect(snapshot.pragma("integrity_check", { simple: true })).toBe("ok")
        expect(live.prepare("SELECT COUNT(*) AS count FROM observations").get()).toEqual({ count: 3 })
      } finally {
        snapshot.close()
      }
    } finally {
      live.close()
    }
  })

  it("does not overwrite an existing database", async () => {
    const { source, destination } = await fixture()
    const db = new Database(source)
    db.exec("CREATE TABLE original (id INTEGER)")
    db.close()
    await backupDatabase(source, destination)
    await expect(backupDatabase(source, destination)).rejects.toThrow("already exists")
    await expect(backupDatabase(source, source)).rejects.toThrow("must differ")
  })

  it("does not silently create an empty source database", async () => {
    const { source, destination } = await fixture()
    await expect(backupDatabase(source, destination)).rejects.toThrow()
    expect(existsSync(source)).toBe(false)
    expect(existsSync(destination)).toBe(false)
  })
})
