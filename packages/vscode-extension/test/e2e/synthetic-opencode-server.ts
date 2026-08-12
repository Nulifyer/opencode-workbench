import { Buffer } from "node:buffer"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

export interface SyntheticOpenCodeRequest {
  method: string
  path: string
  directory: string | null
  body?: unknown
}

export interface SyntheticOpenCodeState {
  requests: SyntheticOpenCodeRequest[]
  promptRequests: SyntheticOpenCodeRequest[]
  sessions: Array<{ id: string; title: string; directory: string; time: { created: number; updated: number } }>
  unhandled: string[]
}

export interface SyntheticOpenCodeServer {
  url: string
  username: string
  password: string
  close(): Promise<void>
}

const MAX_BODY_BYTES = 1024 * 1024

async function requestBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return undefined
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error("Synthetic OpenCode request exceeded 1 MiB")
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : undefined
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}

export async function startSyntheticOpenCodeServer(): Promise<SyntheticOpenCodeServer> {
  const username = "workbench-e2e"
  const password = "synthetic-password"
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const requests: SyntheticOpenCodeRequest[] = []
  const promptRequests: SyntheticOpenCodeRequest[] = []
  const sessions: SyntheticOpenCodeState["sessions"] = []
  const unhandled: string[] = []
  const eventStreams = new Set<ServerResponse>()
  let nextSession = 1

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const json = (value: unknown, status = 200): void => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(value))
    }
    if (request.headers.authorization !== authorization) {
      response.writeHead(401).end()
      return
    }

    let body: unknown
    try {
      body = await requestBody(request)
    } catch (error) {
      json({ error: error instanceof Error ? error.message : String(error) }, 400)
      return
    }
    const observed = {
      method: request.method ?? "GET",
      path: url.pathname,
      directory: url.searchParams.get("directory") ?? url.searchParams.get("location[directory]"),
      ...(body === undefined ? {} : { body }),
    }
    requests.push(observed)

    if (request.method === "GET" && url.pathname === "/__workbench_e2e/state") {
      json({ requests, promptRequests, sessions, unhandled } satisfies SyntheticOpenCodeState)
      return
    }
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      response.write(": connected\n\n")
      eventStreams.add(response)
      request.once("close", () => eventStreams.delete(response))
      return
    }
    if (request.method === "GET" && url.pathname === "/global/health") {
      json({ healthy: true, version: "1.18.11" })
      return
    }
    if (request.method === "GET" && url.pathname === "/session") return json(sessions)
    if (request.method === "GET" && url.pathname === "/session/status") return json({})
    if (request.method === "GET" && url.pathname === "/api/session/active") return json({ data: {} })
    if (request.method === "GET" && url.pathname === "/agent") return json([])
    if (request.method === "GET" && url.pathname === "/config/providers") return json({ providers: [] })
    if (request.method === "GET" && url.pathname === "/config") return json({})
    if (request.method === "GET" && url.pathname === "/experimental/resource") return json({})
    if (request.method === "GET" && url.pathname === "/command") return json([])
    if (request.method === "GET" && url.pathname === "/pty") return json([])
    if (request.method === "GET" && ["/lsp", "/formatter", "/mcp"].includes(url.pathname)) return json([])
    if (request.method === "GET" && ["/path", "/vcs"].includes(url.pathname)) return json({})
    if (request.method === "GET" && ["/question", "/permission"].includes(url.pathname)) return json([])
    if (request.method === "GET" && ["/api/question/request", "/api/permission/request"].includes(url.pathname)) {
      return json({ data: [] })
    }
    if (request.method === "POST" && url.pathname === "/session") {
      const title = typeof body === "object" && body && "title" in body && typeof body.title === "string"
        ? body.title
        : "New session"
      const now = Date.now()
      const session = {
        id: `ses_vscode_e2e_${nextSession++}`,
        title,
        directory: observed.directory ?? "",
        time: { created: now, updated: now },
      }
      sessions.push(session)
      json(session)
      return
    }
    const sessionMatch = /^\/session\/([^/]+)(?:\/(message|todo|diff|prompt_async))?$/.exec(url.pathname)
    const v2MessageMatch = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (request.method === "GET" && sessionMatch?.[2] === "message") return json([])
    if (request.method === "GET" && ["todo", "diff"].includes(sessionMatch?.[2] ?? "")) return json([])
    if (request.method === "GET" && v2MessageMatch) return json({ data: [], cursor: {} })
    if (request.method === "DELETE" && sessionMatch && !sessionMatch[2]) {
      const index = sessions.findIndex((session) => session.id === decodeURIComponent(sessionMatch[1]!))
      if (index >= 0) sessions.splice(index, 1)
      return json(index >= 0)
    }
    if (
      request.method === "POST" &&
      (sessionMatch?.[2] === "prompt_async" || /^\/api\/session\/[^/]+\/prompt$/.test(url.pathname))
    ) {
      promptRequests.push(observed)
      response.writeHead(204).end()
      return
    }

    unhandled.push(`${request.method} ${url.pathname}`)
    json({ error: "unhandled synthetic OpenCode request" }, 404)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Synthetic OpenCode server did not bind a TCP port")

  return {
    url: `http://127.0.0.1:${address.port}`,
    username,
    password,
    close: async () => {
      for (const stream of eventStreams) stream.end()
      await closeServer(server)
    },
  }
}
