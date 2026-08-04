import { isOpenCodeMessageID } from "@opencode-workbench/shared"
import { Buffer } from "node:buffer"
import { createServer, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { ManagedOpenCodeServer } from "../src/managed-server.ts"
import { OpenCodeClient } from "../src/opencode-client.ts"
import { SessionController } from "../src/session-controller.ts"

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => resolve = next)
  return { promise, resolve }
}

async function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds)),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function eventually(condition: () => boolean, milliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${milliseconds}ms`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

Deno.test("controller communicates with OpenCode over authenticated HTTP and SSE", async () => {
  const username = "workbench-test"
  const password = "secret"
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const requests: Array<{ method: string; path: string; directory: string | null; body?: unknown }> = []
  const eventStreams = new Set<ServerResponse>()
  const unhandled: string[] = []
  let session: { id: string; title: string; directory: string; time: { created: number; updated: number } } | undefined
  let projectedMessages: unknown[] = []
  let promptBody: Record<string, unknown> | undefined

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    let body: unknown
    if (request.method !== "GET" && request.method !== "DELETE") {
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
      const text = Buffer.concat(chunks).toString("utf8")
      body = text ? JSON.parse(text) : undefined
    }
    requests.push({ method: request.method ?? "GET", path: url.pathname, directory: url.searchParams.get("directory"), body })
    if (request.headers.authorization !== authorization) {
      response.writeHead(401).end()
      return
    }
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(value))
    }
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      response.write(": connected\n\n")
      eventStreams.add(response)
      request.once("close", () => eventStreams.delete(response))
      return
    }
    if (request.method === "GET" && url.pathname === "/session") return json(session ? [session] : [])
    if (request.method === "GET" && url.pathname === "/session/status") return json({})
    if (request.method === "GET" && url.pathname === "/api/session/active") return json({ data: {} })
    if (request.method === "GET" && url.pathname === "/agent") return json([])
    if (request.method === "GET" && url.pathname === "/config/providers") return json({ providers: [] })
    if (request.method === "GET" && url.pathname === "/config") return json({})
    if (request.method === "GET" && url.pathname === "/experimental/resource") return json({})
    if (request.method === "GET" && url.pathname === "/command") return json([])
    if (request.method === "GET" && ["/lsp", "/formatter", "/mcp"].includes(url.pathname)) return json([])
    if (request.method === "GET" && ["/path", "/vcs"].includes(url.pathname)) return json({})
    if (request.method === "GET" && ["/question", "/permission"].includes(url.pathname)) return json([])
    if (request.method === "GET" && ["/api/question/request", "/api/permission/request"].includes(url.pathname)) return json({ data: [] })
    if (request.method === "POST" && url.pathname === "/session") {
      const title = typeof body === "object" && body && "title" in body && typeof body.title === "string" ? body.title : "New session"
      session = { id: "ses_network", title, directory: "/workspace", time: { created: 1, updated: 1 } }
      return json(session)
    }
    if (request.method === "GET" && url.pathname === "/api/session/ses_network/message") return json({ data: projectedMessages, cursor: {} })
    if (request.method === "GET" && url.pathname === "/session/ses_network/message") return json([])
    if (request.method === "GET" && ["/session/ses_network/todo", "/session/ses_network/diff"].includes(url.pathname)) return json([])
    if (request.method === "POST" && url.pathname === "/api/session/ses_network/prompt") {
      promptBody = body as Record<string, unknown>
      const prompt = promptBody.prompt as { text?: string }
      projectedMessages = [
        { id: promptBody.id, type: "user", time: { created: 2 }, text: prompt.text },
        { id: "msg_assistant", type: "assistant", time: { created: 3, completed: 4 }, content: [{ id: "text", type: "text", text: "Hello from OpenCode" }], finish: "stop" },
      ]
      json({ data: {} })
      setTimeout(() => {
        const events = [
          { type: "session.next.step.started", properties: { sessionID: "ses_network", assistantMessageID: "msg_assistant", timestamp: 3 } },
          { type: "session.next.text.started", properties: { sessionID: "ses_network", assistantMessageID: "msg_assistant", textID: "text" } },
          { type: "session.next.text.delta", properties: { sessionID: "ses_network", assistantMessageID: "msg_assistant", textID: "text", delta: "Hello from OpenCode" } },
          { type: "session.next.step.ended", properties: { sessionID: "ses_network", assistantMessageID: "msg_assistant", finish: "stop" } },
        ]
        for (const event of events) for (const stream of eventStreams) stream.write(`data: ${JSON.stringify(event)}\n\n`)
      }, 0)
      return
    }
    if (request.method === "DELETE" && url.pathname === "/session/ses_network") {
      session = undefined
      return json(true)
    }
    unhandled.push(`${request.method} ${url.pathname}`)
    json({ error: "unhandled" }, 404)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port")
  const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, username, password, directory: "/workspace" })
  const errors: string[] = []
  const controller = new SessionController(client, { error: (value) => errors.push(value) })
  const connected = deferred<void>()
  controller.subscribe((update) => {
    if (update.type === "connected" && update.connected) connected.resolve(undefined)
  })
  try {
    controller.start()
    await within(connected.promise)
    const sessionID = await controller.createSessionWithPrompt("Ping")
    await eventually(() => controller.chatSnapshot().session?.messages.some((message) =>
      message.info.role === "assistant" && message.parts.some((part) => part.text === "Hello from OpenCode")) === true)
    const prompt = promptBody as { id?: string; delivery?: string; resume?: boolean; prompt?: { text?: string } } | undefined
    if (sessionID !== "ses_network" || !isOpenCodeMessageID(prompt?.id) || prompt?.prompt?.text !== "Ping" || prompt.delivery !== "steer" || prompt.resume !== true) {
      throw new Error(`Controller did not submit the expected OpenCode prompt contract: ${JSON.stringify(prompt)}`)
    }
    if (controller.chatSnapshot().session?.status.type !== "idle") throw new Error("Terminal SSE event did not return the session to idle")
    await controller.deleteSession(sessionID)
    if (controller.snapshot.sessions[sessionID]) throw new Error("Successful OpenCode deletion did not update controller state")
    if (unhandled.length || errors.length) throw new Error(`Communication produced errors: ${[...unhandled, ...errors].join(", ")}`)
    if (!requests.length || requests.some((request) => request.directory !== "/workspace")) throw new Error("OpenCode requests did not retain workspace affinity")
    if (!requests.some((request) => request.path === "/event") || !requests.some((request) => request.path === "/api/session/ses_network/prompt")) {
      throw new Error("HTTP request or SSE event channel was not exercised")
    }
  } finally {
    controller.dispose()
    for (const stream of eventStreams) stream.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const integrationExecutable = Deno.env.get("OPENCODE_INTEGRATION_EXECUTABLE")

Deno.test({
  name: "installed OpenCode serves the extension's health, event, session, and fork contracts",
  ignore: !integrationExecutable,
  fn: async () => {
    const workspace = await Deno.makeTempDir()
    const extensionPath = fileURLToPath(new URL("../../../", import.meta.url))
    const output: string[] = []
    const manager = new ManagedOpenCodeServer({
      directory: workspace,
      extensionPath,
      executablePath: integrationExecutable,
      output: { appendLine: (line) => output.push(line) },
    })
    let client: OpenCodeClient | undefined
    let createdID: string | undefined
    let forkedID: string | undefined
    const streamAbort = new AbortController()
    try {
      const connection = await manager.start()
      client = new OpenCodeClient(connection)
      const health = await client.health()
      if (health.version !== "1.18.11") throw new Error(`Expected OpenCode 1.18.11, received ${health.version}`)

      const opened = deferred<void>()
      const createdEvent = deferred<string>()
      const stream = client.events(
        streamAbort.signal,
        () => opened.resolve(undefined),
        (event) => {
          const info = event.properties.info
          if (event.type === "session.created" && typeof info === "object" && info && "id" in info && typeof info.id === "string") createdEvent.resolve(info.id)
        },
      ).catch((error) => {
        if (!streamAbort.signal.aborted) throw error
      })
      await within(opened.promise, 10_000)
      const created = await client.createSession("Workbench integration")
      createdID = created.id
      if (await within(createdEvent.promise, 10_000) !== created.id) throw new Error("OpenCode SSE did not report the created session")
      const renamed = await client.renameSession(created.id, "Workbench integration renamed")
      if (renamed.title !== "Workbench integration renamed") throw new Error("OpenCode did not return the renamed session")
      const forked = await client.forkSession(created.id)
      forkedID = forked.id
      if (forked.id === created.id) throw new Error("OpenCode fork reused the source session ID")
      const listed = await client.listSessions()
      if (!listed.some((session) => session.id === created.id) || !listed.some((session) => session.id === forked.id)) {
        throw new Error("OpenCode session listing omitted a created or forked session")
      }
      const history = await client.messageHistory(created.id)
      if (history.messages.length || history.legacyMessageIDs.length || history.v2MessageIDs.length) throw new Error("New OpenCode session unexpectedly contained messages")
      if (await client.deleteSession(forked.id) !== true || await client.deleteSession(created.id) !== true) throw new Error("OpenCode did not delete integration sessions")
      forkedID = undefined
      createdID = undefined
      streamAbort.abort()
      await stream
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nManaged OpenCode output:\n${output.join("\n")}`)
    } finally {
      streamAbort.abort()
      if (client && forkedID) await client.deleteSession(forkedID).catch(() => undefined)
      if (client && createdID) await client.deleteSession(createdID).catch(() => undefined)
      await manager.stop()
      await Deno.remove(workspace, { recursive: true })
    }
  },
})
