import { createServer, type ServerResponse } from "node:http"
import { OpenCodeClient } from "../src/opencode-client.ts"
import { SessionController } from "../src/session-controller.ts"
import { isGoalContinuationMessage } from "../src/webview/presentation.ts"

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => resolve = next)
  return { promise, resolve }
}

async function within<T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> {
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

async function eventually(condition: () => boolean, milliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${milliseconds}ms`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function writeEvent(stream: ServerResponse, event: unknown): Promise<void> {
  if (stream.write(`data: ${JSON.stringify(event)}\n\n`)) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for SSE backpressure to drain")), 10_000)
    const cleanup = () => {
      clearTimeout(timer)
      stream.off("drain", onDrain)
      stream.off("close", onClose)
      stream.off("error", onError)
    }
    const finish = (error?: Error) => {
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onDrain = () => finish()
    const onClose = () => finish(new Error("SSE stream closed while waiting for backpressure"))
    const onError = (error: Error) => finish(error)
    stream.once("drain", onDrain)
    stream.once("close", onClose)
    stream.once("error", onError)
    if (stream.destroyed) onClose()
  })
}

Deno.test("synthetic event pipeline preserves interleaved streams under backpressure", async () => {
  const opened = deferred<ServerResponse>()
  const session = { id: "ses_stress", title: "Stress", directory: "/workspace", time: { created: 1, updated: 1 } }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const json = (value: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify(value))
    }
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      response.write(": connected\n\n")
      opened.resolve(response)
      return
    }
    if (request.method === "GET" && url.pathname === "/session") return json([session])
    if (request.method === "GET" && url.pathname === "/session/status") return json({ ses_stress: { type: "busy" } })
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
    if (request.method === "GET" && ["/api/question/request", "/api/permission/request"].includes(url.pathname)) return json({ data: [] })
    if (request.method === "GET" && url.pathname === "/api/session/ses_stress/message") return json({ data: [], cursor: {} })
    if (request.method === "GET" && url.pathname === "/session/ses_stress/message") return json([])
    if (request.method === "GET" && ["/session/ses_stress/todo", "/session/ses_stress/diff"].includes(url.pathname)) return json([])
    response.writeHead(404).end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Stress server did not bind a TCP port")
  const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, username: "", password: "", directory: "/workspace" })
  const errors: string[] = []
  const controller = new SessionController(client, { error: (error) => errors.push(error) })
  const connected = deferred<void>()
  let eventStream: ServerResponse | undefined
  controller.subscribe((update) => {
    if (update.type === "connected" && update.connected) connected.resolve(undefined)
  })

  try {
    controller.start()
    const stream = await within(opened.promise)
    eventStream = stream
    await within(connected.promise)
    for (const id of ["assistant-a", "assistant-b"]) {
      await writeEvent(stream, { type: "message.updated", properties: { info: { id, sessionID: session.id, role: "assistant" } } })
      await writeEvent(stream, { type: "message.part.updated", properties: { part: { id: `${id}-text`, messageID: id, sessionID: session.id, type: "text", text: "" } } })
    }
    const expectedParts = { a: [] as string[], b: [] as string[] }
    const goalContinuationCount = 1_000
    for (let index = 0; index < 20_000; index += 1) {
      if (index % 20 === 0) {
        const sequence = index / 20
        const messageID = `goal-${sequence}`
        await writeEvent(stream, { type: "message.updated", properties: { info: { id: messageID, sessionID: session.id, role: "user" } } })
        await writeEvent(stream, { type: "message.part.updated", properties: { part: {
          id: `${messageID}-text`,
          messageID,
          sessionID: session.id,
          type: "text",
          text: `Continue goal turn ${sequence}`,
          synthetic: true,
          metadata: { "opencode-workbench": { kind: "goal-continuation", version: 1 } },
        } } })
      }
      const suffix = index % 2 === 0 ? "a" : "b"
      const delta = `${suffix}${Math.floor(index / 2).toString(36).padStart(3, "0")}|`
      expectedParts[suffix].push(delta)
      await writeEvent(stream, {
        type: "message.part.delta",
        properties: { sessionID: session.id, messageID: `assistant-${suffix}`, partID: `assistant-${suffix}-text`, field: "text", delta },
      })
    }
    await writeEvent(stream, { type: "session.idle", properties: { sessionID: session.id } })
    const expected = { a: expectedParts.a.join(""), b: expectedParts.b.join("") }

    await eventually(() => {
      const messages = controller.snapshot.sessions[session.id]?.messages ?? []
      return messages.find((message) => message.info.id === "assistant-a")?.parts[0]?.text === expected.a &&
        messages.find((message) => message.info.id === "assistant-b")?.parts[0]?.text === expected.b &&
        messages.filter((message) => message.info.id.startsWith("goal-")).length === goalContinuationCount &&
        controller.snapshot.sessions[session.id]?.status.type === "idle"
    })
    const goalContinuations = controller.chatSnapshot().session?.messages.filter((message) => message.info.id.startsWith("goal-")) ?? []
    if (goalContinuations.length !== goalContinuationCount || goalContinuations.some((message) => !isGoalContinuationMessage(message))) {
      throw new Error(`Goal continuation markers were lost or corrupted under event-bus pressure: ${goalContinuations.length}/${goalContinuationCount}`)
    }
    const patches = controller.messagePatches([
      { sessionID: session.id, messageID: "assistant-a" },
      { sessionID: session.id, messageID: "assistant-b" },
    ])
    if (patches?.length !== 2 || patches.some((patch) => {
      const suffix = patch.messageID.endsWith("a") ? "a" : "b"
      return patch.active || patch.message?.parts[0]?.text !== expected[suffix] || patch.revision < 10_002
    })) {
      throw new Error(`Final patches did not preserve the stress stream: ${JSON.stringify(patches?.map((patch) => ({ revision: patch.revision, active: patch.active, length: patch.message?.parts[0]?.text?.length })))}`)
    }
    if (errors.length) throw new Error(`Synthetic event pipeline reported errors: ${errors.join(", ")}`)
  } finally {
    controller.dispose()
    eventStream?.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
