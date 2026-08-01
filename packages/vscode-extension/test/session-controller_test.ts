import type { SessionInfo } from "@opencode-workbench/shared"
import type { OpenCodeClient } from "../src/opencode-client.ts"
import { SessionController } from "../src/session-controller.ts"

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function session(id: string, updated: number): SessionInfo {
  return { id, title: id, directory: "/project", time: { created: 1, updated } }
}

Deno.test("chat snapshot exposes switchable sessions", async () => {
  const fake = {
    listSessions: async () => [session("one", 2), session("two", 1)],
    sessionStatuses: async () => ({ two: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { permission: async () => "reject", error: () => undefined })
  await controller.reconcile()

  const snapshot = controller.chatSnapshot()
  if (snapshot.sessions.length !== 2 || snapshot.sessions[1]?.id !== "two" || snapshot.sessions[1]?.status.type !== "busy") {
    throw new Error("Chat snapshot omitted session switcher state")
  }
  controller.dispose()
})

Deno.test("starter draft stays with its new session", async () => {
  const created = session("new", 2)
  const fake = {
    createSession: async () => created,
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { permission: async () => "reject", error: () => undefined })
  await controller.createSession(undefined, "Review this workspace")

  if (controller.snapshot.sessions.new?.draft !== "Review this workspace") {
    throw new Error("Starter draft was not assigned to the created session")
  }
  let rejected = false
  try {
    await controller.select("missing")
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error("Unknown session selection was accepted")
  controller.dispose()
})

Deno.test("slower session creation cannot replace newer selection intent", async () => {
  const first = deferred<SessionInfo>()
  const second = deferred<SessionInfo>()
  const creates = [first, second]
  const fake = {
    createSession: () => creates.shift()!.promise,
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { permission: async () => "reject", error: () => undefined })

  const oldCreate = controller.createSession()
  const newCreate = controller.createSession()
  second.resolve(session("new", 2))
  await newCreate
  first.resolve(session("old", 1))
  await oldCreate

  if (controller.snapshot.selectedID !== "new") throw new Error("Slower creation replaced the newer session selection")
  controller.dispose()
})

Deno.test("failed send preserves a newer draft", async () => {
  const send = deferred<void>()
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendAsync: () => send.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { permission: async () => "reject", error: () => undefined })
  await controller.reconcile()

  const pending = controller.send("old draft")
  controller.setDraft("new draft")
  send.reject(new Error("send failed"))
  await pending.catch(() => undefined)

  if (controller.snapshot.sessions.one?.draft !== "new draft") throw new Error("Failed send overwrote a newer draft")
  controller.dispose()
})

Deno.test("newer reconciliation cannot be overwritten by an older response", async () => {
  const first = deferred<SessionInfo[]>()
  const second = deferred<SessionInfo[]>()
  const calls = [first, second]
  const fake = {
    listSessions: () => calls.shift()!.promise,
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { permission: async () => "reject", error: () => undefined })

  const oldRequest = controller.reconcile()
  const newRequest = controller.reconcile()
  second.resolve([session("new", 2)])
  await newRequest
  first.resolve([session("old", 1)])
  await oldRequest

  if (controller.snapshot.selectedID !== "new" || controller.snapshot.sessions.old) {
    throw new Error("Stale reconciliation replaced newer session state")
  }
  controller.dispose()
})

Deno.test("transcript response preserves newer streamed updates", async () => {
  const transcript = deferred<Array<{ info: { id: string; sessionID: string; role: "user" | "assistant" }; parts: Array<{ id: string; sessionID: string; messageID: string; type: string; text?: string }> }>>()
  let firstLoad = true
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => firstLoad ? (firstLoad = false, []) : transcript.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { permission: async () => "reject", error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    loadTranscript(sessionID: string): Promise<void>
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  const load = internal.loadTranscript("one")
  internal.handleEvent({
    type: "message.updated",
    properties: { info: { id: "live", sessionID: "one", role: "assistant" } },
  })
  internal.handleEvent({
    type: "message.part.updated",
    properties: { part: { id: "part", sessionID: "one", messageID: "live", type: "text", text: "streamed" } },
  })
  transcript.resolve([{ info: { id: "history", sessionID: "one", role: "user" }, parts: [] }])
  await load

  const messages = controller.snapshot.sessions.one?.messages ?? []
  if (!messages.some((message) => message.info.id === "history") ||
    !messages.some((message) => message.info.id === "live" && message.parts[0]?.text === "streamed")) {
    throw new Error("Transcript response discarded streamed updates")
  }
  controller.dispose()
})

Deno.test("transcript response does not resurrect a removed part", async () => {
  const liveMessage = {
    info: { id: "live", sessionID: "one", role: "assistant" as const },
    parts: [{ id: "part", sessionID: "one", messageID: "live", type: "text", text: "obsolete" }],
  }
  const transcript = deferred<typeof liveMessage[]>()
  let firstLoad = true
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => firstLoad ? (firstLoad = false, [liveMessage]) : transcript.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { permission: async () => "reject", error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    loadTranscript(sessionID: string): Promise<void>
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  const load = internal.loadTranscript("one")
  internal.handleEvent({
    type: "message.part.removed",
    properties: { sessionID: "one", messageID: "live", partID: "part" },
  })
  transcript.resolve([liveMessage])
  await load

  if (controller.snapshot.sessions.one?.messages[0]?.parts.length !== 0) {
    throw new Error("Transcript response resurrected a removed part")
  }
  controller.dispose()
})

Deno.test("removed messages also remove their webview revisions", async () => {
  const message = {
    info: { id: "gone", sessionID: "one", role: "assistant" as const },
    parts: [{ id: "part", sessionID: "one", messageID: "gone", type: "text", text: "obsolete" }],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [message],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { permission: async () => "reject", error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "message.removed",
    properties: { sessionID: "one", messageID: "gone" },
  })

  const snapshot = controller.chatSnapshot().session
  if (snapshot?.messages.length !== 0 || Object.hasOwn(snapshot?.messageRevisions ?? {}, "gone")) {
    throw new Error("Removed message retained webview state")
  }
  controller.dispose()
})
