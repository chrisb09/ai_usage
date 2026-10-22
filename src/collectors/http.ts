import http from "node:http"
import https from "node:https"
import tls from "node:tls"

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | URLSearchParams
  timeoutMs?: number
}

export interface HttpResponse {
  ok: boolean
  status: number
  statusText: string
  redirected: boolean
  text: () => Promise<string>
  json: () => Promise<unknown>
}

function responseFromBuffer(
  status: number,
  statusText: string,
  redirected: boolean,
  buffer: Buffer,
): HttpResponse {
  const text = buffer.toString("utf8")
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    redirected,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  }
}

function proxyUrlFromEnv(): string | null {
  return (
    process.env.MY_PROXY_URL ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy ||
    null
  )
}

async function makeProxyRequest(
  urlStr: string,
  options: HttpOptions,
  proxyUrlStr: string,
): Promise<HttpResponse> {
  const targetUrl = new URL(urlStr)
  const proxyUrl = new URL(proxyUrlStr)

  const isHttps = targetUrl.protocol === "https:"
  const targetHost = targetUrl.hostname
  const targetPort = Number(targetUrl.port) || (isHttps ? 443 : 80)
  const proxyHost = proxyUrl.hostname
  const proxyPort =
    Number(proxyUrl.port) || (proxyUrl.protocol === "https:" ? 443 : 80)

  const body =
    options.body instanceof URLSearchParams
      ? options.body.toString()
      : options.body ?? null

  return new Promise((resolve, reject) => {
    let req: http.ClientRequest | null = null
    let socketRef: NodeJS.ReadWriteStream | null = null

    const onAbort = () => {
      req?.destroy()
      if (socketRef && "destroy" in socketRef && typeof socketRef.destroy === "function") {
        socketRef.destroy()
      }
      reject(new Error("Request aborted"))
    }

    if (options.timeoutMs) {
      const timer = setTimeout(onAbort, options.timeoutMs)
      timer.unref()
      const clear = () => clearTimeout(timer)
      const originalResolve = resolve
      const originalReject = reject
      resolve = ((value: HttpResponse) => {
        clear()
        originalResolve(value)
      }) as typeof resolve
      reject = ((reason?: unknown) => {
        clear()
        originalReject(reason)
      }) as typeof reject
    }

    if (isHttps) {
      const connectHeaders: Record<string, string> = {
        Host: `${targetHost}:${targetPort}`,
      }
      if (proxyUrl.username || proxyUrl.password) {
        const auth = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(
          proxyUrl.password,
        )}`
        connectHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(auth).toString(
          "base64",
        )}`
      }

      req = http.request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${targetHost}:${targetPort}`,
        headers: connectHeaders,
      })

      req.on("error", reject)

      req.on("connect", (res, socket) => {
        socketRef = socket
        if (res.statusCode !== 200) {
          socket.destroy()
          reject(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`))
          return
        }

        const tlsSocket = tls.connect({ socket, servername: targetHost })
        tlsSocket.on("error", reject)

        const headers = { ...(options.headers ?? {}) }
        if (body && !headers["Content-Length"] && !headers["content-length"]) {
          headers["Content-Length"] = String(Buffer.byteLength(body))
        }

        const clientReq = https.request({
          host: targetHost,
          port: targetPort,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: options.method || "GET",
          headers,
          createConnection: () => tlsSocket,
        })

        clientReq.on("error", reject)
        clientReq.on("response", (clientRes) => {
          const chunks: Buffer[] = []
          clientRes.on("data", (chunk: Buffer) => chunks.push(chunk))
          clientRes.on("end", () => {
            resolve(
              responseFromBuffer(
                clientRes.statusCode ?? 0,
                clientRes.statusMessage ?? "",
                (clientRes.statusCode ?? 0) >= 300 &&
                  (clientRes.statusCode ?? 0) < 400,
                Buffer.concat(chunks),
              ),
            )
          })
        })

        if (body) clientReq.write(body)
        clientReq.end()
      })

      req.end()
      return
    }

    const headers = { ...(options.headers ?? {}) }
    if (proxyUrl.username || proxyUrl.password) {
      const auth = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(
        proxyUrl.password,
      )}`
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`
    }
    if (body && !headers["Content-Length"] && !headers["content-length"]) {
      headers["Content-Length"] = String(Buffer.byteLength(body))
    }

    req = http.request({
      host: proxyHost,
      port: proxyPort,
      path: urlStr,
      method: options.method || "GET",
      headers,
    })

    req.on("error", reject)
    req.on("response", (clientRes) => {
      const chunks: Buffer[] = []
      clientRes.on("data", (chunk: Buffer) => chunks.push(chunk))
      clientRes.on("end", () => {
        resolve(
          responseFromBuffer(
            clientRes.statusCode ?? 0,
            clientRes.statusMessage ?? "",
            (clientRes.statusCode ?? 0) >= 300 && (clientRes.statusCode ?? 0) < 400,
            Buffer.concat(chunks),
          ),
        )
      })
    })

    if (body) req.write(body)
    req.end()
  })
}

export async function fetchWithTimeout(
  url: string,
  options: HttpOptions = {},
  defaultTimeoutMs = 15_000,
): Promise<HttpResponse> {
  const proxyUrl = proxyUrlFromEnv()
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs

  if (proxyUrl) {
    return makeProxyRequest(url, { ...options, timeoutMs }, proxyUrl)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref()

  try {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body:
        options.body instanceof URLSearchParams
          ? options.body.toString()
          : options.body,
      signal: controller.signal,
    })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
