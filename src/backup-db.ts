import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "./config.js"

export async function backupDatabase(source: string, destination: string): Promise<string> {
  const sourcePath = resolve(source)
  const destinationPath = resolve(destination)
  if (sourcePath === destinationPath) throw new Error("Backup destination must differ from the source database")
  if (existsSync(destinationPath)) throw new Error("Backup destination already exists; choose a new filename")

  const db = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    await mkdir(dirname(destinationPath), { recursive: true })
    await db.backup(destinationPath)
    return destinationPath
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const destination = process.argv[2]
  if (!destination) throw new Error("Usage: npm run backup:db -- /path/to/backup.db")
  const config = loadConfig()
  const path = await backupDatabase(config.databasePath, destination)
  console.log(`Database snapshot created: ${path}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
