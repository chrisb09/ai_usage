import { loadConfig } from "./config.js"
import { createCollectors, discoverAccounts } from "./collectors/index.js"
import { errorResult } from "./collectors/util.js"

async function main(): Promise<void> {
  const config = loadConfig()
  const collectors = createCollectors(config)
  const accounts = await discoverAccounts(collectors)

  const results = await Promise.all(
    [...accounts.values()].map(async ({ ref, collector }) => {
      const startedAt = Date.now()
      try {
        return await collector.collect(ref)
      } catch (error) {
        return errorResult(
          ref,
          error instanceof Error ? error.message : String(error),
          Date.now() - startedAt,
        )
      }
    }),
  )

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        accounts: results.length,
        results,
      },
      null,
      2,
    ),
  )
}

main().catch((error: unknown) => {
  console.error("ai-usage collect failed", error)
  process.exitCode = 1
})
