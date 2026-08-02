import { parseHostMessage, type MessageBundle, type SessionInfo } from "@opencode-workbench/shared"
import type { OpenCodeClient } from "../src/opencode-client.ts"
import { type ComposerPreferences, SessionController } from "../src/session-controller.ts"

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
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  const snapshot = controller.chatSnapshot()
  if (snapshot.sessions.length !== 2 || snapshot.sessions[1]?.id !== "two" || snapshot.sessions[1]?.status.type !== "busy") {
    throw new Error("Chat snapshot omitted session switcher state")
  }
  controller.dispose()
})

Deno.test("LSP events refresh runtime status", async () => {
  let lspCalls = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    lsp: async () => ++lspCalls === 1 ? [] : [{ id: "jdtls", name: "Java", status: "connected", root: "/project" }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const refreshed = deferred<void>()
  controller.subscribe(() => {
    if (controller.chatSnapshot().runtime?.lsp[0]?.id === "jdtls") refreshed.resolve(undefined)
  })

  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "lsp.updated", properties: {} })
  await refreshed.promise

  if (lspCalls !== 2) throw new Error("LSP event did not refresh runtime endpoint exactly once")
  controller.dispose()
})

Deno.test("chat snapshot caps session summaries while retaining selection", async () => {
  const sessions = Array.from({ length: 5_001 }, (_, index) => session(`session-${index}`, 5_001 - index))
  const fake = {
    listSessions: async () => sessions,
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.select("session-5000")
  const snapshot = controller.chatSnapshot()
  if (snapshot.sessions.length !== 5_000 || !snapshot.sessions.some((value) => value.id === "session-5000") ||
    !parseHostMessage({ type: "snapshot", snapshot })) {
    throw new Error("Bounded session summaries omitted the selected session or failed protocol validation")
  }
  controller.dispose()
})

Deno.test("chat snapshot applies OpenCode defaults before first prompt", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [{ name: "build" }],
      models: [{ id: "model", providerID: "acme", name: "Model", variants: ["high"] }],
      defaults: { agent: "build", model: "acme/model", variant: "high" },
    }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  const selected = controller.chatSnapshot().session
  if (selected?.agent !== "build" || selected.model !== "acme/model" || selected.variant !== "high") {
    throw new Error("OpenCode defaults were not applied to the initial composer state")
  }
  controller.dispose()
})

Deno.test("new empty sessions retain current agent, model, and reasoning", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [{ name: "build", model: { providerID: "acme", modelID: "fast" } }, { name: "plan" }],
      models: [
        { id: "fast", providerID: "acme", name: "Fast" },
        { id: "deep", providerID: "acme", name: "Deep", variants: ["high"] },
      ],
      defaults: { agent: "build", model: "acme/fast" },
    }),
    messages: async () => [],
    createSession: async () => session("new", 2),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  controller.setPreference("plan", "acme/deep", "high")
  controller.setPreference("plan", "acme/fast")
  if (controller.chatSnapshot().session?.variant !== undefined) throw new Error("Reasoning leaked to another model")
  controller.setPreference("plan", "acme/deep")
  if (controller.chatSnapshot().session?.variant !== "high") throw new Error("Per-model reasoning preference was not restored")
  let rejected = false
  try {
    controller.setPreference("build", "", "high")
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error("Reasoning unsupported by an agent's effective model was accepted")
  await controller.createSession()

  const selected = controller.chatSnapshot().session
  if (selected?.agent !== "plan" || selected.model !== "acme/deep" || selected.variant !== "high") {
    throw new Error("New session did not retain current composer preferences")
  }
  await controller.select("one")
  if (controller.chatSnapshot().session?.variant !== "high") throw new Error("Session reselection erased remembered reasoning")
  controller.dispose()
})

Deno.test("last model preference survives controller recreation and applies across agents", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [{ name: "build" }, { name: "plan" }],
      models: [
        { id: "pickle", providerID: "acme", name: "Big Pickle" },
        { id: "sol", providerID: "openai", name: "GPT-5.6 Sol", variants: ["high"] },
      ],
      defaults: { agent: "build", model: "acme/pickle" },
    }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  let saved: ComposerPreferences | undefined
  const first = new SessionController(fake, { error: () => undefined, preferencesChanged: (value) => saved = value })
  await first.reconcile()
  first.setPreference("plan", "openai/sol", "high")
  first.setPreference("build", "", "")
  first.dispose()

  const restored = new SessionController(fake, { error: () => undefined }, saved)
  await restored.reconcile()
  const selected = restored.chatSnapshot().session
  if (selected?.agent !== "build" || selected.model !== "openai/sol" || selected.variant !== "high") {
    throw new Error("Last user-selected model preference was not restored globally")
  }
  restored.setPreference("plan", "", "")
  if (restored.chatSnapshot().session?.model !== "openai/sol") throw new Error("Global model preference did not follow the selected agent")
  restored.dispose()
})

Deno.test("agent-specific model overrides general model default", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [{ name: "build", model: { providerID: "acme", modelID: "agent-model" } }],
      models: [
        { id: "general", providerID: "acme", name: "General" },
        { id: "agent-model", providerID: "acme", name: "Agent model" },
      ],
      defaults: { agent: "build", model: "acme/general" },
    }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined }, {
    currentAgent: "build",
    lastModel: "acme/general",
  })
  await controller.reconcile()

  if (controller.chatSnapshot().session?.model !== "acme/agent-model") {
    throw new Error("Agent-specific model was not preferred")
  }
  controller.dispose()
})

Deno.test("starter draft stays with its new session", async () => {
  const created = session("new", 2)
  const fake = {
    createSession: async () => created,
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
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

Deno.test("first prompt creates and submits a session", async () => {
  const sent: string[] = []
  const fake = {
    createSession: async () => session("new", 2),
    messages: async () => [],
    sendPrompt: async (_sessionID: string, _id: string, text: string) => sent.push(text),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })

  const sessionID = await controller.createSessionWithPrompt("Review this workspace")

  if (sessionID !== "new" || sent[0] !== "Review this workspace") throw new Error("First prompt was not submitted to its new session")
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
  const controller = new SessionController(fake, { error: () => undefined })

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
    sendPrompt: () => send.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
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
  const controller = new SessionController(fake, { error: () => undefined })

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
  const controller = new SessionController(fake, { error: () => undefined })
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
  const controller = new SessionController(fake, { error: () => undefined })
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
  const controller = new SessionController(fake, { error: () => undefined })
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

Deno.test("chat snapshots bound large transcripts and tool metadata", async () => {
  const transcript = Array.from({ length: 10 }, (_, index) => ({
    info: { id: `message-${index}`, sessionID: "one", role: "assistant" as const },
    parts: [{ id: `part-${index}`, sessionID: "one", messageID: `message-${index}`, type: "text", text: "x".repeat(500_000) }],
  }))
  transcript[9]!.parts.push({
    id: "tool",
    sessionID: "one",
    messageID: "message-9",
    type: "tool",
    state: { status: "completed", metadata: { output: "x".repeat(150_000) } },
  } as unknown as typeof transcript[number]["parts"][number])
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => transcript,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const snapshot = controller.chatSnapshot()

  if (!parseHostMessage({ type: "snapshot", snapshot }) || snapshot.session?.messages.at(-1)?.info.id !== "message-9" ||
    snapshot.session.messages.length >= transcript.length) {
    throw new Error("Large transcript was not bounded into a valid recent snapshot")
  }
  controller.dispose()
})

Deno.test("message snapshots retain the newest parts after the part limit", async () => {
  const parts = Array.from({ length: 2_001 }, (_, index) => ({
    id: `part-${index}`,
    sessionID: "one",
    messageID: "assistant",
    type: "text",
    text: String(index),
  }))
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [{ info: { id: "assistant", sessionID: "one", role: "assistant" as const }, parts }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const bounded = controller.chatSnapshot().session?.messages[0]?.parts ?? []
  if (bounded.length !== 2_000 || bounded[0]?.id !== "part-1" || bounded.at(-1)?.id !== "part-2000") {
    throw new Error("Message snapshot retained stale parts instead of the streaming tail")
  }
  controller.dispose()
})

Deno.test("delegated task snapshots include bounded child-session progress", async () => {
  const parent = session("parent", 2)
  const child = { ...session("child", 1), parentID: "parent" }
  const fake = {
    listSessions: async () => [parent, child],
    sessionStatuses: async () => ({ child: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async (sessionID: string) => sessionID === "parent" ? [{
      info: { id: "assistant", sessionID: "parent", role: "assistant" as const },
      parts: [{
        id: "task-part",
        sessionID: "parent",
        messageID: "assistant",
        type: "tool",
        tool: "task",
        state: { status: "running", title: "Map workspace", metadata: { sessionId: "child" } },
      }],
    }] : [{
      info: { id: "child-assistant", sessionID: "child", role: "assistant" as const },
      parts: [{ id: "reasoning", sessionID: "child", messageID: "child-assistant", type: "reasoning", text: "Inspecting routes" }],
    }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "child-permission", sessionID: "child", permission: "bash", patterns: ["git status"], always: [] },
  })
  const snapshot = controller.chatSnapshot()
  const delegation = snapshot.session?.delegations?.[0]

  if (delegation?.sessionID !== "child" || delegation.status.type !== "busy" || delegation.messages[0]?.parts[0]?.text !== "Inspecting routes" ||
    snapshot.session?.permissions?.[0]?.sessionID !== "child" || snapshot.sessions[0]?.permissionCount !== 1 ||
    snapshot.sessions.some((entry) => entry.id === "child") || !parseHostMessage({ type: "snapshot", snapshot })) {
    throw new Error("Delegated child progress was not loaded into a valid parent snapshot")
  }
  await controller.select("child")
  const childSnapshot = controller.chatSnapshot().session
  if (childSnapshot?.parentID !== "parent" || childSnapshot.permissions?.length !== 0) {
    throw new Error("Subagent detail snapshot omitted parent navigation or retained parent-routed approval UI")
  }
  controller.dispose()
})

Deno.test("busy sessions durably admit prompts in queue order", async () => {
  const calls: Array<{ text: string; delivery: string; id: string }> = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [{ name: "build" }], models: [{ id: "model", providerID: "acme", name: "Model" }] }),
    messages: async () => [],
    sendPrompt: async (_sessionID: string, id: string, text: string, delivery: string) => calls.push({ id, text, delivery }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  controller.setDraft("first")
  await controller.send("first", "build", "acme/model")
  await controller.send("second")
  controller.setDraft("new draft")
  if (calls.map((call) => call.text).join(",") !== "first,second" || calls.some((call) => call.delivery !== "queue") || calls.some((call) => !call.id.startsWith("msg_"))) {
    throw new Error("Busy prompts were not durably admitted in order")
  }

  const snapshot = controller.chatSnapshot().session
  if (snapshot?.queue?.length !== 0 || snapshot?.draft !== "new draft" || snapshot.messages.filter((message) => message.info.role === "user").map((message) => message.parts[0]?.text).join(",") !== "first,second") {
    throw new Error("Queue drain lost a newer draft, retained sent prompts, or hid admitted user messages")
  }
  controller.dispose()
})

Deno.test("reload pause rejects new prompts and resumes retained queues", async () => {
  const calls: string[] = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async (_sessionID: string, _id: string, text: string) => calls.push(text),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  controller.setPromptAdmissionPaused(true)
  let rejected = false
  try {
    await controller.send("blocked")
  } catch {
    rejected = true
  }
  controller.setPromptAdmissionPaused(false)
  await controller.send("accepted")
  if (!rejected || calls.join(",") !== "accepted") throw new Error("Reload pause admitted a prompt or failed to resume prompt sending")
  controller.dispose()
})

Deno.test("custom providers use compatible legacy prompt transport", async () => {
  const calls: Array<{ text: string; agent?: string; model?: string; variant?: string }> = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [{ name: "caveboss" }],
      providers: [{ id: "openai", name: "OpenAI", source: "custom" as const }],
      models: [{ id: "gpt-5.6-sol", providerID: "openai", name: "GPT-5.6 Sol", variants: ["high"] }],
    }),
    messages: async () => [],
    sendAsync: async (_sessionID: string, text: string, agent?: string, model?: string, variant?: string) => calls.push({ text, agent, model, variant }),
    sendPrompt: () => {
      throw new Error("Custom provider used incompatible v2 transport")
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.send("hello", "caveboss", "openai/gpt-5.6-sol", "high")
  if (calls.length !== 1 || calls[0]?.text !== "hello" || calls[0].agent !== "caveboss" || calls[0].model !== "openai/gpt-5.6-sol" || calls[0].variant !== "high") {
    throw new Error("Custom provider prompt did not preserve composer selection")
  }
  controller.dispose()
})

Deno.test("v2 session events refresh projected output and terminal status", async () => {
  let messageCalls = 0
  const assistant: MessageBundle = {
    info: { id: "assistant", sessionID: "one", role: "assistant", error: { message: "Provider failed" } },
    parts: [],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => ++messageCalls === 1 ? [] : [assistant],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const refreshed = deferred<void>()
  controller.subscribe(() => {
    if (controller.chatSnapshot().session?.messages.some((message) => message.info.id === "assistant")) refreshed.resolve(undefined)
  })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.next.step.failed", properties: { sessionID: "one", error: { message: "Provider failed" } } })
  await refreshed.promise
  const snapshot = controller.chatSnapshot().session
  if (snapshot?.status.type !== "error" || snapshot.status.message !== "Provider failed" || snapshot.messages[0]?.info.id !== "assistant") {
    throw new Error("V2 terminal event did not refresh projected output and error status")
  }
  controller.dispose()
})

Deno.test("queued attachments retain private payloads only until durable admission", async () => {
  const sent = deferred<Array<{ url: string; filename: string }>>()
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async (_sessionID: string, _id: string, _text: string, delivery: string, _agent?: string, _model?: string, _variant?: string, files?: Array<{ url: string; filename: string }>) => {
      if (delivery !== "queue") throw new Error("Busy attachment was not admitted as queued")
      sent.resolve(files ?? [])
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const file = { type: "file" as const, mime: "image/png", url: "data:image/png;base64,eA==", filename: "image.png" }
  await controller.send("", undefined, undefined, undefined, [file])
  const files = await sent.promise
  if (files[0]?.url !== file.url) throw new Error("Queued attachment payload was not sent")
  if (controller.chatSnapshot().session?.queue?.length || JSON.stringify(controller.chatSnapshot()).includes("base64")) throw new Error("Admitted attachment payload remained in client state")
  controller.dispose()
})

Deno.test("file message snapshots retain labels without exposing attachment URLs", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [{
      info: { id: "user", sessionID: "one", role: "user" as const },
      parts: [{ id: "file", sessionID: "one", messageID: "user", type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,secret" }],
    }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const snapshot = controller.chatSnapshot()
  const part = snapshot.session?.messages[0]?.parts[0]
  if (part?.filename !== "screen.png" || part.mime !== "image/png" || "url" in (part ?? {}) || !parseHostMessage({ type: "snapshot", snapshot })) {
    throw new Error("File snapshot label was lost or private URL was exposed")
  }
  controller.dispose()
})

Deno.test("auto approval responds once and removes only accepted permissions", async () => {
  const response = deferred<boolean>()
  const replies: string[] = []
  let attention = 0
  const fake = {
    respondPermission: (_request: unknown, reply: string) => {
      replies.push(reply)
      return response.promise
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined, attention: () => attention += 1 })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  controller.setAutoApproval("one", true)
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "permission", sessionID: "one", permission: "bash", patterns: ["ls"], always: ["bash:*"] },
  })

  if (replies.join(",") !== "once" || controller.chatSnapshot().session?.permissions?.length !== 1) {
    throw new Error("Auto approval did not use once or removed an in-flight permission")
  }
  if (attention !== 0) throw new Error("Auto-approved permission emitted an attention notification")
  response.resolve(true)
  await Promise.resolve()
  await Promise.resolve()
  if (controller.chatSnapshot().session?.permissions?.length !== 0) throw new Error("Accepted permission remained pending")
  controller.dispose()
})

Deno.test("OpenCode reload permission always requires explicit approval", async () => {
  const replies: string[] = []
  let attention = 0
  const fake = {
    respondPermission: async (_request: unknown, reply: string) => {
      replies.push(reply)
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined, attention: () => attention += 1 })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  controller.setAutoApproval("one", true)
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "reload", sessionID: "one", permission: "vscode.reload_opencode", patterns: ["skill-activation"], always: [] },
  })
  await Promise.resolve()
  if (replies.length || attention !== 1 || controller.chatSnapshot().session?.permissions?.[0]?.type !== "vscode.reload_opencode") {
    throw new Error("Reload permission was auto-approved or hidden")
  }
  controller.dispose()
})

Deno.test("auto approval is scoped to one root session and new sessions default to Ask", async () => {
  let attention = 0
  const replies: string[] = []
  const fake = {
    messages: async () => [],
    respondPermission: async (_request: unknown, reply: string) => {
      replies.push(reply)
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined, attention: () => attention += 1 })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  controller.setAutoApproval("one", true)
  internal.handleEvent({ type: "session.created", properties: { info: session("two", 2) } })
  await controller.select("two")
  if (controller.chatSnapshot().autoApproval !== false) throw new Error("New session inherited Auto approval")
  internal.handleEvent({ type: "permission.asked", properties: { id: "two-permission", sessionID: "two", permission: "bash", patterns: ["pwd"], always: [] } })
  await Promise.resolve()
  if (replies.length || attention !== 1) throw new Error("Auto approval leaked into another root session")

  const child = { ...session("child", 3), parentID: "one" }
  internal.handleEvent({ type: "session.created", properties: { info: child } })
  await controller.select("child")
  if (controller.chatSnapshot().autoApproval !== true) throw new Error("Subagent did not inherit its root session approval mode")
  controller.dispose()
})

Deno.test("truncated permissions cannot be allowed or auto-approved", async () => {
  const replies: string[] = []
  let attention = 0
  const fake = {
    respondPermission: async (_request: unknown, reply: string) => {
      replies.push(reply)
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined, attention: () => attention += 1 })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  controller.setAutoApproval("one", true)
  internal.handleEvent({
    type: "permission.asked",
    properties: {
      id: "permission",
      sessionID: "one",
      permission: "bash",
      patterns: ["command"],
      always: [],
      metadata: { command: "x".repeat(100_001) },
    },
  })

  await Promise.resolve()
  if (replies.length !== 0 || attention !== 1 || !controller.chatSnapshot().session?.permissions?.[0]?.truncated) {
    throw new Error("Incomplete permission was auto-approved, hidden, or not marked")
  }
  let rejected = false
  try {
    await controller.respondPermission("permission", "once", "one")
  } catch {
    rejected = true
  }
  if (!rejected || replies.length !== 0) throw new Error("Incomplete permission accepted an allow response")
  await controller.respondPermission("permission", "reject", "one")
  if (replies.join(",") !== "reject") throw new Error("Incomplete permission could not be rejected")
  controller.dispose()
})

Deno.test("reconnect discards stale permission reconciliation", async () => {
  const permissions = deferred<Array<{ id: string; sessionID: string; title: string; protocol: "current" }>>()
  const fake = {
    pendingPermissions: () => permissions.promise,
    events: (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
    reconcilePermissions(): Promise<void>
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "live", sessionID: "one", permission: "read", patterns: ["file"], always: [] },
  })
  controller.start()
  const stale = internal.reconcilePermissions()
  controller.reconnect()
  permissions.resolve([])
  await stale

  if (controller.chatSnapshot().session?.permissions?.[0]?.id !== "live") {
    throw new Error("Pre-reconnect permission response replaced current state")
  }
  controller.dispose()
})

Deno.test("failed permission responses remain pending", async () => {
  let errors = 0
  const fake = {
    respondPermission: async () => {
      throw new Error("offline")
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => errors += 1 })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "permission", sessionID: "one", permission: "read", patterns: [".env"], always: [] },
  })
  await controller.respondPermission("permission", "reject", "one").catch(() => undefined)

  if (errors !== 1 || controller.chatSnapshot().session?.permissions?.[0]?.id !== "permission") {
    throw new Error("Failed permission response was not retained")
  }
  let rejected = false
  try {
    await controller.respondPermission("permission", "once", "other")
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error("Permission response accepted the wrong session")
  controller.dispose()
})

Deno.test("todo events remain scoped to their owning session", async () => {
  const controller = new SessionController({ messages: async () => [] } as unknown as OpenCodeClient, { error: () => undefined })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({ type: "session.created", properties: { info: session("two", 2) } })
  internal.handleEvent({
    type: "todo.updated",
    properties: { sessionID: "one", todos: [{ content: "Ship it", status: "completed", priority: "high" }] },
  })

  await controller.select("two")
  if (controller.chatSnapshot().session?.todos?.length !== 0) throw new Error("Todo event leaked into another session")
  await controller.select("one")
  const snapshot = controller.chatSnapshot()
  if (snapshot.session?.todos?.[0]?.content !== "Ship it" || snapshot.sessions.find((entry) => entry.id === "one")?.todo?.completed !== 1) {
    throw new Error("Todo event did not remain on its owning session")
  }
  controller.dispose()
})

Deno.test("context uses latest step tokens and cumulative assistant costs", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [{ id: "model", providerID: "acme", name: "Model", contextLimit: 1_000 }] }),
    messages: async () => [{
      info: { id: "a1", sessionID: "one", role: "assistant" as const, cost: 1 },
      parts: [],
    }, {
      info: { id: "u", sessionID: "one", role: "user" as const, model: { providerID: "acme", modelID: "model", variant: "high" } },
      parts: [],
    }, {
      info: { id: "a2", sessionID: "one", role: "assistant" as const, cost: 2, tokens: { input: 1 } },
      parts: [{
        id: "step",
        sessionID: "one",
        messageID: "a2",
        type: "step-finish",
        tokens: { input: 400, output: 50, reasoning: 25, cache: { read: 5, write: 1 } },
      }, {
        id: "goal",
        sessionID: "one",
        messageID: "a2",
        type: "tool",
        tool: "get_goal",
        state: { status: "completed", output: '{"objective":"Ship safely","status":"active"}' },
      }],
    }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  const snapshot = controller.chatSnapshot().session
  if (snapshot?.context?.totalTokens !== 481 || snapshot.context.cost !== 3 || snapshot.context.contextLimit !== 1_000) {
    throw new Error("Context summary did not use latest step tokens and cumulative costs")
  }
  if (snapshot.variant !== "high") throw new Error("Reasoning variant was not inferred from real user message shape")
  if (snapshot.goal?.objective !== "Ship safely" || snapshot.todos?.length !== 0) throw new Error("Goal summary was not kept distinct from todos")
  controller.dispose()
})

Deno.test("question and diff events expose actionable session state", async () => {
  const answers: string[][][] = []
  const fake = {
    respondQuestion: async (_request: unknown, value: string[][]) => answers.push(value),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({
    type: "question.v2.asked",
    properties: {
      id: "que_1",
      sessionID: "one",
      questions: [{ header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Proceed" }] }],
    },
  })
  internal.handleEvent({
    type: "session.diff",
    properties: { sessionID: "one", diff: [{ file: "src/main.ts", patch: "diff", additions: 2, deletions: 1, status: "modified" }] },
  })

  const pending = controller.chatSnapshot()
  if (pending.sessions[0]?.attention !== 1 || pending.sessions[0]?.questionCount !== 1 || pending.sessions[0]?.permissionCount !== 0 || pending.sessions[0]?.changeCount !== 1 || pending.session?.changes?.[0]?.file !== "src/main.ts") {
    throw new Error("Question or changed-file state was not exposed")
  }
  await controller.respondQuestion("que_1", [["Yes"]], "one")
  if (answers[0]?.[0]?.[0] !== "Yes" || controller.chatSnapshot().session?.questions?.length !== 0) {
    throw new Error("Question response was not sent or removed")
  }
  controller.dispose()
})

Deno.test("undo and redo accept updated session responses", async () => {
  const calls: string[] = []
  const updated = { ...session("one", 2), title: "Updated" }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [{ info: { id: "user", sessionID: "one", role: "user" as const }, parts: [] }],
    revertSession: async (_sessionID: string, messageID: string) => {
      calls.push(`undo:${messageID}`)
      return updated
    },
    unrevertSession: async () => {
      calls.push("redo")
      return updated
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.undoSession("one")
  await controller.redoSession("one")

  if (calls.join(",") !== "undo:user,redo" || controller.snapshot.sessions.one?.info.title !== "Updated") {
    throw new Error("Undo or redo rejected OpenCode's updated session response")
  }
  controller.dispose()
})

Deno.test("accepted stop requests immediately transition selected session to idle", async () => {
  let aborted = ""
  const fake = { abort: async (sessionID: string) => {
    aborted = sessionID
    return true
  } } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({ type: "session.status", properties: { sessionID: "one", status: { type: "busy" } } })

  await controller.abortSelected()
  if (aborted !== "one" || controller.chatSnapshot().session?.status.type !== "idle") throw new Error("Stop acknowledgement did not update local status")
  controller.dispose()
})

Deno.test("slash commands use native endpoints while bang prompts remain ordinary chat", async () => {
  const calls: string[] = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendCommand: async (_sessionID: string, command: string, args: string) => calls.push(`/${command} ${args}`),
    sendPrompt: async (_sessionID: string, _id: string, text: string) => calls.push(text),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.send("/goal status")
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "session.idle", properties: { sessionID: "one" } })
  await controller.send("!git status --short")
  if (calls.join("|") !== "/goal status|!git status --short") throw new Error("Slash command routing or ordinary bang prompt handling failed")
  controller.dispose()
})

Deno.test("executing goal commands are reported as running rather than queued", async () => {
  const command = deferred<unknown>()
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendCommand: () => command.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  const sending = controller.send("/goal review this project")
  const running = controller.chatSnapshot()
  if (!running.session?.inFlightPromptID || running.session.queue?.length !== 1 || running.sessions[0]?.queued !== 0 || !parseHostMessage({ type: "snapshot", snapshot: running })) {
    throw new Error("Executing command was not distinguished from pending queue entries")
  }
  const goalUpdate = {
    type: "event" as const,
    event: {
      type: "message.part.updated",
      properties: { part: { id: "goal", messageID: "assistant", sessionID: "one", type: "tool", tool: "get_goal_history", state: { status: "completed", output: "{}" } } },
    },
  }
  if (controller.messageUpdateKey(goalUpdate) !== undefined) throw new Error("Completed goal update was reduced to a transcript-only patch")

  command.resolve({})
  await sending
  if (controller.chatSnapshot().session?.inFlightPromptID || controller.chatSnapshot().session?.queue?.length) throw new Error("Completed command remained in running state")
  controller.dispose()
})

Deno.test("streaming message updates expose bounded targeted patches", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  let update: Parameters<Parameters<SessionController["subscribe"]>[0]>[0] | undefined
  controller.subscribe((next) => update = next)
  const internal = controller as unknown as { handleEvent(event: { type: string; properties: Record<string, unknown> }): void }
  internal.handleEvent({ type: "message.updated", properties: { info: { id: "assistant", sessionID: "one", role: "assistant" } } })
  internal.handleEvent({ type: "message.part.updated", properties: { part: { id: "text", messageID: "assistant", sessionID: "one", type: "text", text: "streamed" } } })

  if (!update) throw new Error("Streaming update was not published")
  const key = controller.messageUpdateKey(update)
  const patch = key ? controller.messagePatches([key])?.[0] : undefined
  if (patch?.message?.parts[0]?.text !== "streamed" || patch.revision < 1 || !patch.active) {
    throw new Error("Targeted streaming patch omitted current message state")
  }
  controller.dispose()
})

Deno.test("permission reconciliation preserves failed protocols and protocol identity", async () => {
  const current = { id: "same", sessionID: "one", title: "Current", protocol: "current" as const }
  const v2 = { id: "same", sessionID: "one", title: "V2", protocol: "v2" as const }
  const other = { id: "other", sessionID: "one", title: "Other", protocol: "current" as const }
  let result = { requests: [current, v2, other], succeeded: ["current", "v2"] as Array<"current" | "v2"> }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    pendingPermissionsDetailed: async () => result,
    respondPermission: async () => undefined,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as { reconcilePermissions(): Promise<void> }
  await internal.reconcilePermissions()
  if (controller.snapshot.sessions.one?.permissions.length !== 3) throw new Error("Same-ID permission protocols were deduplicated")

  await controller.respondPermission("same", "once", "one", "current")
  const remaining = controller.snapshot.sessions.one?.permissions ?? []
  if (remaining.length !== 2 || !remaining.some((request) => request.id === "same" && request.protocol === "v2")) {
    throw new Error("Permission response removed another protocol")
  }

  result = { requests: [], succeeded: ["v2"] }
  await internal.reconcilePermissions()
  const retained = controller.snapshot.sessions.one?.permissions ?? []
  if (retained.length !== 1 || retained[0]?.id !== "other" || retained[0].protocol !== "current") {
    throw new Error("Partial reconciliation cleared requests from the failed protocol")
  }

  result = { requests: [v2, other], succeeded: ["current", "v2"] }
  await internal.reconcilePermissions()
  await controller.respondPermission("same", "reject", "one", "v2")
  const afterV2Reject = controller.snapshot.sessions.one?.permissions ?? []
  if (afterV2Reject.length !== 1 || afterV2Reject[0]?.protocol !== "current") throw new Error("V2 reject affected another permission system")
  await controller.respondPermission("other", "reject", "one", "current")
  if (Number(controller.snapshot.sessions.one?.permissions.length) !== 0) throw new Error("Reject retained sibling requests from the same permission system")
  controller.dispose()
})

Deno.test("session hydration remains loading until transcript completion and exposes failure", async () => {
  const transcript = deferred<MessageBundle[]>()
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: () => transcript.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const reconciling = controller.reconcile()
  for (let attempt = 0; attempt < 20 && controller.chatSnapshot().session?.loadState !== "loading"; attempt += 1) await Promise.resolve()
  if (controller.chatSnapshot().session?.loadState !== "loading") throw new Error("Transcript hydration did not remain visible")
  transcript.resolve([])
  await reconciling
  if (controller.chatSnapshot().session?.loadState !== "ready") throw new Error("Transcript hydration did not complete")
  controller.dispose()

  const failed = {
    listSessions: async () => [session("failed", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => { throw new Error("unavailable") },
  } as unknown as OpenCodeClient
  const failedController = new SessionController(failed, { error: () => undefined })
  await failedController.reconcile()
  if (failedController.chatSnapshot().session?.loadState !== "error") throw new Error("Transcript hydration failure was hidden")
  failedController.dispose()
})

Deno.test("context uses actual response model limits and agent mentions remain structured", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [{ name: "build" }],
      mentionAgents: [{ name: "research", mode: "subagent" }],
      models: [
        { id: "default", providerID: "acme", name: "Default", contextLimit: 1_000 },
        { id: "actual", providerID: "acme", name: "Actual", contextLimit: 8_000, inputLimit: 7_000, outputLimit: 1_000 },
      ],
      defaults: { agent: "build", model: "acme/default" },
    }),
    messages: async () => [{
      info: { id: "assistant", sessionID: "one", role: "assistant" as const, providerID: "acme", modelID: "actual", time: { completed: 1 }, tokens: { input: 400, output: 100 } },
      parts: [],
    }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const context = controller.chatSnapshot().session?.context
  if (context?.model !== "acme/actual" || context.contextLimit !== 8_000 || context.inputLimit !== 7_000 || context.outputLimit !== 1_000) {
    throw new Error("Context used composer model instead of actual response model")
  }
  if (controller.mentionedAgents("Ask @research to inspect this").join(",") !== "research" || controller.mentionedAgents("Ask @unknown").length) {
    throw new Error("Agent mentions were not validated against visible subagents")
  }
  controller.dispose()
})

Deno.test("VCS events refresh branch state and deleted sessions purge private prompt payloads", async () => {
  const send = deferred<void>()
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    path: async () => ({}),
    vcs: async () => ({ branch: "old" }),
    lsp: async () => [],
    formatter: async () => [],
    mcp: async () => ({}),
    sendPrompt: () => send.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const pending = controller.send("payload", undefined, undefined, undefined, [{ type: "file", mime: "image/png", url: "data:image/png;base64,eA==", filename: "image.png" }])
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
    promptFiles: Map<string, unknown>
  }
  internal.handleEvent({ type: "vcs.branch.updated", properties: { branch: "feature" } })
  if (controller.chatSnapshot().runtime?.vcs?.branch !== "feature") throw new Error("VCS branch event was not applied")
  internal.handleEvent({ type: "session.deleted", properties: { info: session("one", 1) } })
  if (internal.promptFiles.size !== 0) throw new Error("Deleted session retained private prompt attachments")
  send.reject(new Error("deleted"))
  await pending.catch(() => undefined)
  controller.dispose()
})
