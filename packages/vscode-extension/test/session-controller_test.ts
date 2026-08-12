import {
  isOpenCodeMessageID,
  type MessageBundle,
  type OpenCodePty,
  parseHostMessage,
  reusablePermissionScopes,
  type SessionInfo,
} from "@opencode-workbench/shared"
import type { OpenCodeClient } from "../src/opencode-client.ts"
import { type ComposerPreferences, permissionPatternMatches, SessionController } from "../src/session-controller.ts"
import { deriveContext } from "../src/application/snapshot-projector.ts"

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

function pty(id: string, status: OpenCodePty["status"] = "running"): OpenCodePty {
  return {
    id,
    title: id,
    command: "deno",
    args: ["test"],
    cwd: "/project",
    status,
    pid: 42,
    ...(status === "exited" ? { exitCode: 0 } : {}),
  }
}

Deno.test("chat snapshot exposes switchable sessions", async () => {
  const fake = {
    listSessions: async () => [{
      ...session("one", 2),
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
    }, session("two", 1)],
    sessionStatuses: async () => ({ two: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  const snapshot = controller.chatSnapshot()
  if (
    snapshot.sessions.length !== 2 || snapshot.sessions[0]?.tokens !== 45 || snapshot.sessions[1]?.id !== "two" ||
    snapshot.sessions[1]?.status.type !== "busy"
  ) {
    throw new Error("Chat snapshot omitted session switcher state")
  }
  controller.dispose()
})

Deno.test("deleting the active session opens the non-session screen until another session is chosen", async () => {
  let available = [session("one", 2), session("two", 1)]
  const selections: Array<string | undefined> = []
  const fake = {
    listSessions: async () => available,
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    deleteSession: async (sessionID: string) => {
      available = available.filter((candidate) => candidate.id !== sessionID)
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, {
    error: () => undefined,
    selectionChanged: (sessionID) => selections.push(sessionID),
  })
  await controller.reconcile()

  await controller.deleteSession("one")
  if (
    controller.chatSnapshot().session !== undefined ||
    controller.chatSnapshot().sessions.map((candidate) => candidate.id).join(",") !== "two"
  ) {
    throw new Error(
      "Deleting the active session did not retain the remaining rail while opening the non-session screen",
    )
  }
  if (selections.length !== 1 || selections[0] !== undefined) {
    throw new Error("Deleting the active session did not persist its cleared selection")
  }

  await controller.reconcile()
  if (controller.chatSnapshot().session !== undefined) {
    throw new Error("Session reconciliation replaced the intentional non-session screen")
  }
  await controller.select("two")
  if (controller.chatSnapshot().session?.id !== "two") {
    throw new Error("An explicit session choice did not leave the non-session screen")
  }
  controller.dispose()
})

Deno.test("settled turns refresh generated OpenCode session titles", async () => {
  let title = "New session"
  const fake = {
    listSessions: async () => [{ ...session("one", 2), title }],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  title = "Review Android camera privacy"
  const refreshed = deferred<void>()
  controller.subscribe(() => {
    if (controller.chatSnapshot().session?.title === title) refreshed.resolve(undefined)
  })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.idle", properties: { sessionID: "one" } })
  await refreshed.promise
  if (controller.chatSnapshot().sessions[0]?.title !== title) {
    throw new Error("Generated OpenCode title was not refreshed after settlement")
  }
  controller.dispose()
})

Deno.test("settled native prompts fall back to an OpenCode-persisted prompt title", async () => {
  let current = { ...session("one", 2), title: "New session - 2026-08-10T14:49:00.301Z" }
  const renamed: string[] = []
  const fake = {
    listSessions: async () => [current],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [{
      info: { id: "user", sessionID: "one", role: "user", time: { created: 1 } },
      parts: [{ id: "part", sessionID: "one", messageID: "user", type: "text", text: "hello from the workbench" }],
    }],
    renameSession: async (_sessionID: string, title: string) => {
      renamed.push(title)
      current = { ...current, title, time: { ...current.time, updated: 3 } }
      return current
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as { ensureAutomaticTitle(sessionID: string): Promise<void> }
  await internal.ensureAutomaticTitle("one")
  if (renamed.join(",") !== "Hello from the workbench") {
    throw new Error("Automatic title was not persisted through OpenCode")
  }
  if (controller.chatSnapshot().session?.title !== "Hello from the workbench") {
    throw new Error("Persisted automatic title was not projected")
  }
  await internal.ensureAutomaticTitle("one")
  if (renamed.length !== 1) throw new Error("Automatic title fallback ran more than once")
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

  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "lsp.updated", properties: {} })
  await refreshed.promise

  if (lspCalls !== 2) throw new Error("LSP event did not refresh runtime endpoint exactly once")
  controller.dispose()
})

Deno.test("controller hydrates a bounded clone-safe OpenCode PTY projection and backgrounds child sessions natively", async () => {
  const backgrounded: string[] = []
  const nativePtys = Array.from({ length: 501 }, (_, index) => pty(`pty-${index}`))
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    listPtys: async () => nativePtys,
    backgroundChildSessions: async (sessionID: string) => {
      backgrounded.push(sessionID)
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  const projected = controller.ptys()
  if (projected.length !== 500 || projected[0]?.id !== "pty-0" || projected.at(-1)?.id !== "pty-499") {
    throw new Error("Controller PTY hydration was not deterministically bounded")
  }
  projected[0]!.args[0] = "mutated"
  if (controller.ptys()[0]?.args[0] !== "test") throw new Error("Controller PTY getter leaked mutable metadata")
  if (!await controller.backgroundChildSessions("one") || backgrounded.join(",") !== "one") {
    throw new Error("Controller did not use OpenCode child-session backgrounding")
  }
  controller.dispose()
})

Deno.test("controller cancels only known PTYs through OpenCode and mutates projection after confirmation", async () => {
  const deleted: string[] = []
  let deletionAccepted = true
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    listPtys: async () => [pty("pty-one")],
    deletePty: async (ptyID: string) => {
      deleted.push(ptyID)
      return deletionAccepted
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  await controller.cancelPty("pty-one")
  if (deleted.join(",") !== "pty-one" || controller.ptys().length !== 0) {
    throw new Error("Confirmed OpenCode PTY cancellation was not projected")
  }

  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "pty.created", properties: { info: pty("pty-two") } })
  deletionAccepted = false
  let rejected = false
  try {
    await controller.cancelPty("pty-two")
  } catch {
    rejected = true
  }
  if (!rejected || controller.ptys()[0]?.id !== "pty-two") {
    throw new Error("Rejected OpenCode PTY cancellation mutated the local projection")
  }

  try {
    await controller.cancelPty("pty-unknown")
  } catch {
    // Expected: arbitrary PTY IDs never reach the native endpoint.
  }
  if (deleted.join(",") !== "pty-one,pty-two") throw new Error("Unknown PTY cancellation reached OpenCode")
  controller.dispose()
})

Deno.test("controller consumes authoritative OpenCode PTY lifecycle events", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    listPtys: async () => [pty("pty-one")],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  const created = { ...pty("pty-two"), args: ["task", "build"] }
  internal.handleEvent({ type: "pty.created", properties: { info: created } })
  created.args[0] = "mutated"
  internal.handleEvent({ type: "pty.updated", properties: { info: { ...pty("pty-one"), title: "Renamed" } } })
  if (controller.ptys().find((candidate) => candidate.id === "pty-one")?.title !== "Renamed") {
    throw new Error("OpenCode PTY update event was ignored")
  }
  internal.handleEvent({ type: "pty.exited", properties: { id: "pty-two", exitCode: 9 } })
  internal.handleEvent({ type: "pty.deleted", properties: { id: "pty-one" } })

  const projected = controller.ptys()
  if (
    projected.length !== 1 || projected[0]?.id !== "pty-two" || projected[0].status !== "exited" ||
    projected[0].exitCode !== 9 || projected[0].args[0] !== "task"
  ) {
    throw new Error(`OpenCode PTY lifecycle events were not projected exactly: ${JSON.stringify(projected)}`)
  }
  controller.dispose()
})

Deno.test("newer PTY events cannot be overwritten by stale reconciliation", async () => {
  const first = deferred<OpenCodePty[]>()
  let ptyCalls = 0
  const current = { ...pty("pty-event"), title: "From event" }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    listPtys: () => ++ptyCalls === 1 ? first.promise : Promise.resolve([current]),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const reconciling = controller.reconcile()
  for (let attempt = 0; attempt < 20 && ptyCalls === 0; attempt += 1) await Promise.resolve()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "pty.created", properties: { info: current } })
  first.resolve([{ ...pty("pty-stale"), title: "Stale list" }])
  await reconciling
  for (let attempt = 0; attempt < 20 && ptyCalls < 2; attempt += 1) await Promise.resolve()
  for (let attempt = 0; attempt < 20 && controller.ptys()[0]?.id !== "pty-event"; attempt += 1) await Promise.resolve()

  if (ptyCalls !== 2 || controller.ptys().map((value) => value.id).join(",") !== "pty-event") {
    throw new Error(`Stale PTY reconciliation replaced a newer event: ${JSON.stringify(controller.ptys())}`)
  }
  controller.dispose()
})

Deno.test("runtime normalization follows OpenCode formatter and MCP status contracts", async () => {
  const fake = {
    listSessions: async () => [],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    formatter: async () => [
      { name: "prettier", extensions: [".js", ".ts"], enabled: true },
      { name: "gofmt", extensions: [".go"], enabled: false },
      { name: "invalid", extensions: [".txt"] },
    ],
    mcp: async () => ({
      docs: { status: "needs_auth" },
      fs: { status: "connected" },
      broken: { status: "failed", error: "Connection closed" },
    }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const runtime = controller.chatSnapshot().runtime
  if (
    runtime?.formatters.length !== 2 || runtime.formatters[0]?.id !== "prettier" ||
    runtime.formatters[0]?.enabled !== true ||
    runtime.formatters[0]?.extensions?.join(",") !== ".js,.ts" || runtime.formatters[1]?.enabled !== false ||
    runtime.mcp.map((service) => `${service.id}:${service.status}:${service.error ?? ""}`).join(",") !==
      "docs:needs_auth:,fs:connected:,broken:failed:Connection closed"
  ) {
    throw new Error(`OpenCode formatter or MCP runtime status was normalized incorrectly: ${JSON.stringify(runtime)}`)
  }
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
  if (
    snapshot.sessions.length !== 5_000 || !snapshot.sessions.some((value) => value.id === "session-5000") ||
    !parseHostMessage({ type: "snapshot", snapshot })
  ) {
    throw new Error("Bounded session summaries omitted the selected session or failed protocol validation")
  }
  controller.dispose()
})

Deno.test("chat history exposes and pages messages older than the bounded snapshot", async () => {
  const messages: MessageBundle[] = Array.from({ length: 6_201 }, (_, index) => ({
    info: { id: `message-${String(index).padStart(4, "0")}`, sessionID: "one", role: index % 2 ? "assistant" : "user" },
    parts: [],
  }))
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => messages,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const visible = controller.chatSnapshot().session
  if (
    visible?.messages.length !== 5_000 || visible.history?.totalMessages !== 6_201 || !visible.history.hasOlder ||
    visible.history.limitedBy !== "messages"
  ) {
    throw new Error(`Bounded transcript did not disclose older history: ${JSON.stringify(visible?.history)}`)
  }
  const page = controller.historyPage("one", visible.messages[0]!.info.id)
  if (
    page.messages.length !== 1_000 || page.messages[0]?.info.id !== "message-0201" || !page.hasOlder ||
    page.totalMessages !== 6_201 ||
    parseHostMessage({ type: "historyPage", page })?.type !== "historyPage"
  ) {
    throw new Error(
      `Older transcript page was not projected from the exact boundary: ${
        JSON.stringify({ first: page.messages[0]?.info.id, count: page.messages.length, hasOlder: page.hasOlder })
      }`,
    )
  }
  const oldest = controller.historyPage("one", page.messages[0]!.info.id)
  if (oldest.messages.length !== 201 || oldest.messages[0]?.info.id !== "message-0000" || oldest.hasOlder) {
    throw new Error("Final older-history page did not terminate at the retained transcript boundary")
  }
  controller.dispose()
})

Deno.test("cold sessions hydrate a bounded tail and fetch older server history only on demand", async () => {
  const bundle = (id: string, created: number): MessageBundle => ({
    info: { id, sessionID: "one", role: created % 2 ? "user" : "assistant", time: { created } },
    parts: [{ id: `${id}-text`, sessionID: "one", messageID: id, type: "text", text: id }],
  })
  const calls: Array<{ cursor: string | undefined; limit: number }> = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messageHistoryPage: async (
      _sessionID: string,
      cursor: { legacyComplete: boolean; v2Complete: boolean } | undefined,
      limit: number,
    ) => {
      calls.push({ cursor: cursor ? "older" : undefined, limit })
      return cursor
        ? {
          messages: [bundle("message-1", 1), bundle("message-2", 2)],
          legacyMessageIDs: ["message-1", "message-2"],
          v2MessageIDs: [],
          cursor: { legacyComplete: true, v2Complete: true },
        }
        : {
          messages: [bundle("message-3", 3), bundle("message-4", 4)],
          legacyMessageIDs: ["message-3", "message-4"],
          v2MessageIDs: [],
          cursor: { legacy: "older", legacyComplete: false, v2Complete: true },
        }
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const recent = controller.chatSnapshot().session
  if (
    calls.length !== 1 || calls[0]?.limit !== 400 ||
    recent?.messages.map((message) => message.info.id).join(",") !== "message-3,message-4" ||
    !recent.history?.hasOlder || !recent.history.sourceMayBeTruncated || recent.metrics?.turnsTruncated !== true
  ) {
    throw new Error(
      `Cold history was not bounded: ${JSON.stringify({ calls, history: recent?.history, metrics: recent?.metrics })}`,
    )
  }
  const recentRevisions = { ...recent.messageRevisions }
  const page = await controller.loadHistoryPage("one", "message-3")
  const expanded = controller.chatSnapshot().session
  const completedCalls = calls.slice()
  if (
    completedCalls.length !== 2 || completedCalls[1]?.cursor !== "older" || completedCalls[1]?.limit !== 1_000 ||
    page.messages.map((message) => message.info.id).join(",") !== "message-1,message-2" || page.hasOlder ||
    expanded?.messages.map((message) => message.info.id).join(",") !== "message-1,message-2,message-3,message-4" ||
    expanded.history?.hasOlder ||
    expanded.metrics?.turnsTruncated !== undefined ||
    expanded.messageRevisions["message-3"] !== recentRevisions["message-3"] ||
    expanded.messageRevisions["message-4"] !== recentRevisions["message-4"]
  ) {
    throw new Error(
      `On-demand server history did not merge incrementally: ${
        JSON.stringify({ calls, page, expanded: expanded?.history })
      }`,
    )
  }
  controller.dispose()
})

Deno.test("server-backed history stops at the aggregate transcript safety limit", async () => {
  const bundle = (index: number): MessageBundle => ({
    info: {
      id: `message-${String(index).padStart(5, "0")}`,
      sessionID: "one",
      role: index % 2 ? "user" : "assistant",
      time: { created: index },
    },
    parts: [],
  })
  const all = Array.from({ length: 10_400 }, (_, index) => bundle(index))
  let oldest = all.length
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messageHistoryPage: async (
      _sessionID: string,
      cursor: { legacyComplete: boolean; v2Complete: boolean } | undefined,
      limit: number,
    ) => {
      const end = cursor ? oldest : all.length
      const start = Math.max(0, end - limit)
      oldest = start
      const messages = all.slice(start, end)
      return {
        messages,
        legacyMessageIDs: messages.map((message) => message.info.id),
        v2MessageIDs: [],
        cursor: { legacy: start > 0 ? String(start) : undefined, legacyComplete: start === 0, v2Complete: true },
      }
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  let page = controller.historyPage("one", controller.chatSnapshot().session!.messages[0]!.info.id)
  while (page.hasOlder) {
    page = await controller.loadHistoryPage(
      "one",
      page.messages[0]?.info.id ?? controller.snapshot.sessions.one!.messages[0]!.info.id,
    )
  }
  const retained = controller.snapshot.sessions.one!
  const projection = controller.chatSnapshot().session!
  if (
    retained.messages.length !== 10_000 || retained.messages[0]?.info.id !== "message-00400" ||
    projection.history?.sourceMayBeTruncated !== true
  ) {
    throw new Error(
      `Aggregate history limit was not enforced: ${
        JSON.stringify({
          count: retained.messages.length,
          first: retained.messages[0]?.info.id,
          history: projection.history,
        })
      }`,
    )
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
  if (controller.chatSnapshot().session?.variant !== "high") {
    throw new Error("Per-model reasoning preference was not restored")
  }
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
  if (controller.chatSnapshot().session?.variant !== "high") {
    throw new Error("Session reselection erased remembered reasoning")
  }
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
  if (restored.chatSnapshot().session?.model !== "openai/sol") {
    throw new Error("Global model preference did not follow the selected agent")
  }
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
  const sent: Array<{ id: string; text: string }> = []
  const fake = {
    createSession: async () => session("new", 2),
    messages: async () => [],
    sendPrompt: async (_sessionID: string, id: string, text: string) => sent.push({ id, text }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })

  const sessionID = await controller.createSessionWithPrompt("Review this workspace")

  if (sessionID !== "new" || sent[0]?.text !== "Review this workspace" || !isOpenCodeMessageID(sent[0]?.id)) {
    throw new Error("First prompt was not submitted with a compatible OpenCode message ID")
  }
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

Deno.test("failed send restores the submitted draft when no newer edit exists", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async () => {
      throw new Error("send failed")
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  controller.setDraft("Keep this prompt")
  await controller.send("Keep this prompt").catch(() => undefined)
  if (controller.snapshot.sessions.one?.draft !== "Keep this prompt") {
    throw new Error("Failed send cleared the submitted draft")
  }
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
  const transcript = deferred<
    Array<
      {
        info: { id: string; sessionID: string; role: "user" | "assistant" }
        parts: Array<{ id: string; sessionID: string; messageID: string; type: string; text?: string }>
      }
    >
  >()
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
  if (
    !messages.some((message) => message.info.id === "history") ||
    !messages.some((message) => message.info.id === "live" && message.parts[0]?.text === "streamed")
  ) {
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
  const transcript = Array.from({ length: 20 }, (_, index) => ({
    info: { id: `message-${index}`, sessionID: "one", role: "assistant" as const },
    parts: [{
      id: `part-${index}`,
      sessionID: "one",
      messageID: `message-${index}`,
      type: "text",
      text: "x".repeat(500_000),
    }],
  }))
  transcript[19]!.parts.push(
    {
      id: "tool",
      sessionID: "one",
      messageID: "message-19",
      type: "tool",
      state: { status: "completed", metadata: { output: "x".repeat(150_000) } },
    } as unknown as typeof transcript[number]["parts"][number],
  )
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => transcript,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const snapshot = controller.chatSnapshot()

  if (
    !parseHostMessage({ type: "snapshot", snapshot }) || snapshot.session?.messages.at(-1)?.info.id !== "message-19" ||
    snapshot.session.messages.length >= transcript.length
  ) {
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
  const grandchild = { ...session("grandchild", 1), parentID: "child" }
  const fake = {
    listSessions: async () => [parent, child, grandchild],
    sessionStatuses: async () => ({ child: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async (sessionID: string) =>
      sessionID === "parent"
        ? [{
          info: { id: "assistant", sessionID: "parent", role: "assistant" as const },
          parts: [{
            id: "task-part",
            sessionID: "parent",
            messageID: "assistant",
            type: "tool",
            tool: "task",
            state: { status: "running", title: "Map workspace", metadata: { sessionId: "child" } },
          }],
        }]
        : [{
          info: { id: "child-assistant", sessionID: "child", role: "assistant" as const },
          parts: [{
            id: "reasoning",
            sessionID: "child",
            messageID: "child-assistant",
            type: "reasoning",
            text: "Inspecting routes",
          }],
        }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "permission.asked",
    properties: {
      id: "child-permission",
      sessionID: "child",
      permission: "bash",
      patterns: ["git status"],
      always: [],
    },
  })
  internal.handleEvent({
    type: "question.v2.asked",
    properties: {
      id: "child-question",
      sessionID: "child",
      questions: [{ header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Proceed" }] }],
    },
  })
  const snapshot = controller.chatSnapshot()
  const delegation = snapshot.session?.delegations?.[0]
  const permissionAttention = snapshot.attentionItems?.find((item) => item.kind === "permission")
  const questionAttention = snapshot.attentionItems?.find((item) => item.kind === "question")

  if (
    delegation?.sessionID !== "child" || delegation.status.type !== "busy" ||
    delegation.messages[0]?.parts[0]?.text !== "Inspecting routes" ||
    snapshot.session?.permissions?.[0]?.sessionID !== "child" ||
    snapshot.session.questions?.[0]?.sessionID !== "child" ||
    snapshot.sessions[0]?.permissionCount !== 1 || snapshot.sessions[0]?.questionCount !== 1 ||
    permissionAttention?.sessionID !== "parent" ||
    permissionAttention.id !== "permission:current:child:child-permission" ||
    permissionAttention.target.itemID !== "child-permission" ||
    questionAttention?.sessionID !== "parent" || questionAttention.id !== "question:child:child-question" ||
    questionAttention.target.itemID !== "child-question" ||
    snapshot.sessions.some((entry) => entry.id === "child") ||
    !snapshot.lineage?.some((entry) =>
      entry.sessionID === "child" && entry.parentID === "parent" && entry.rootID === "parent" && entry.depth === 1 &&
      entry.relation === "child"
    ) ||
    !snapshot.lineage?.some((entry) =>
      entry.sessionID === "grandchild" && entry.parentID === "child" && entry.rootID === "parent" &&
      entry.depth === 2 && entry.relation === "child"
    ) ||
    !parseHostMessage({ type: "snapshot", snapshot })
  ) {
    throw new Error("Delegated child progress was not loaded into a valid parent snapshot")
  }
  internal.handleEvent({
    type: "question.v2.replied",
    properties: { id: "child-question", sessionID: "child" },
  })
  if (controller.chatSnapshot().attentionItems?.some((item) => item.id === "question:child:child-question")) {
    throw new Error("OpenCode question replies using the native id field left stale attention behind")
  }
  await controller.select("child")
  const childSnapshot = controller.chatSnapshot().session
  if (
    childSnapshot?.parentID !== "parent" || childSnapshot.permissions?.length !== 0 ||
    childSnapshot.questions?.length !== 0
  ) {
    throw new Error("Subagent detail snapshot omitted parent navigation or retained parent-routed approval UI")
  }
  controller.dispose()
})

Deno.test("child attention routing remains canonical across malformed parent cycles", async () => {
  const first = { ...session("cycle-a", 2), parentID: "cycle-b" }
  const second = { ...session("cycle-b", 1), parentID: "cycle-a" }
  const fake = {
    listSessions: async () => [first, second],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "cycle-permission", sessionID: "cycle-a", permission: "bash", patterns: ["pwd"], always: [] },
  })
  internal.handleEvent({
    type: "question.v2.asked",
    properties: {
      id: "cycle-question",
      sessionID: "cycle-b",
      questions: [{ header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Proceed" }] }],
    },
  })
  const attention = controller.chatSnapshot().attentionItems ?? []
  const permission = attention.find((item) => item.kind === "permission")
  const question = attention.find((item) => item.kind === "question")
  if (
    !permission?.sessionID || permission.sessionID !== question?.sessionID ||
    permission.id !== "permission:current:cycle-a:cycle-permission" || question.id !== "question:cycle-b:cycle-question"
  ) {
    throw new Error("Cyclic child ownership split attention routing or lost the exact request owner")
  }
  controller.dispose()
})

Deno.test("busy sessions durably admit prompts in queue order", async () => {
  const calls: Array<{ text: string; delivery: string; id: string }> = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({
      agents: [{ name: "build" }],
      models: [{ id: "model", providerID: "acme", name: "Model" }],
    }),
    messages: async () => [],
    sendPrompt: async (_sessionID: string, id: string, text: string, delivery: string) =>
      calls.push({ id, text, delivery }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  controller.setDraft("first")
  await controller.send("first", "build", "acme/model")
  await controller.send("second")
  controller.setDraft("new draft")
  if (
    calls.map((call) => call.text).join(",") !== "first,second" || calls.some((call) => call.delivery !== "queue") ||
    calls.some((call) => !call.id.startsWith("msg_"))
  ) {
    throw new Error("Busy prompts were not durably admitted in order")
  }

  const snapshot = controller.chatSnapshot().session
  if (
    snapshot?.queue?.length !== 0 || snapshot?.draft !== "new draft" ||
    snapshot.messages.filter((message) => message.info.role === "user").map((message) => message.parts[0]?.text).join(
        ",",
      ) !== "first,second"
  ) {
    throw new Error("Queue drain lost a newer draft, retained sent prompts, or hid admitted user messages")
  }
  controller.dispose()
})

Deno.test("busy send choices distinguish queue, steer, and stop-and-send", async () => {
  const deliveries: string[] = []
  let aborts = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async (_sessionID: string, _id: string, _text: string, delivery: string) => deliveries.push(delivery),
    abort: async () => {
      aborts += 1
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.send("queued", undefined, undefined, undefined, [], [], undefined, "queue")
  await controller.send("steer", undefined, undefined, undefined, [], [], undefined, "steer")
  await controller.send("replace", undefined, undefined, undefined, [], [], undefined, "replace")
  if (deliveries.join(",") !== "queue,steer,steer" || aborts !== 1) {
    throw new Error(`Busy send choices collapsed together: ${deliveries.join(",")} with ${aborts} aborts`)
  }
  controller.dispose()
})

Deno.test("steer choice survives another prompt admission already in progress", async () => {
  const first = deferred<void>()
  const deliveries: string[] = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async (_sessionID: string, _id: string, text: string, delivery: string) => {
      deliveries.push(`${text}:${delivery}`)
      if (text === "first") await first.promise
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const admitting = controller.send("first", undefined, undefined, undefined, [], [], undefined, "queue")
  await controller.send("second", undefined, undefined, undefined, [], [], undefined, "steer")
  first.resolve()
  await admitting
  await Promise.resolve()
  await Promise.resolve()
  if (deliveries.join(",") !== "first:queue,second:steer") {
    throw new Error(`Steer choice was lost while queued: ${deliveries.join(",")}`)
  }
  controller.dispose()
})

Deno.test("sending a retained queued prompt now stops before legacy delivery", async () => {
  const events: string[] = []
  let deliveredID = ""
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "openai", name: "OpenAI", source: "custom" as const }],
      models: [{ id: "model", providerID: "openai", name: "Model" }],
    }),
    messages: async () => [],
    abort: async () => {
      events.push("abort")
      return true
    },
    sendAsync: async (
      _sessionID: string,
      text: string,
      _agent?: string,
      _model?: string,
      _variant?: string,
      _files?: unknown[],
      messageID?: string,
    ) => {
      deliveredID = messageID ?? ""
      events.push(`send:${text}`)
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const promptID = "msg_018bcfe568001234567890abcd"
  await controller.send("retained", undefined, "openai/model", undefined, [], [], promptID)
  if (controller.snapshot.sessions.one?.queue[0]?.id !== promptID || events.length) {
    throw new Error("Busy legacy prompt was not retained in the queue")
  }
  await controller.sendQueuedNow("one", promptID)
  if (
    events.join(",") !== "abort,send:retained" || controller.snapshot.sessions.one?.queue.length ||
    !isOpenCodeMessageID(deliveredID) || deliveredID !== promptID
  ) {
    throw new Error("Queued send-now did not stop before sending or retained the prompt")
  }
  controller.dispose()
})

Deno.test("legacy history keeps standard providers on legacy transport", async () => {
  const assistant: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abcd", sessionID: "one", role: "assistant", time: { created: 1 } },
    parts: [],
  }
  const calls: string[] = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "acme", name: "Acme", source: "api" as const }],
      models: [{ id: "model", providerID: "acme", name: "Model" }],
    }),
    messageHistory: async () => ({ messages: [assistant], legacyMessageIDs: [assistant.info.id], v2MessageIDs: [] }),
    messages: async () => [assistant],
    sendAsync: async () => calls.push("legacy"),
    sendPrompt: async () => calls.push("v2"),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.send("continue", undefined, "acme/model")
  if (calls.join(",") !== "legacy") throw new Error("Legacy session context switched to V2 transport")
  controller.dispose()
})

Deno.test("unsafe legacy IDs recover through a remapped fork", async () => {
  const unsafe: MessageBundle = {
    info: { id: "msg_ffffffffffffffffffffffffffffffff", sessionID: "one", role: "user", time: { created: 1 } },
    parts: [{
      id: "part",
      sessionID: "one",
      messageID: "msg_ffffffffffffffffffffffffffffffff",
      type: "text",
      text: "old",
    }],
  }
  const recovered: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abcd", sessionID: "fork", role: "user", time: { created: 1 } },
    parts: [],
  }
  let sentSession = ""
  let recoveredMapping = ""
  let deletes = 0
  const source = { ...session("one", 1), title: "Dashboard" }
  const fork = { ...session("fork", 2), title: "Dashboard (fork #1)" }
  const fake = {
    listSessions: async () => [source],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "openai", name: "OpenAI", source: "custom" as const }],
      models: [{ id: "model", providerID: "openai", name: "Model" }],
    }),
    messageHistory: async (sessionID: string) =>
      sessionID === "one"
        ? { messages: [unsafe], legacyMessageIDs: [unsafe.info.id], v2MessageIDs: [] }
        : { messages: [recovered], legacyMessageIDs: [recovered.info.id], v2MessageIDs: [] },
    messages: async () => [],
    forkSession: async () => fork,
    deleteSession: async () => {
      deletes += 1
      return true
    },
    sendAsync: async (sessionID: string) => {
      sentSession = sessionID
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, {
    error: () => undefined,
    sessionRecovered: (sourceID, recoveredID) => {
      recoveredMapping = `${sourceID}:${recoveredID}`
    },
  })
  await controller.reconcile()
  await controller.send("continue", undefined, "openai/model")
  const sessions = controller.chatSnapshot().sessions
  if (
    sentSession !== "fork" || controller.snapshot.selectedID !== "fork" || recoveredMapping !== "one:fork" ||
    deletes !== 0 ||
    sessions.length !== 1 || sessions[0]?.id !== "fork" || sessions[0]?.title !== "Dashboard (fork #1)" ||
    controller.chatSnapshot().session?.title !== sessions[0].title ||
    controller.visibleSessionIDs().join(",") !== "fork"
  ) {
    throw new Error("Unsafe legacy recovery did not preserve one non-destructive logical session")
  }
  controller.dispose()
})

Deno.test("unsafe legacy IDs outside the recent page still recover before sending", async () => {
  const safe: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abcd", sessionID: "one", role: "assistant", time: { created: 2 } },
    parts: [],
  }
  const unsafe: MessageBundle = {
    info: { id: "legacy-unsafe", sessionID: "one", role: "user", time: { created: 1 } },
    parts: [],
  }
  const recovered: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abce", sessionID: "fork", role: "assistant", time: { created: 3 } },
    parts: [],
  }
  let sentSession = ""
  let fullHistoryReads = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "openai", name: "OpenAI", source: "custom" as const }],
      models: [{ id: "model", providerID: "openai", name: "Model" }],
    }),
    messageHistoryPage: async () => ({
      messages: [safe],
      legacyMessageIDs: [safe.info.id],
      v2MessageIDs: [],
      cursor: { legacy: "older", legacyComplete: false, v2Complete: true },
    }),
    messageHistory: async (sessionID: string) => {
      fullHistoryReads += 1
      return sessionID === "one"
        ? { messages: [unsafe, safe], legacyMessageIDs: [unsafe.info.id, safe.info.id], v2MessageIDs: [] }
        : { messages: [recovered], legacyMessageIDs: [recovered.info.id], v2MessageIDs: [] }
    },
    forkSession: async () => ({ ...session("fork", 2), title: "Recovered" }),
    sendAsync: async (sessionID: string) => {
      sentSession = sessionID
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.send("continue", undefined, "openai/model")
  if (fullHistoryReads !== 1 || sentSession !== "fork" || controller.snapshot.selectedID !== "fork") {
    throw new Error(
      `Older unsafe legacy history was not recovered before send: ${
        JSON.stringify({ fullHistoryReads, sentSession, selected: controller.snapshot.selectedID })
      }`,
    )
  }
  controller.dispose()
})

Deno.test("concurrent unsafe-session sends create only one recovery fork", async () => {
  const fork = deferred<SessionInfo>()
  const unsafe: MessageBundle = {
    info: { id: "msg_ffffffffffffffffffffffffffffffff", sessionID: "one", role: "user", time: { created: 1 } },
    parts: [],
  }
  let forkCalls = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "openai", name: "OpenAI", source: "custom" as const }],
      models: [{ id: "model", providerID: "openai", name: "Model" }],
    }),
    messageHistory: async () => ({ messages: [unsafe], legacyMessageIDs: [unsafe.info.id], v2MessageIDs: [] }),
    messages: async () => [unsafe],
    forkSession: () => {
      forkCalls += 1
      return fork.promise
    },
    sendAsync: async () => undefined,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const first = controller.send("continue", undefined, "openai/model")
  const rejected = await controller.send("again", undefined, "openai/model").then(
    () => false,
    (error) => /already being recovered/.test(String(error)),
  )
  fork.resolve(session("fork", 2))
  await first
  if (!rejected || forkCalls !== 1) throw new Error("Concurrent sends created duplicate recovery forks")
  controller.dispose()
})

Deno.test("persisted recovery mapping reuses its existing fork", async () => {
  const unsafe: MessageBundle = {
    info: { id: "msg_ffffffffffffffffffffffffffffffff", sessionID: "one", role: "user", time: { created: 1 } },
    parts: [],
  }
  const safe: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abcd", sessionID: "fork", role: "assistant", time: { created: 2 } },
    parts: [],
  }
  let forks = 0
  let sentSession = ""
  const fake = {
    listSessions: async () => [session("one", 2), session("fork", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "openai", name: "OpenAI", source: "custom" as const }],
      models: [{ id: "model", providerID: "openai", name: "Model" }],
    }),
    messageHistory: async (sessionID: string) =>
      sessionID === "one"
        ? { messages: [unsafe], legacyMessageIDs: [unsafe.info.id], v2MessageIDs: [] }
        : { messages: [safe], legacyMessageIDs: [safe.info.id], v2MessageIDs: [] },
    messages: async () => [],
    forkSession: async () => {
      forks += 1
      return session("unexpected", 3)
    },
    sendAsync: async (sessionID: string) => {
      sentSession = sessionID
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined }, undefined, "one", { one: "fork" })
  await controller.reconcile()
  await controller.send("continue", undefined, "openai/model")
  if (forks || sentSession !== "fork" || controller.snapshot.selectedID !== "fork") {
    throw new Error("Persisted recovered session was not reused")
  }
  controller.dispose()
})

Deno.test("recovered sessions replace their source in session lists", async () => {
  const source = { ...session("source", 1), title: "Dashboard" }
  const recovered = { ...session("recovered", 2), title: "Dashboard (fork #1)" }
  const fake = {
    listSessions: async () => [recovered, source],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined }, undefined, "source", {
    source: "recovered",
  })
  await controller.reconcile()
  const sessions = controller.chatSnapshot().sessions
  if (
    sessions.length !== 1 || sessions[0]?.id !== "recovered" || sessions[0]?.title !== "Dashboard (fork #1)" ||
    controller.chatSnapshot().session?.title !== sessions[0].title || controller.snapshot.selectedID !== "recovered"
  ) {
    throw new Error("Recovered session did not replace its source as one logical session")
  }
  controller.dispose()
})

Deno.test("persisted recovery mapping collapses clustered duplicate forks", async () => {
  const source = { ...session("source", 1), title: "Dashboard" }
  const older = { ...session("older", 2), title: "Dashboard (fork #1)" }
  const newest = { ...session("newest", 3), title: "Dashboard (fork #1)" }
  const later = { ...session("later", 4), title: "Dashboard (fork #1)", time: { created: 60_000, updated: 4 } }
  const fake = {
    listSessions: async () => [later, newest, older, source],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined }, undefined, "older", { source: "newest" })
  await controller.reconcile()
  const sessions = controller.chatSnapshot().sessions
  if (
    sessions.length !== 2 || sessions[0]?.id !== "later" || sessions[1]?.id !== "newest" ||
    sessions[1]?.title !== "Dashboard (fork #1)" || controller.snapshot.selectedID !== "newest" ||
    controller.chatSnapshot().session?.title !== sessions[1].title ||
    controller.visibleSessionIDs().join(",") !== "later,newest"
  ) {
    throw new Error("Persisted recovery duplicates were not presented as one logical session")
  }
  controller.dispose()
})

Deno.test("ordinary same-title forks remain distinct without recovery evidence", async () => {
  const source = { ...session("source", 1), title: "Dashboard" }
  const first = { ...session("first", 2), title: "Dashboard (fork #1)" }
  const second = { ...session("second", 3), title: "Dashboard (fork #1)" }
  const fake = {
    listSessions: async () => [second, first, source],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  if (controller.chatSnapshot().sessions.length !== 3 || controller.visibleSessionIDs().length !== 3) {
    throw new Error("Ordinary user-created forks were mistaken for recovery duplicates")
  }
  controller.dispose()
})

Deno.test("selected children do not reveal a hidden recovery source", async () => {
  const source = { ...session("source", 1), title: "Dashboard" }
  const recovered = { ...session("recovered", 2), title: "Dashboard (fork #1)" }
  const child = { ...session("child", 3), title: "Subagent", parentID: "source" }
  const fake = {
    listSessions: async () => [child, recovered, source],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined }, undefined, "child", {
    source: "recovered",
  })
  await controller.reconcile()
  const sessions = controller.chatSnapshot().sessions
  if (controller.snapshot.selectedID !== "child" || sessions.length !== 1 || sessions[0]?.id !== "recovered") {
    throw new Error("Selecting a child exposed the hidden recovery source")
  }
  controller.dispose()
})

Deno.test("idle trailing user turns are marked interrupted", async () => {
  const user: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abcd", sessionID: "one", role: "user", time: { created: 1 } },
    parts: [],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messageHistory: async () => ({ messages: [user], legacyMessageIDs: [user.info.id], v2MessageIDs: [] }),
    messages: async () => [user],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const status = controller.snapshot.sessions.one?.status
  if (status?.type !== "error" || !status.message?.includes("interrupted")) {
    throw new Error("Interrupted session was presented as idle")
  }
  controller.dispose()
})

Deno.test("upstream session errors survive transcript reconciliation", async () => {
  const user: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abcd", sessionID: "one", role: "user", time: { created: 1 } },
    parts: [],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "error" as const, message: "Expected an OpenCode prt_ part ID" } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messageHistory: async () => ({ messages: [user], legacyMessageIDs: [user.info.id], v2MessageIDs: [] }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const status = controller.snapshot.sessions.one?.status
  if (status?.type !== "error" || status.message !== "Expected an OpenCode prt_ part ID") {
    throw new Error("Transcript reconciliation replaced the actionable upstream error")
  }
  controller.dispose()
})

Deno.test("persisted empty provider responses are explained", async () => {
  const assistant: MessageBundle = {
    info: {
      id: "msg_018bcfe568001234567890abcd",
      sessionID: "one",
      role: "assistant",
      time: { created: 1, completed: 2 },
      finish: "unknown",
    },
    parts: [{ id: "step", sessionID: "one", messageID: "msg_018bcfe568001234567890abcd", type: "step-finish" }],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messageHistory: async () => ({ messages: [assistant], legacyMessageIDs: [assistant.info.id], v2MessageIDs: [] }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const status = controller.snapshot.sessions.one?.status
  if (status?.type !== "error" || !status.message?.includes("without returning a response")) {
    throw new Error("An empty unknown provider result was presented as a successful turn")
  }
  controller.dispose()
})

Deno.test("provider errors remain terminal across error, idle, and message event ordering", async () => {
  let polledStatus: Record<string, { type: "busy" }> = {}
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => polledStatus,
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  const currentStatus = () => controller.snapshot.sessions.one?.status.type
  internal.handleEvent({
    type: "session.error",
    properties: { sessionID: "one", error: { data: { message: "Provider stream failed" } } },
  })
  internal.handleEvent({ type: "session.status", properties: { sessionID: "one", status: { type: "idle" } } })
  internal.handleEvent({ type: "session.idle", properties: { sessionID: "one" } })
  internal.handleEvent({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_018bcfe568001234567890abcd",
        sessionID: "one",
        role: "assistant",
        error: { data: { message: "Provider stream failed" } },
      },
    },
  })
  const status = controller.snapshot.sessions.one?.status
  if (status?.type !== "error" || status.message !== "Provider stream failed") {
    throw new Error("Provider failure was overwritten by a trailing idle or message event")
  }
  internal.handleEvent({
    type: "session.next.retried",
    properties: { sessionID: "one", attempt: 1, error: { message: "Retrying" } },
  })
  internal.handleEvent({ type: "session.status", properties: { sessionID: "one", status: { type: "idle" } } })
  if (currentStatus() !== "idle") throw new Error("A retry retained a stale terminal provider failure")
  internal.handleEvent({
    type: "session.error",
    properties: { sessionID: "one", error: { data: { message: "Provider stream failed" } } },
  })
  polledStatus = { one: { type: "busy" } }
  await controller.reconcile()
  internal.handleEvent({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_018bcfe568001234567890abcd",
        sessionID: "one",
        role: "assistant",
        error: { data: { message: "Provider stream failed" } },
      },
    },
  })
  if (currentStatus() !== "busy") throw new Error("A delayed failed-assistant update replaced newer busy work")
  internal.handleEvent({ type: "session.status", properties: { sessionID: "one", status: { type: "idle" } } })
  if (currentStatus() !== "idle") throw new Error("A reconciled busy turn retained a stale provider failure")
  controller.dispose()
})

Deno.test("controller restores the persisted selected session", async () => {
  let selected = ""
  const fake = {
    listSessions: async () => [session("one", 2), session("two", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(
    fake,
    {
      error: () => undefined,
      selectionChanged: (sessionID) => {
        selected = sessionID ?? ""
      },
    },
    undefined,
    "two",
  )
  await controller.reconcile()
  if (controller.snapshot.selectedID !== "two" || selected !== "two") {
    throw new Error("Persisted session selection was not restored")
  }
  controller.dispose()
})

Deno.test("transcript refresh preserves admitted prompt text until the server projects it", async () => {
  const promptID = "msg_018bcfe568001234567890abcd"
  let messageCalls = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => {
      messageCalls += 1
      return messageCalls === 1 ? [] : [{ info: { id: promptID, sessionID: "one", role: "user" as const }, parts: [] }]
    },
    sendPrompt: async () => undefined,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.send("Visible prompt", undefined, undefined, undefined, [], [], promptID)
  const internal = controller as unknown as { loadTranscript(sessionID: string, markLoading: boolean): Promise<void> }
  await internal.loadTranscript("one", false)
  const user = controller.snapshot.sessions.one?.messages.find((entry) => entry.info.id === promptID)
  if (user?.parts[0]?.text !== "Visible prompt") {
    throw new Error("Incomplete transcript projection replaced the admitted prompt text")
  }
  controller.dispose()
})

Deno.test("idle native compaction continuation is not reported as an unanswered user prompt", async () => {
  const messages: MessageBundle[] = [
    {
      info: { id: "compact", sessionID: "one", role: "user" },
      parts: [{ id: "compact-part", sessionID: "one", messageID: "compact", type: "compaction" }],
    },
    {
      info: { id: "summary", sessionID: "one", role: "assistant", parentID: "compact", summary: true, finish: "stop" },
      parts: [{ id: "summary-part", sessionID: "one", messageID: "summary", type: "text", text: "Compacted context" }],
    },
    {
      info: { id: "continue", sessionID: "one", role: "user" },
      parts: [{
        id: "continue-part",
        sessionID: "one",
        messageID: "continue",
        type: "text",
        text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        synthetic: true,
        metadata: { compaction_continue: true },
      }],
    },
  ]
  const errors: string[] = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => messages,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: (error) => errors.push(error) })
  await controller.reconcile()
  const selected = controller.chatSnapshot().session
  if (selected?.status.type !== "idle" || errors.length) {
    throw new Error("A persisted native compaction continuation was reported as a failed user turn")
  }
  controller.dispose()
})

Deno.test("manual compaction follows the owning session transport without mixing protocols", async () => {
  let native = 0
  let legacy = 0
  const user: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abcd", sessionID: "one", role: "user", time: { created: 1 } },
    parts: [{ id: "text", sessionID: "one", messageID: "msg_018bcfe568001234567890abcd", type: "text", text: "hello" }],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messageHistory: async () => ({ messages: [user], legacyMessageIDs: [], v2MessageIDs: [user.info.id] }),
    compactSessionV2: async (sessionID: string, id: string) => {
      native += 1
      return { admittedSeq: 2, id, sessionID, type: "compaction" as const, timeCreated: 3 }
    },
    summarizeSession: async () => {
      legacy += 1
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.compactSession("one")
  if (native !== 1 || legacy !== 0 || controller.chatSnapshot().session?.status.type !== "busy") {
    throw new Error("V2 session compaction crossed into the legacy summarizer")
  }
  controller.dispose()
})

Deno.test("unsupported native manual compaction fails honestly instead of mutating legacy state", async () => {
  let legacy = 0
  const user: MessageBundle = {
    info: { id: "msg_018bcfe568001234567890abcd", sessionID: "one", role: "user", time: { created: 1 } },
    parts: [{ id: "text", sessionID: "one", messageID: "msg_018bcfe568001234567890abcd", type: "text", text: "hello" }],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messageHistory: async () => ({ messages: [user], legacyMessageIDs: [], v2MessageIDs: [user.info.id] }),
    compactSessionV2: async () => {
      throw new Error("OpenCode POST /api/session/one/compact failed (503): session.compact is not available yet")
    },
    summarizeSession: async () => {
      legacy += 1
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  let rejected = false
  try {
    await controller.compactSession("one")
  } catch (error) {
    rejected = /does not support native manual compaction/.test(error instanceof Error ? error.message : String(error))
  }
  if (!rejected || legacy !== 0) {
    throw new Error("Unavailable V2 compaction silently fell back to the legacy transcript")
  }
  controller.dispose()
})

Deno.test("pending prompt text fills an info-only server event before admission completes", async () => {
  const promptID = "msg_018bcfe568001234567890abcd"
  const admission = deferred<void>()
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: () => admission.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()

  const sending = controller.send("Visible before admission", undefined, undefined, undefined, [], [], promptID)
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "message.updated",
    properties: { info: { id: promptID, sessionID: "one", role: "user" } },
  })
  const pending = controller.chatSnapshot().session?.messages.find((entry) => entry.info.id === promptID)
  if (pending?.parts[0]?.text !== "Visible before admission") {
    throw new Error("Info-only server event exposed the Message sent placeholder")
  }
  const patch = controller.messagePatches([{ sessionID: "one", messageID: promptID }])?.[0]
  if (patch?.message?.parts[0]?.text !== "Visible before admission") {
    throw new Error("Targeted info-only patch omitted pending prompt text")
  }

  admission.resolve()
  await sending
  controller.dispose()
})

Deno.test("ambiguous prompt failure retains visible text from the queued prompt", async () => {
  const promptID = "msg_018bcfe568001234567890abce"
  let emitInfo: () => void = () => undefined
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async () => {
      emitInfo()
      throw new Error("response lost after admission")
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  emitInfo = () =>
    internal.handleEvent({
      type: "message.updated",
      properties: { info: { id: promptID, sessionID: "one", role: "user" } },
    })

  let rejected = false
  await controller.send("Still visible after failure", undefined, undefined, undefined, [], [], promptID).catch(() => {
    rejected = true
  })
  const message = controller.chatSnapshot().session?.messages.find((entry) => entry.info.id === promptID)
  if (
    rejected || Number(controller.chatSnapshot().session?.queue?.length ?? 0) !== 0 ||
    message?.parts[0]?.text !== "Still visible after failure"
  ) {
    throw new Error("Durably confirmed admission remained failed, queued, or reverted to a placeholder")
  }
  controller.dispose()
})

Deno.test("legacy background failures retain prompt text and exact error detail", async () => {
  let emit: (event: { type: string; properties: Record<string, unknown> }) => void = () => undefined
  let admittedID = ""
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "custom", name: "Custom", source: "custom" as const }],
      models: [{ id: "model", providerID: "custom", name: "Model" }],
    }),
    messageHistory: async () => ({ messages: [], legacyMessageIDs: [], v2MessageIDs: [] }),
    sendAsync: async (
      _sessionID: string,
      _text: string,
      _agent?: string,
      _model?: string,
      _variant?: string,
      _files?: unknown[],
      messageID?: string,
    ) => {
      admittedID = messageID ?? ""
      emit({ type: "message.updated", properties: { info: { id: admittedID, sessionID: "one", role: "user" } } })
      emit({
        type: "session.error",
        properties: { sessionID: "one", error: { data: { message: "Injected part ID was invalid" } } },
      })
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  emit = (event) => internal.handleEvent(event)
  await controller.send("Keep this visible", undefined, "custom/model")
  const visible = controller.chatSnapshot().session?.messages.find((entry) => entry.info.id === admittedID)
  const status = controller.snapshot.sessions.one?.status
  if (
    visible?.parts[0]?.text !== "Keep this visible" || status?.type !== "error" ||
    status.message !== "Injected part ID was invalid"
  ) {
    throw new Error("Legacy asynchronous failure hid the prompt or its exact error")
  }
  controller.dispose()
})

Deno.test("legacy history shells cannot erase retained prompt text", async () => {
  let admittedID = ""
  let history: MessageBundle[] = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "custom", name: "Custom", source: "custom" as const }],
      models: [{ id: "model", providerID: "custom", name: "Model" }],
    }),
    messageHistory: async () => ({
      messages: history,
      legacyMessageIDs: history.map((entry) => entry.info.id),
      v2MessageIDs: [],
    }),
    sendAsync: async (
      _sessionID: string,
      _text: string,
      _agent?: string,
      _model?: string,
      _variant?: string,
      _files?: unknown[],
      messageID?: string,
    ) => {
      admittedID = messageID ?? ""
      history = [{
        info: { id: admittedID, sessionID: "one", role: "user" as const },
        parts: [{
          id: "prt_018bcfe568001234567890abcd",
          sessionID: "one",
          messageID: admittedID,
          type: "text",
          text: "<approved_preference_data>Preference</approved_preference_data>",
          synthetic: true,
        }],
      }]
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.send("Retain across history", undefined, "custom/model")
  const internal = controller as unknown as { loadTranscript(sessionID: string, markLoading: boolean): Promise<void> }
  await internal.loadTranscript("one", false)
  const visible = controller.chatSnapshot().session?.messages.find((entry) => entry.info.id === admittedID)
  if (!visible?.parts.some((part) => !part.synthetic && part.text === "Retain across history")) {
    throw new Error("A persisted legacy message shell erased retained prompt text")
  }
  controller.dispose()
})

Deno.test("attachment-only legacy prompts release pending state after file persistence", async () => {
  let admittedID = ""
  let history: MessageBundle[] = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      providers: [{ id: "custom", name: "Custom", source: "custom" as const }],
      models: [{ id: "model", providerID: "custom", name: "Model" }],
    }),
    messageHistory: async () => ({
      messages: history,
      legacyMessageIDs: history.map((entry) => entry.info.id),
      v2MessageIDs: [],
    }),
    sendAsync: async (
      _sessionID: string,
      _text: string,
      _agent?: string,
      _model?: string,
      _variant?: string,
      _files?: unknown[],
      messageID?: string,
    ) => {
      admittedID = messageID ?? ""
      history = [{ info: { id: admittedID, sessionID: "one", role: "user" as const }, parts: [] }]
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.send("   ", undefined, "custom/model", undefined, [{
    type: "file",
    mime: "image/png",
    filename: "theme.png",
    url: "data:image/png;base64,AA==",
  }])
  const internal = controller as unknown as {
    loadTranscript(sessionID: string, markLoading: boolean): Promise<void>
    pendingPromptSessions: Map<string, string>
  }
  await internal.loadTranscript("one", false)
  if (!internal.pendingPromptSessions.has(admittedID)) {
    throw new Error("Partial file history released attachment-only pending state")
  }
  history = [{
    info: { id: admittedID, sessionID: "one", role: "user" },
    parts: [
      {
        id: "prt_018bcfe568001234567890abce",
        sessionID: "one",
        messageID: admittedID,
        type: "text",
        text: "<approved_preference_data>Preference</approved_preference_data>",
        synthetic: true,
      },
      {
        id: "prt_018bcfe568001234567890abcd",
        sessionID: "one",
        messageID: admittedID,
        type: "file",
        mime: "image/png",
        filename: "theme.png",
      },
    ],
  }]
  await internal.loadTranscript("one", false)
  if (internal.pendingPromptSessions.has(admittedID)) {
    throw new Error("Persisted attachment did not release pending legacy state")
  }
  controller.dispose()
})

Deno.test("synthetic prompt projection stays ordered after buffered server parts", async () => {
  const promptID = "msg_018bcfe568001234567890abcf"
  let enqueueServerProjection: () => void = () => undefined
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async () => enqueueServerProjection(),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    eventBus: { emit(event: { type: string; properties: Record<string, unknown> }): void; flush(): void }
  }
  enqueueServerProjection = () => {
    internal.eventBus.emit({
      type: "message.updated",
      properties: { info: { id: promptID, sessionID: "one", role: "user" } },
    })
    internal.eventBus.emit({
      type: "message.part.updated",
      properties: { part: { id: `${promptID}-text`, sessionID: "one", messageID: promptID, type: "text", text: "" } },
    })
  }

  await controller.send("Locally projected text", undefined, undefined, undefined, [], [], promptID)
  internal.eventBus.flush()
  const message = controller.snapshot.sessions.one?.messages.find((entry) => entry.info.id === promptID)
  if (message?.parts[0]?.text !== "Locally projected text") {
    throw new Error("Buffered server projection overwrote the newer synthetic prompt text")
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
  if (!rejected || calls.join(",") !== "accepted") {
    throw new Error("Reload pause admitted a prompt or failed to resume prompt sending")
  }
  controller.dispose()
})

Deno.test("custom providers use compatible legacy prompt transport", async () => {
  const calls: Array<{ text: string; agent?: string; model?: string; variant?: string; messageID?: string }> = []
  const admissions: Array<{ sessionID: string; promptID: string; admittedAt: number }> = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [{ name: "caveboss" }],
      providers: [{ id: "openai", name: "OpenAI", source: "custom" as const }],
      models: [{ id: "gpt-5.6-sol", providerID: "openai", name: "GPT-5.6 Sol", variants: ["high"] }],
    }),
    messages: async () => [],
    sendAsync: async (
      _sessionID: string,
      text: string,
      agent?: string,
      model?: string,
      variant?: string,
      _files?: unknown[],
      messageID?: string,
    ) => calls.push({ text, agent, model, variant, messageID }),
    sendPrompt: () => {
      throw new Error("Custom provider used incompatible v2 transport")
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, {
    error: () => undefined,
    promptAdmitted: (sessionID, promptID, admittedAt) => admissions.push({ sessionID, promptID, admittedAt }),
  })
  await controller.reconcile()
  const promptID = "msg_018bcfe568001234567890abcd"
  await controller.send("hello", "caveboss", "openai/gpt-5.6-sol", "high", [], [], promptID)
  if (
    calls.length !== 1 || calls[0]?.text !== "hello" || calls[0].agent !== "caveboss" ||
    calls[0].model !== "openai/gpt-5.6-sol" || calls[0].variant !== "high" || calls[0].messageID !== promptID
  ) {
    throw new Error("Custom provider prompt did not preserve composer selection")
  }
  if (admissions.length) throw new Error("Legacy prompt_async HTTP acceptance was reported as durable admission")
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "message.updated",
    properties: { info: { id: promptID, sessionID: "one", role: "user", time: { created: 123 } } },
  })
  internal.handleEvent({
    type: "message.updated",
    properties: { info: { id: promptID, sessionID: "one", role: "user", time: { created: 123 } } },
  })
  if (admissions.length !== 1 || admissions[0]?.promptID !== promptID || admissions[0].admittedAt !== 123) {
    throw new Error(`Legacy durable admission was not confirmed exactly once: ${JSON.stringify(admissions)}`)
  }
  controller.dispose()
})

Deno.test("retries the selected prompt with its attachments", async () => {
  const calls: Array<{ reverted?: string; text?: string; files?: Array<{ url: string }> }> = []
  const older: MessageBundle = {
    info: { id: "older", sessionID: "one", role: "user" },
    parts: [{ id: "older-text", sessionID: "one", messageID: "older", type: "text", text: "Older prompt" }],
  }
  const olderResponse: MessageBundle = {
    info: { id: "older-response", sessionID: "one", role: "assistant" },
    parts: [],
  }
  const user: MessageBundle = {
    info: { id: "user", sessionID: "one", role: "user" },
    parts: [
      { id: "text", sessionID: "one", messageID: "user", type: "text", text: "Try again" },
      {
        id: "file",
        sessionID: "one",
        messageID: "user",
        type: "file",
        mime: "image/png",
        filename: "image.png",
        url: "data:image/png;base64,eA==",
      },
    ],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [older, olderResponse, user],
    revertSession: async (_sessionID: string, messageID: string) => {
      calls.push({ reverted: messageID })
      return session("one", 2)
    },
    sendPrompt: async (
      _sessionID: string,
      _promptID: string,
      text: string,
      _delivery: string,
      _agent?: string,
      _model?: string,
      _variant?: string,
      files?: Array<{ url: string }>,
    ) => {
      calls.push({ text, files })
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  controller.setSessionDraft("one", "Keep this draft")
  await controller.retrySession("one", "older-response")
  if (calls[0]?.reverted !== "older" || calls[1]?.text !== "Older prompt" || calls[1]?.files?.length) {
    throw new Error("Retry did not revert and resubmit the selected prompt")
  }
  if (controller.chatSnapshot().session?.draft !== "Keep this draft") {
    throw new Error("Retry cleared an unrelated draft")
  }
  controller.dispose()
})

Deno.test("failed retries restore the reverted turn and stay in their original session", async () => {
  const reverted = deferred<void>()
  const calls: string[] = []
  const user: MessageBundle = {
    info: { id: "user", sessionID: "one", role: "user" },
    parts: [{ id: "text", sessionID: "one", messageID: "user", type: "text", text: "Retry me" }],
  }
  const fake = {
    listSessions: async () => [session("one", 2), session("two", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async (sessionID: string) => sessionID === "one" ? [user] : [],
    revertSession: async (sessionID: string) => {
      calls.push(`revert:${sessionID}`)
      await reverted.promise
      return session(sessionID, 3)
    },
    sendPrompt: async (sessionID: string) => {
      calls.push(`send:${sessionID}`)
      throw new Error("send failed")
    },
    unrevertSession: async (sessionID: string) => {
      calls.push(`redo:${sessionID}`)
      return session(sessionID, 4)
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const retry = controller.retrySession("one").then(() => false, () => true)
  await controller.select("two")
  reverted.resolve(undefined)
  if (
    !await retry || calls.join(",") !== "revert:one,send:one,redo:one" || controller.snapshot.sessions.one?.queue.length
  ) {
    throw new Error(`Retry selection race or rollback failed: ${calls.join(",")}`)
  }
  controller.dispose()
})

Deno.test("concurrent retries are rejected before a second revert", async () => {
  const revert = deferred<SessionInfo>()
  let revertCalls = 0
  const user: MessageBundle = {
    info: { id: "user", sessionID: "one", role: "user" },
    parts: [{ id: "text", sessionID: "one", messageID: "user", type: "text", text: "Retry me" }],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [user],
    revertSession: () => {
      revertCalls += 1
      return revert.promise
    },
    sendPrompt: async () => undefined,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const first = controller.retrySession("one")
  let rejected = false
  try {
    await controller.retrySession("one")
  } catch {
    rejected = true
  }
  revert.resolve(session("one", 2))
  await first
  if (!rejected || revertCalls !== 1) throw new Error("Concurrent retry performed a second revert")
  controller.dispose()
})

Deno.test("retry rolls back when transcript reload fails after revert", async () => {
  let messageCalls = 0
  let restored = false
  const user: MessageBundle = {
    info: { id: "user", sessionID: "one", role: "user" },
    parts: [{ id: "text", sessionID: "one", messageID: "user", type: "text", text: "Retry me" }],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => {
      messageCalls += 1
      if (messageCalls === 2) throw new Error("reload failed")
      return [user]
    },
    revertSession: async () => session("one", 2),
    unrevertSession: async () => {
      restored = true
      return session("one", 3)
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.retrySession("one").catch(() => undefined)
  if (!restored) throw new Error("Retry did not restore a turn after post-revert reload failure")
  controller.dispose()
})

Deno.test("retry keeps an ambiguously accepted prompt instead of unreverting", async () => {
  let messageCalls = 0
  let restored = false
  let retriedID = ""
  const user: MessageBundle = {
    info: { id: "user", sessionID: "one", role: "user" },
    parts: [{ id: "text", sessionID: "one", messageID: "user", type: "text", text: "Retry me" }],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => {
      messageCalls += 1
      return messageCalls >= 3 && retriedID
        ? [user, { info: { id: retriedID, sessionID: "one", role: "user" as const }, parts: [] }]
        : [user]
    },
    revertSession: async () => session("one", 2),
    sendPrompt: async (_sessionID: string, promptID: string) => {
      retriedID = promptID
      throw new Error("response lost")
    },
    unrevertSession: async () => {
      restored = true
      return session("one", 3)
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.retrySession("one")
  if (restored || controller.snapshot.sessions.one?.queue.length) {
    throw new Error("Accepted retry was rolled back or remained queued")
  }
  controller.dispose()
})

Deno.test("forks from a selected transcript message", async () => {
  let forkedFrom = ""
  const user: MessageBundle = { info: { id: "user", sessionID: "one", role: "user" }, parts: [] }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async (sessionID: string) => sessionID === "one" ? [user] : [],
    forkSession: async (_sessionID: string, messageID?: string) => {
      forkedFrom = messageID ?? ""
      return session("fork", 2)
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  await controller.forkSession("one", "user")
  if (forkedFrom !== "user" || controller.chatSnapshot().session?.id !== "fork") {
    throw new Error("Message-scoped fork was not selected")
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
    if (controller.chatSnapshot().session?.messages.some((message) => message.info.id === "assistant")) {
      refreshed.resolve(undefined)
    }
  })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "session.next.step.failed",
    properties: { sessionID: "one", error: { message: "Provider failed" } },
  })
  await refreshed.promise
  const snapshot = controller.chatSnapshot().session
  if (
    snapshot?.status.type !== "error" || snapshot.status.message !== "Provider failed" ||
    snapshot.messages[0]?.info.id !== "assistant"
  ) {
    throw new Error("V2 terminal event did not refresh projected output and error status")
  }
  controller.dispose()
})

Deno.test("v2 step completion waits for authoritative runner settlement and preserves queue delivery", async () => {
  let active = true
  const deliveries: string[] = []
  let statusCalls = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => {
      statusCalls += 1
      return active ? { one: { type: "busy" as const } } : {}
    },
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async (sessionID: string, id: string, _text: string, delivery: "queue" | "steer") => {
      deliveries.push(delivery)
      return { admittedSeq: 1, id, sessionID, delivery, timeCreated: 123 }
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "session.next.step.ended",
    properties: { sessionID: "one", assistantMessageID: "assistant", finish: "stop" },
  })
  if (controller.chatSnapshot().session?.status.type !== "busy") {
    throw new Error("A provider step end was mistaken for complete session settlement")
  }
  await controller.send("Follow up while the runner is still draining")
  if (deliveries.join(",") !== "queue") {
    throw new Error(`False idle changed a follow-up into ${deliveries.join(",") || "no delivery"}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 45))
  if (controller.chatSnapshot().session?.status.type !== "busy" || statusCalls < 2) {
    throw new Error("Active OpenCode runner was marked idle by the settlement probe")
  }
  active = false
  await new Promise((resolve) => setTimeout(resolve, 140))
  if (controller.chatSnapshot().session?.status.type !== "idle") {
    throw new Error("Inactive OpenCode runner did not settle the Workbench session")
  }
  controller.dispose()
})

Deno.test("v2 live events stream text, reasoning, tool input, and preferences", async () => {
  const errors: string[] = []
  let messageCalls = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [{ name: "build" }],
      models: [{ providerID: "acme", id: "model", name: "Model", variants: ["high"] }],
    }),
    messages: async () => {
      messageCalls += 1
      return []
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: (message) => errors.push(message) })
  await controller.reconcile()
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "session.next.step.started",
    properties: {
      sessionID: "one",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "acme", id: "model" },
      timestamp: 1,
    },
  })
  internal.handleEvent({
    type: "session.next.text.started",
    properties: { sessionID: "one", assistantMessageID: "assistant", textID: "text" },
  })
  internal.handleEvent({
    type: "session.next.text.delta",
    properties: { sessionID: "one", assistantMessageID: "assistant", textID: "text", delta: "Hello" },
  })
  internal.handleEvent({
    type: "session.next.reasoning.started",
    properties: { sessionID: "one", assistantMessageID: "assistant", reasoningID: "reasoning" },
  })
  internal.handleEvent({
    type: "session.next.reasoning.delta",
    properties: { sessionID: "one", assistantMessageID: "assistant", reasoningID: "reasoning", delta: "Think" },
  })
  internal.handleEvent({
    type: "session.next.tool.input.started",
    properties: { sessionID: "one", assistantMessageID: "assistant", callID: "tool", name: "bash" },
  })
  internal.handleEvent({
    type: "session.next.tool.input.delta",
    properties: { sessionID: "one", assistantMessageID: "assistant", callID: "tool", delta: "pwd" },
  })
  internal.handleEvent({
    type: "session.next.tool.input.ended",
    properties: { sessionID: "one", assistantMessageID: "assistant", callID: "tool", text: "pwd -P" },
  })
  internal.handleEvent({ type: "session.next.agent.switched", properties: { sessionID: "one", agent: "build" } })
  internal.handleEvent({
    type: "session.next.model.switched",
    properties: { sessionID: "one", model: { providerID: "acme", id: "model", variant: "high" } },
  })
  internal.handleEvent({ type: "future.event", properties: {} })
  internal.handleEvent({ type: "future.event", properties: {} })
  internal.handleEvent({ type: "project.updated", properties: { id: "project" } })
  await new Promise((resolve) => setTimeout(resolve, 35))
  const state = controller.snapshot.sessions.one
  const parts = state?.messages[0]?.parts ?? []
  if (
    parts.find((part) => part.id === "text")?.text !== "Hello" ||
    parts.find((part) => part.id === "reasoning")?.text !== "Think" ||
    parts.find((part) => part.id === "tool")?.state?.input !== "pwd -P" || state?.agent !== "build" ||
    state.model !== "acme/model" || state.variant !== "high" ||
    errors.some((message) => message.includes("future.event") || message.includes("project.updated")) ||
    messageCalls !== 1
  ) {
    throw new Error("V2 live event projection or forward-compatible event handling failed")
  }
  controller.dispose()
})

Deno.test("catalog and MCP invalidation events refresh data and expose browser fallback", async () => {
  let catalogCalls = 0
  const refreshed = deferred<void>()
  const opened: string[] = []
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => {
      catalogCalls += 1
      return { agents: [], models: [{ providerID: "acme", id: `model-${catalogCalls}`, name: "Model" }] }
    },
    messages: async () => [],
    path: async () => ({}),
    vcs: async () => ({}),
    lsp: async () => [],
    formatter: async () => [],
    mcp: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, {
    error: () => undefined,
    openExternal: (url) => {
      opened.push(url)
    },
  })
  await controller.reconcile()
  controller.subscribe(() => {
    if (controller.chatSnapshot().models[0]?.id === "model-2") refreshed.resolve()
  })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "catalog.updated", properties: {} })
  internal.handleEvent({
    type: "mcp.browser.open.failed",
    properties: { mcpName: "docs", url: "https://example.test/auth" },
  })
  await refreshed.promise
  if (controller.chatSnapshot().models[0]?.id !== "model-2" || opened.join(",") !== "https://example.test/auth") {
    throw new Error(
      `Catalog invalidation or MCP browser fallback was ignored: model=${
        controller.chatSnapshot().models[0]?.id
      }, opened=${opened.join(",")}`,
    )
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
    sendPrompt: async (
      _sessionID: string,
      _id: string,
      _text: string,
      delivery: string,
      _agent?: string,
      _model?: string,
      _variant?: string,
      files?: Array<{ url: string; filename: string }>,
    ) => {
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
  if (
    controller.chatSnapshot().session?.queue?.length || JSON.stringify(controller.chatSnapshot()).includes("base64")
  ) throw new Error("Admitted attachment payload remained in client state")
  controller.dispose()
})

Deno.test("editing a waiting queued prompt preserves its attachments", async () => {
  const firstStarted = deferred<void>()
  const releaseFirst = deferred<void>()
  const secondSent = deferred<{ text: string; files: Array<{ url: string }> }>()
  let calls = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    sendPrompt: async (
      _sessionID: string,
      _id: string,
      text: string,
      _delivery: string,
      _agent?: string,
      _model?: string,
      _variant?: string,
      files?: Array<{ url: string }>,
    ) => {
      calls += 1
      if (calls === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      } else secondSent.resolve({ text, files: files ?? [] })
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const first = controller.send("first")
  await firstStarted.promise
  const file = { type: "file" as const, mime: "image/png", url: "data:image/png;base64,eA==", filename: "image.png" }
  await controller.send("before", undefined, undefined, undefined, [file])
  const queued = controller.chatSnapshot().session?.queue?.find((prompt) => prompt.text === "before")
  if (!queued) throw new Error("Second prompt was not queued")
  controller.editQueued("one", queued.id, "after")
  releaseFirst.resolve()
  await first
  const sent = await secondSent.promise
  if (sent.text !== "after" || sent.files[0]?.url !== file.url) {
    throw new Error("Queued prompt edit lost text or attachment data")
  }
  controller.dispose()
})

Deno.test("file message snapshots retain labels without exposing attachment URLs", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [{
      info: { id: "user", sessionID: "one", role: "user" as const },
      parts: [{
        id: "file",
        sessionID: "one",
        messageID: "user",
        type: "file",
        mime: "image/png",
        filename: "screen.png",
        url: "data:image/png;base64,secret",
      }],
    }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const snapshot = controller.chatSnapshot()
  const part = snapshot.session?.messages[0]?.parts[0]
  if (
    part?.filename !== "screen.png" || part.mime !== "image/png" || "url" in (part ?? {}) ||
    !parseHostMessage({ type: "snapshot", snapshot })
  ) {
    throw new Error("File snapshot label was lost or private URL was exposed")
  }
  controller.dispose()
})

Deno.test("auto approval hides delayed successful responses until removal", async () => {
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
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  controller.setAutoApproval("one", true)
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "permission", sessionID: "one", permission: "bash", patterns: ["ls"], always: ["bash:*"] },
  })

  const snapshot = controller.chatSnapshot()
  if (
    replies.join(",") !== "once" || controller.snapshot.sessions.one?.permissions.length !== 1 ||
    snapshot.session?.permissions?.length !== 0 || snapshot.sessions[0]?.permissionCount !== 0 ||
    snapshot.sessions[0]?.attention !== 0
  ) {
    throw new Error("Auto approval exposed an in-flight permission or lost internal pending state")
  }
  if (attention !== 0) throw new Error("Auto-approved permission emitted an attention notification")
  const removed = deferred<void>()
  controller.subscribe(() => {
    if (controller.snapshot.sessions.one?.permissions.length === 0) removed.resolve(undefined)
  })
  response.resolve(true)
  await removed.promise
  if (controller.chatSnapshot().session?.permissions?.length !== 0) {
    throw new Error("Accepted permission remained pending")
  }
  controller.dispose()
})

Deno.test("reconciled auto approval exposes permission after response failure", async () => {
  const response = deferred<boolean>()
  const request = {
    id: "permission",
    sessionID: "one",
    title: "Shell",
    type: "bash",
    pattern: ["ls"],
    protocol: "current" as const,
  }
  let errors = 0
  const fake = {
    pendingPermissionsDetailed: async () => ({ requests: [request], succeeded: ["current" as const] }),
    respondPermission: () => response.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => errors += 1 })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
    reconcilePermissions(): Promise<void>
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  controller.setAutoApproval("one", true)
  await internal.reconcilePermissions()

  const hidden = controller.chatSnapshot()
  if (
    controller.snapshot.sessions.one?.permissions.length !== 1 || hidden.session?.permissions?.length !== 0 ||
    hidden.sessions[0]?.permissionCount !== 0 || hidden.sessions[0]?.attention !== 0
  ) {
    throw new Error("Reconciled auto approval exposed an in-flight permission")
  }
  const exposed = deferred<void>()
  controller.subscribe(() => {
    if (controller.chatSnapshot().session?.permissions?.[0]?.id === request.id) exposed.resolve(undefined)
  })
  response.reject(new Error("offline"))
  await exposed.promise

  const fallback = controller.chatSnapshot()
  if (
    errors !== 1 || fallback.session?.permissions?.[0]?.id !== request.id ||
    fallback.sessions[0]?.permissionCount !== 1 || fallback.sessions[0]?.attention !== 1
  ) {
    throw new Error("Failed automatic response did not expose manual permission fallback")
  }
  controller.dispose()
})

Deno.test("enabling auto approval hides an existing permission before publishing the mode", async () => {
  const response = deferred<boolean>()
  const replies: string[] = []
  const fake = {
    respondPermission: async (_request: unknown, reply: string) => {
      replies.push(reply)
      return await response.promise
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "permission", sessionID: "one", permission: "bash", patterns: ["ls"], always: [] },
  })
  if (controller.chatSnapshot().session?.permissions?.length !== 1) {
    throw new Error("Manual permission was not initially visible")
  }

  let flashed = false
  controller.subscribe(() => {
    const snapshot = controller.chatSnapshot()
    if (snapshot.autoApproval && snapshot.session?.permissions?.length) flashed = true
  })
  controller.setAutoApproval("one", true)
  if (flashed || replies.join(",") !== "once" || controller.chatSnapshot().session?.permissions?.length !== 0) {
    throw new Error("Enabling Auto published an eligible permission before hiding it")
  }
  response.resolve(true)
  await Promise.resolve()
  await Promise.resolve()
  controller.dispose()
})

Deno.test("permission command scopes are exact or conservative prefixes", async () => {
  if (
    !permissionPatternMatches("deno test", "deno test") || !permissionPatternMatches("anything", "*") ||
    permissionPatternMatches("DENO TEST", "deno test") ||
    !permissionPatternMatches("deno test packages/shared", "deno test *") ||
    permissionPatternMatches("deno task test", "deno test *") ||
    !permissionPatternMatches("git status *", "git *") || !permissionPatternMatches("git status --short", "git *") ||
    permissionPatternMatches("deno test && rm -rf .", "deno test *") ||
    permissionPatternMatches("deno task install:local", "deno task install:*")
  ) {
    throw new Error("Permission command scope matching was unsafe or incorrect")
  }
  const replies: string[] = []
  let attention = 0
  const fake = {
    events: (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      ),
    respondPermission: async (_request: unknown, reply: string) => {
      replies.push(reply)
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined, attention: () => attention += 1 })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "first", sessionID: "one", permission: "bash", patterns: ["deno test"], always: ["deno test *"] },
  })
  await controller.respondPermission("first", "exact", "one", "current")
  controller.reconnect()
  internal.handleEvent({
    type: "permission.asked",
    properties: {
      id: "repeat",
      sessionID: "one",
      permission: "bash",
      patterns: ["deno test"],
      always: ["deno test *"],
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  if (replies.join(",") !== "once,once" || attention !== 1 || controller.chatSnapshot().session?.permissions?.length) {
    throw new Error("Remembered exact scope did not cover the identical repeated command")
  }
  internal.handleEvent({
    type: "permission.asked",
    properties: {
      id: "other",
      sessionID: "one",
      permission: "bash",
      patterns: ["deno test packages/shared"],
      always: ["deno test *"],
    },
  })
  if (
    replies.join(",") !== "once,once" || Number(attention) !== 2 ||
    controller.chatSnapshot().session?.permissions?.[0]?.id !== "other"
  ) {
    throw new Error("Exact grant leaked to a broader command covered by OpenCode's suggested wildcard")
  }
  controller.dispose()
})

Deno.test("selected command scopes allow matching commands only within the conversation", async () => {
  const command = "deno test --sloppy-imports --allow-env packages/vscode-extension/test/session-controller_test.ts"
  const request = {
    id: "first",
    sessionID: "one",
    title: "Shell",
    type: "bash",
    pattern: [command],
    always: ["deno test *"],
    protocol: "current" as const,
  }
  const scopes = reusablePermissionScopes(request)
  if (scopes.join(",") !== "deno test *,deno *,*") {
    throw new Error(`Unexpected reusable command scopes: ${scopes.join(",")}`)
  }
  const complexScopes = reusablePermissionScopes({
    ...request,
    pattern: ['PY="$(command -v python)" && "$PY" - <<\'PY\''],
  })
  if (complexScopes.join(",") !== "*") {
    throw new Error("Complex shell command did not retain the explicit all-shell session option")
  }
  const replies: string[] = []
  const fake = {
    respondPermission: async (_request: unknown, reply: string) => {
      replies.push(reply)
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({
    type: "permission.asked",
    properties: {
      id: request.id,
      sessionID: request.sessionID,
      permission: request.type,
      patterns: request.pattern,
      always: request.always,
    },
  })
  await controller.respondPermission("first", "scope", "one", "current", undefined, "deno test *")
  internal.handleEvent({
    type: "permission.asked",
    properties: {
      id: "covered",
      sessionID: "one",
      permission: "bash",
      patterns: ["deno test packages/shared"],
      always: ["deno test *"],
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  internal.handleEvent({
    type: "permission.asked",
    properties: {
      id: "other",
      sessionID: "one",
      permission: "bash",
      patterns: ["deno task test"],
      always: ["deno task *"],
    },
  })
  if (
    replies.join(",") !== "once,once" ||
    controller.snapshot.sessions.one?.permissions.map((permission) => permission.id).join(",") !== "other"
  ) {
    throw new Error("Selected command scope covered an unrelated command or missed a matching command")
  }
  await controller.respondPermission("other", "scope", "one", "current", undefined, "git *").catch(() => undefined)
  if (replies.join(",") !== "once,once") {
    throw new Error("Controller accepted a scope that was not offered for the request")
  }
  controller.dispose()
})

Deno.test("permission reconciliation applies remembered exact grants", async () => {
  const replies: string[] = []
  const repeat = {
    id: "repeat",
    sessionID: "one",
    title: "Shell",
    type: "bash",
    pattern: ["deno test"],
    always: ["deno test *"],
    protocol: "current" as const,
  }
  const fake = {
    respondPermission: async (_request: unknown, reply: string) => {
      replies.push(reply)
      return true
    },
    pendingPermissionsDetailed: async () => ({ requests: [repeat], succeeded: ["current" as const] }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
    reconcilePermissions(): Promise<void>
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "first", sessionID: "one", permission: "bash", patterns: ["deno test"], always: ["deno test *"] },
  })
  await controller.respondPermission("first", "exact", "one", "current")
  await internal.reconcilePermissions()
  await Promise.resolve()
  await Promise.resolve()
  if (replies.join(",") !== "once,once" || controller.snapshot.sessions.one?.permissions.length) {
    throw new Error("Reconciled exact permission was not automatically allowed once")
  }
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
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  controller.setAutoApproval("one", true)
  internal.handleEvent({
    type: "permission.asked",
    properties: {
      id: "reload",
      sessionID: "one",
      permission: "vscode.reload_opencode",
      patterns: ["skill-activation"],
      always: [],
    },
  })
  await Promise.resolve()
  if (
    replies.length || attention !== 1 ||
    controller.chatSnapshot().session?.permissions?.[0]?.type !== "vscode.reload_opencode"
  ) {
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
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  controller.setAutoApproval("one", true)
  internal.handleEvent({ type: "session.created", properties: { info: session("two", 2) } })
  await controller.select("two")
  if (controller.chatSnapshot().autoApproval !== false) throw new Error("New session inherited Auto approval")
  internal.handleEvent({
    type: "permission.asked",
    properties: { id: "two-permission", sessionID: "two", permission: "bash", patterns: ["pwd"], always: [] },
  })
  await Promise.resolve()
  if (replies.length || attention !== 1) throw new Error("Auto approval leaked into another root session")

  const child = { ...session("child", 3), parentID: "one" }
  internal.handleEvent({ type: "session.created", properties: { info: child } })
  await controller.select("child")
  if (controller.chatSnapshot().autoApproval !== true) {
    throw new Error("Subagent did not inherit its root session approval mode")
  }
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
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
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
    events: (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
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

Deno.test("event connection remains loading until session hydration settles", async () => {
  const sessions = deferred<ReturnType<typeof session>[]>()
  const opened = deferred<void>()
  const connected = deferred<void>()
  const fake = {
    events: async (signal: AbortSignal, onOpen: () => Promise<void> | void) => {
      opened.resolve(undefined)
      await onOpen()
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      )
    },
    listSessions: () => sessions.promise,
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  controller.subscribe((update) => {
    if (update.type === "connected" && update.connected) connected.resolve(undefined)
  })
  controller.start()
  await opened.promise
  await Promise.resolve()
  if (controller.snapshot.connected || controller.snapshot.connectionState !== "connecting") {
    throw new Error("Unsettled session hydration was reported as connected or failed")
  }
  sessions.resolve([])
  await connected.promise
  if (!controller.snapshot.connected || String(controller.snapshot.connectionState) !== "connected") {
    throw new Error("Settled connection was not reported as connected")
  }
  controller.dispose()
})

Deno.test("explicit reconnect discards old-stream terminal events before queue admission", async () => {
  let sends = 0
  const fake = {
    events: (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      }),
    sendPrompt: async () => sends += 1,
    cancelPendingRequests: () => undefined,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const promptID = "msg_018bcfe568001234567890abda"
  const internal = controller as unknown as {
    dispatch(action: { type: string; [key: string]: unknown }): void
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
    eventBus: { emit(event: { type: string; properties: Record<string, unknown> }): void }
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({ type: "session.status", properties: { sessionID: "one", status: { type: "busy" } } })
  internal.dispatch({ type: "queue", sessionID: "one", prompt: { id: promptID, text: "Do not resend", createdAt: 1 } })
  internal.eventBus.emit({ type: "session.status", properties: { sessionID: "one", status: { type: "busy" } } })
  internal.eventBus.emit({ type: "session.idle", properties: { sessionID: "one" } })

  controller.reconnect()
  await Promise.resolve()
  if (
    sends !== 0 || controller.snapshot.sessions.one?.queue[0]?.id !== promptID ||
    controller.snapshot.sessions.one?.status.type !== "busy"
  ) {
    throw new Error("Reconnect applied a stale terminal event and admitted a queued prompt")
  }
  controller.dispose()
})

Deno.test("stale event-loop startup cannot reconnect an aborted stream", async () => {
  const sessions = deferred<SessionInfo[]>()
  const opened = deferred<void>()
  let eventCalls = 0
  const fake = {
    events: async (signal: AbortSignal, onOpen: () => Promise<void> | void) => {
      eventCalls += 1
      if (eventCalls === 1) {
        opened.resolve(undefined)
        await onOpen()
      }
      if (signal.aborted) return
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      )
    },
    listSessions: () => sessions.promise,
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  controller.start()
  await opened.promise
  controller.reconnect()
  sessions.resolve([])
  await Promise.resolve()
  await Promise.resolve()
  if (controller.snapshot.connected) throw new Error("Aborted event-loop startup restored a stale connection")
  controller.dispose()
})

Deno.test("retry rejects active sessions before reverting", async () => {
  let reverted = false
  const user: MessageBundle = {
    info: { id: "user", sessionID: "one", role: "user" },
    parts: [{ id: "text", sessionID: "one", messageID: "user", type: "text", text: "Retry me" }],
  }
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [user],
    revertSession: async () => {
      reverted = true
      return session("one", 2)
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  let rejected = false
  try {
    await controller.retrySession("one")
  } catch {
    rejected = true
  }
  if (!rejected || reverted) throw new Error("Active retry was not rejected before revert")
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
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
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
  const controller = new SessionController({ messages: async () => [] } as unknown as OpenCodeClient, {
    error: () => undefined,
  })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
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
  if (
    snapshot.session?.todos?.[0]?.content !== "Ship it" ||
    snapshot.sessions.find((entry) => entry.id === "one")?.todo?.completed !== 1
  ) {
    throw new Error("Todo event did not remain on its owning session")
  }
  controller.dispose()
})

Deno.test("context uses latest step tokens and cumulative assistant costs", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({
      agents: [],
      models: [{ id: "model", providerID: "acme", name: "Model", contextLimit: 1_000 }],
    }),
    messages: async () => [{
      info: { id: "a1", sessionID: "one", role: "assistant" as const, cost: 1 },
      parts: [],
    }, {
      info: {
        id: "u",
        sessionID: "one",
        role: "user" as const,
        model: { providerID: "acme", modelID: "model", variant: "high" },
      },
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
  if (
    snapshot?.context?.totalTokens !== 481 || snapshot.context.cost !== 3 || snapshot.context.contextLimit !== 1_000
  ) {
    throw new Error("Context summary did not use latest step tokens and cumulative costs")
  }
  if (snapshot.variant !== "high") throw new Error("Reasoning variant was not inferred from real user message shape")
  if (snapshot.goal?.objective !== "Ship safely" || snapshot.todos?.length !== 0) {
    throw new Error("Goal summary was not kept distinct from todos")
  }
  controller.dispose()
})

Deno.test("zero-valued provider usage remains distinguishable from a known zero-percent context", () => {
  const context = deriveContext([{
    info: {
      id: "assistant",
      sessionID: "session",
      role: "assistant",
      providerID: "openai",
      modelID: "model",
      time: { completed: 1 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  }], [{ id: "model", providerID: "openai", name: "Model", contextLimit: 500_000 }])
  if (context?.usageReported !== false || context.usagePercent !== undefined || context.contextLimit !== 500_000) {
    throw new Error("Missing provider usage was presented as a measured zero-percent context")
  }
})

Deno.test("question and diff events expose actionable session state", async () => {
  const answers: string[][][] = []
  const fake = {
    respondQuestion: async (_request: unknown, value: string[][]) => answers.push(value),
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
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
    properties: {
      sessionID: "one",
      diff: [{ file: "src/main.ts", patch: "diff", additions: 2, deletions: 1, status: "modified" }],
    },
  })

  const pending = controller.chatSnapshot()
  if (
    pending.sessions[0]?.attention !== 1 || pending.sessions[0]?.questionCount !== 1 ||
    pending.sessions[0]?.permissionCount !== 0 || pending.sessions[0]?.changeCount !== 1 ||
    pending.session?.changes?.[0]?.file !== "src/main.ts"
  ) {
    throw new Error("Question or changed-file state was not exposed")
  }
  await controller.respondQuestion("que_1", [["Yes"]], "one")
  if (answers[0]?.[0]?.[0] !== "Yes" || controller.chatSnapshot().session?.questions?.length !== 0) {
    throw new Error("Question response was not sent or removed")
  }
  controller.dispose()
})

Deno.test("an in-flight question response survives webview snapshot reload", async () => {
  const response = deferred<void>()
  const fake = { respondQuestion: () => response.promise } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({
    type: "question.v2.asked",
    properties: {
      id: "que_reload",
      sessionID: "one",
      questions: [{ header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Proceed" }] }],
    },
  })

  const first = controller.respondQuestion("que_reload", [["Yes"]], "one")
  if (controller.chatSnapshot().session?.questions?.[0]?.id !== "que_reload") {
    throw new Error("Reload snapshot lost the in-flight question")
  }
  let duplicateRejected = false
  try {
    await controller.respondQuestion("que_reload", [["Yes"]], "one")
  } catch (error) {
    duplicateRejected = String(error).includes("already in progress")
  }
  if (!duplicateRejected) throw new Error("Reloaded surface could duplicate an in-flight question response")
  response.resolve()
  await first
  if (controller.chatSnapshot().session?.questions?.length) {
    throw new Error("Settled question response remained pending")
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
  const fake = {
    abort: async (sessionID: string) => {
      aborted = sessionID
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.created", properties: { info: session("one", 1) } })
  internal.handleEvent({ type: "session.status", properties: { sessionID: "one", status: { type: "busy" } } })

  await controller.abortSelected()
  if (aborted !== "one" || controller.chatSnapshot().session?.status.type !== "idle") {
    throw new Error("Stop acknowledgement did not update local status")
  }
  controller.dispose()
})

Deno.test("workspace refresh refuses to dispose an active session", async () => {
  let disposals = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
    disposeInstance: async () => {
      disposals += 1
      return true
    },
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  let rejected = false
  try {
    await controller.refresh()
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("Stop all active")
  }
  if (!rejected || disposals !== 0) throw new Error("Active workspace refresh reached destructive instance disposal")
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
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({ type: "session.idle", properties: { sessionID: "one" } })
  await controller.send("!git status --short")
  if (calls.join("|") !== "/goal status|!git status --short") {
    throw new Error("Slash command routing or ordinary bang prompt handling failed")
  }
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
  if (
    !running.session?.inFlightPromptID || running.session.queue?.length !== 1 || running.sessions[0]?.queued !== 0 ||
    !parseHostMessage({ type: "snapshot", snapshot: running })
  ) {
    throw new Error("Executing command was not distinguished from pending queue entries")
  }
  const goalUpdate = {
    type: "event" as const,
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "goal",
          messageID: "assistant",
          sessionID: "one",
          type: "tool",
          tool: "get_goal_history",
          state: { status: "completed", output: "{}" },
        },
      },
    },
  }
  if (controller.messageUpdateKey(goalUpdate) !== undefined) {
    throw new Error("Completed goal update was reduced to a transcript-only patch")
  }

  command.resolve({})
  await sending
  if (controller.chatSnapshot().session?.inFlightPromptID || controller.chatSnapshot().session?.queue?.length) {
    throw new Error("Completed command remained in running state")
  }
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
  const internal = controller as unknown as {
    handleEvent(event: { type: string; properties: Record<string, unknown> }): void
  }
  internal.handleEvent({
    type: "message.updated",
    properties: { info: { id: "assistant", sessionID: "one", role: "assistant" } },
  })
  internal.handleEvent({
    type: "message.part.updated",
    properties: { part: { id: "text", messageID: "assistant", sessionID: "one", type: "text", text: "streamed" } },
  })

  if (!update) throw new Error("Streaming update was not published")
  const key = controller.messageUpdateKey(update)
  const patch = key ? controller.messagePatches([key])?.[0] : undefined
  if (patch?.message?.parts[0]?.text !== "streamed" || patch.revision < 1 || !patch.active) {
    throw new Error("Targeted streaming patch omitted current message state")
  }
  controller.dispose()
})

Deno.test("ordered event ingress applies a large delta burst without loss", async () => {
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({ one: { type: "busy" as const } }),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => [],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, {
    error: (error) => {
      throw new Error(error)
    },
  })
  await controller.reconcile()
  const internal = controller as unknown as {
    eventBus: { emit(event: { type: string; properties: Record<string, unknown> }): void; flush(): void }
  }
  internal.eventBus.emit({
    type: "message.updated",
    properties: { info: { id: "assistant", sessionID: "one", role: "assistant" } },
  })
  internal.eventBus.emit({
    type: "message.part.updated",
    properties: { part: { id: "text", messageID: "assistant", sessionID: "one", type: "text", text: "" } },
  })
  for (let index = 0; index < 20_000; index += 1) {
    internal.eventBus.emit({
      type: "message.part.delta",
      properties: { sessionID: "one", messageID: "assistant", partID: "text", field: "text", delta: "x" },
    })
  }
  internal.eventBus.flush()

  const text = controller.snapshot.sessions.one?.messages[0]?.parts[0]?.text
  if (text?.length !== 20_000) throw new Error(`Event ingress dropped deltas: received ${text?.length ?? 0}`)
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
  if (controller.snapshot.sessions.one?.permissions.length !== 3) {
    throw new Error("Same-ID permission protocols were deduplicated")
  }

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
  if (afterV2Reject.length !== 1 || afterV2Reject[0]?.protocol !== "current") {
    throw new Error("V2 reject affected another permission system")
  }
  await controller.respondPermission("other", "reject", "one", "current")
  if (Number(controller.snapshot.sessions.one?.permissions.length) !== 0) {
    throw new Error("Reject retained sibling requests from the same permission system")
  }
  controller.dispose()
})

Deno.test("session hydration remains loading until transcript completion and exposes failure", async () => {
  const transcript = deferred<MessageBundle[]>()
  const refresh = deferred<MessageBundle[]>()
  let messageCalls = 0
  const fake = {
    listSessions: async () => [session("one", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: () => ++messageCalls === 1 ? transcript.promise : refresh.promise,
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  const reconciling = controller.reconcile()
  for (let attempt = 0; attempt < 20 && controller.chatSnapshot().session?.loadState !== "loading"; attempt += 1) {
    await Promise.resolve()
  }
  if (
    controller.chatSnapshot().session?.loadState !== "loading" || controller.chatSnapshot().session?.loaded !== false
  ) throw new Error("Transcript hydration did not remain visible")
  transcript.resolve([])
  await reconciling
  if (controller.chatSnapshot().session?.loadState !== "ready" || controller.chatSnapshot().session?.loaded !== true) {
    throw new Error("Transcript hydration did not complete")
  }
  const internal = controller as unknown as { loadTranscript(sessionID: string): Promise<void> }
  const refreshing = internal.loadTranscript("one")
  await Promise.resolve()
  if (
    controller.chatSnapshot().session?.loadState !== "loading" || controller.chatSnapshot().session?.loaded !== true
  ) {
    throw new Error("Background transcript refresh was mistaken for initial hydration")
  }
  refresh.resolve([])
  await refreshing
  controller.dispose()

  const failed = {
    listSessions: async () => [session("failed", 1)],
    sessionStatuses: async () => ({}),
    catalogs: async () => ({ agents: [], models: [] }),
    messages: async () => {
      throw new Error("unavailable")
    },
  } as unknown as OpenCodeClient
  const failedController = new SessionController(failed, { error: () => undefined })
  await failedController.reconcile()
  if (failedController.chatSnapshot().session?.loadState !== "error") {
    throw new Error("Transcript hydration failure was hidden")
  }
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
        {
          id: "actual",
          providerID: "acme",
          name: "Actual",
          contextLimit: 8_000,
          inputLimit: 7_000,
          outputLimit: 1_000,
        },
      ],
      defaults: { agent: "build", model: "acme/default" },
    }),
    messages: async () => [{
      info: {
        id: "assistant",
        sessionID: "one",
        role: "assistant" as const,
        providerID: "acme",
        modelID: "actual",
        time: { completed: 1 },
        tokens: { input: 400, output: 100 },
      },
      parts: [],
    }],
  } as unknown as OpenCodeClient
  const controller = new SessionController(fake, { error: () => undefined })
  await controller.reconcile()
  const context = controller.chatSnapshot().session?.context
  if (
    context?.model !== "acme/actual" || context.contextLimit !== 8_000 || context.inputLimit !== 7_000 ||
    context.outputLimit !== 1_000
  ) {
    throw new Error("Context used composer model instead of actual response model")
  }
  if (
    controller.mentionedAgents("Ask @research to inspect this").join(",") !== "research" ||
    controller.mentionedAgents("Ask @unknown").length
  ) {
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
  const pending = controller.send("payload", undefined, undefined, undefined, [{
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,eA==",
    filename: "image.png",
  }])
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
