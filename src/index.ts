import Fastify from "fastify"
import rateLimit from "@fastify/rate-limit"
import { loadConfig } from "./config.js"
import { UsageDatabase } from "./db.js"
import { UsageScheduler } from "./scheduler.js"
import { registerApi } from "./api.js"
import { registerMcp } from "./mcp.js"
import { registerStatic } from "./static.js"

async function main(): Promise<void> {
  const config = loadConfig()

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
    },
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustProxy,
  })

  const db = new UsageDatabase(config.databasePath)
  const scheduler = new UsageScheduler(db, config, app.log)

  await app.register(rateLimit, { global: false })
  registerApi(app, { config, db, scheduler })
  registerMcp(app, { config, db, scheduler })
  await registerStatic(app, config.webRoot)

  app.setNotFoundHandler((_request, reply) => {
    return reply
      .code(404)
      .send({ error: { code: "not_found", message: "Not found" } })
  })

  app.setErrorHandler((error, request, reply) => {
    app.log.error({ error, url: request.url, method: request.method }, "request failed")
    const err = error as Error & { statusCode?: number }
    const status = err.statusCode ?? 500
    return reply.code(status).send({
      error: {
        code: status < 500 ? "request_failed" : "internal_error",
        message: status < 500 ? err.message : "Internal server error",
      },
    })
  })

  app.addHook("onClose", async () => {
    await scheduler.stop()
    db.close()
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, "shutting down")
    try {
      await app.close()
      process.exit(0)
    } catch (error) {
      app.log.error({ error }, "shutdown failed")
      process.exit(1)
    }
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT")
  })
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM")
  })

  await app.listen({ host: config.host, port: config.port })

  app.log.info(
    {
      port: config.port,
      host: config.host,
      databasePath: config.databasePath,
      policy: config.policy,
    },
    "ai-usage server started",
  )

  scheduler.start()
}

main().catch((error: unknown) => {
  console.error("ai-usage: failed to start", error)
  process.exitCode = 1
})
