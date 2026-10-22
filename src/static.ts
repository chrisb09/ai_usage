import { existsSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import type { FastifyInstance } from "fastify"
import fastifyStatic from "@fastify/static"

export async function registerStatic(
  app: FastifyInstance,
  webRoot: string,
): Promise<void> {
  const indexFile = join(webRoot, "index.html")
  if (!existsSync(indexFile)) {
    app.get("/", async () => ({
      name: "ai-usage",
      message: "Web UI not built. Run `npm run build`.",
    }))
    return
  }

  const root = resolve(webRoot)
  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    wildcard: false,
    index: false,
  })

  app.get("/", async (_request, reply) => {
    reply.header("Cache-Control", "no-cache")
    return reply.sendFile("index.html")
  })

  app.get("/*", async (request, reply) => {
    const urlPath = request.url.split("?")[0] ?? "/"
    if (urlPath.startsWith("/api/")) {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Not found" } })
    }

    let filePath: string
    try {
      filePath = decodeURIComponent(urlPath.replace(/^\/+/, ""))
    } catch {
      return reply
        .code(400)
        .send({ error: { code: "invalid_path", message: "Invalid path" } })
    }

    const candidate = resolve(root, filePath)
    if (!candidate.startsWith(root + sep)) {
      return reply
        .code(400)
        .send({ error: { code: "invalid_path", message: "Invalid path" } })
    }

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      reply.header(
        "Cache-Control",
        filePath.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      )
      return reply.sendFile(filePath)
    }

    reply.header("Cache-Control", "no-cache")
    return reply.sendFile("index.html")
  })
}
