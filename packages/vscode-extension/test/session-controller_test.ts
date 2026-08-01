import type { SessionInfo } from "@opencode-workbench/shared"
import type { OpenCodeClient } from "../src/opencode-client.ts"
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

function session(id: string, updated: number): SessionInfo {
  return { id, title: id, directory: "/project", time: { created: 1, updated } }
}

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
