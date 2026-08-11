import { PERMISSION_AGGREGATE_CHARACTER_LIMIT, parseHostMessage } from "@opencode-workbench/shared"
import { GOAL_CONTINUATION_PROMPT } from "../../opencode-plugin/src/goal-prompts.ts"
import { OpenCodeClient, parseChanges, parseCommands, parseOpenCodePty, parsePermission, parsePermissions, parseQuestion, parseQuestions, parseTodos, validateServerUrl } from "../src/opencode-client.ts"

function throws(operation: () => void, pattern: RegExp): void {
  try {
    operation()
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return
    throw error
  }
  throw new Error("Expected operation to throw")
}

async function rejects(operation: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return
    throw error
  }
  throw new Error("Expected operation to reject")
}

Deno.test("server URL accepts loopback HTTP and remote HTTPS", () => {
  validateServerUrl("http://127.0.0.1:4096")
  validateServerUrl("http://[::1]:4096")
  validateServerUrl("https://opencode.example.test")
})

Deno.test("server URL rejects credential leaks and remote cleartext", () => {
  throws(() => validateServerUrl("http://192.168.1.20:4096"), /numeric loopback/)
  throws(() => validateServerUrl("http://localhost:4096"), /numeric loopback/)
  throws(() => validateServerUrl("https://user:secret@example.test"), /must not contain credentials/)
})

Deno.test("native session metadata and archive/share operations stay OpenCode-authoritative", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ method: string; url: URL; body?: unknown }> = []
  const session = (overrides: Record<string, unknown> = {}) => ({
    id: "ses-native",
    title: "Native session",
    directory: "/work",
    time: { created: 1, updated: 2, archived: 3 },
    parentID: "ses-parent",
    agent: "build",
    model: { providerID: "provider", id: "model", variant: "high" },
    cost: 1.25,
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
    summary: { additions: 4, deletions: 2, files: 1 },
    share: { url: "https://share.example.test/ses-native" },
    revert: { messageID: "msg-one", partID: "part-one" },
    ...overrides,
  })
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const encoded = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ method: init?.method ?? "GET", url, body: encoded })
    if (url.pathname === "/session" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify([
        session(),
        session({ id: "ses-private", share: { url: "https://user:secret@share.example.test/leak" } }),
      ]))
    }
    if (url.pathname === "/session/ses-native" && init?.method === "PATCH") return new Response(JSON.stringify(session()))
    if (url.pathname === "/session/ses-native/share" && init?.method === "POST") return new Response(JSON.stringify(session()))
    if (url.pathname === "/session/ses-native/share" && init?.method === "DELETE") return new Response(JSON.stringify(session({ share: undefined })))
    return new Response("{}", { status: 404 })
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const sessions = await client.listSessions()
    const native = sessions[0]
    if (!native || native.parentID !== "ses-parent" || native.time.archived !== 3 || native.share?.url !== "https://share.example.test/ses-native" ||
      native.summary?.files !== 1 || native.revert?.partID !== "part-one" || native.model?.variant !== "high" || native.tokens?.cache.read !== 7) {
      throw new Error("OpenCode native session metadata was not preserved")
    }
    if (sessions[1]?.share !== undefined) throw new Error("Credential-bearing OpenCode share URL was exposed")
    const list = requests.find((request) => request.method === "GET" && request.url.pathname === "/session")
    if (!list || list.url.searchParams.get("limit") !== "10000" || list.url.searchParams.has("roots")) {
      throw new Error(`Default OpenCode session hydration did not request every root and descendant: ${list?.url}`)
    }
    await client.archiveSession("ses-native", 123)
    if ((await client.shareSession("ses-native")).share?.url !== "https://share.example.test/ses-native") throw new Error("Native OpenCode share response was not preserved")
    if ((await client.unshareSession("ses-native")).share !== undefined) throw new Error("Native OpenCode unshare response was not preserved")
    const archive = requests.find((request) => request.method === "PATCH")
    if (archive?.url.pathname !== "/session/ses-native" || JSON.stringify(archive.body) !== JSON.stringify({ time: { archived: 123 } })) {
      throw new Error(`Archive did not use the native OpenCode PATCH contract: ${JSON.stringify(archive)}`)
    }
    if (requests.filter((request) => request.url.pathname === "/session/ses-native/share").map((request) => request.method).join(",") !== "POST,DELETE") {
      throw new Error("Share and unshare did not use the native OpenCode endpoints")
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("bounded experimental session search uses OpenCode and falls back compatibly", async () => {
  const originalFetch = globalThis.fetch
  const requests: URL[] = []
  let experimentalStatus = 200
  const session = (id: string, title: string, parentID?: string, archived?: number) => ({ id, title, parentID, directory: "/work", time: { created: 1, updated: 2, archived } })
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(url)
    if (url.pathname === "/experimental/session") {
      if (experimentalStatus !== 200) return new Response("missing", { status: experimentalStatus })
      return new Response(JSON.stringify([session("ses-result", "Search result", url.searchParams.has("roots") ? undefined : "ses-parent")]))
    }
    if (url.pathname === "/session") return new Response(JSON.stringify([
      session("ses-root", "Matching root"),
      session("ses-child", "Matching child", "ses-root"),
      session("ses-archived", "Matching archived", undefined, 3),
    ]))
    return new Response("{}", { status: 404 })
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const native = await client.listSessions({ search: "result", roots: true, archived: false, start: 10, cursor: 20, limit: 25 })
    if (native[0]?.id !== "ses-result") throw new Error("Experimental OpenCode session result was not parsed")
    const query = requests[0]!
    if (query.searchParams.get("search") !== "result" || query.searchParams.get("roots") !== "true" || query.searchParams.get("archived") !== "false" ||
      query.searchParams.get("start") !== "10" || query.searchParams.get("cursor") !== "20" || query.searchParams.get("limit") !== "25") throw new Error(`Experimental session query was malformed: ${query}`)

    const descendants = await client.listSessions({ limit: 25 })
    if (descendants[0]?.parentID !== "ses-parent" || requests[1]?.searchParams.has("roots")) {
      throw new Error("Default experimental session hydration omitted or flattened an OpenCode descendant")
    }

    experimentalStatus = 404
    const fallback = await client.listSessions({ search: "matching", roots: true, archived: false, limit: 10 })
    if (fallback.map((entry) => entry.id).join(",") !== "ses-root") throw new Error("Legacy session fallback did not preserve bounded root/archive/search filters")
    const unfilteredFallback = await client.listSessions({ roots: false, archived: true, limit: 10 })
    if (unfilteredFallback.map((entry) => entry.id).join(",") !== "ses-root,ses-child,ses-archived") {
      throw new Error("Legacy session fallback did not preserve OpenCode's inclusive roots/archive flags")
    }
    const defaultFallback = await client.listSessions({ limit: 10 })
    if (defaultFallback.map((entry) => entry.id).join(",") !== "ses-root,ses-child") {
      throw new Error("Legacy session fallback did not preserve OpenCode's default archived-session exclusion")
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("experimental session search enforces the SDK response and paging boundaries", async () => {
  const originalFetch = globalThis.fetch
  const requests: URL[] = []
  let response: "envelope" | 400 | 404 = "envelope"
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(url)
    if (url.pathname === "/experimental/session") {
      if (response === "envelope") return Promise.resolve(new Response(JSON.stringify({ data: [] })))
      return Promise.resolve(new Response("unavailable", { status: response }))
    }
    if (url.pathname === "/session") return Promise.resolve(new Response("[]"))
    return Promise.resolve(new Response("missing", { status: 404 }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    await rejects(() => client.listSessions({ search: "strict" }), /malformed experimental session list/)

    response = 400
    await rejects(() => client.listSessions({ search: "bad request" }), /failed \(400\)/)
    if (requests.some((request) => request.pathname === "/session")) throw new Error("A supported endpoint's bad request incorrectly used the legacy fallback")

    response = 404
    await rejects(() => client.listSessions({ cursor: 20 }), /does not support paged session search/)
    if (requests.some((request) => request.pathname === "/session")) throw new Error("Paged search incorrectly used the unpaged legacy fallback")

    const requestCount = requests.length
    await rejects(() => client.listSessions({ start: -1 }), /session start is invalid/)
    await rejects(() => client.listSessions({ cursor: -1 }), /session cursor is invalid/)
    await rejects(() => client.listSessions({ limit: 5_001 }), /session limit/)
    if (requests.length !== requestCount) throw new Error("Invalid experimental session options reached OpenCode")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("native PTY parsing is strict, bounded, and clone-safe", () => {
  const source = { id: "pty-one", title: "Tests", command: "deno", args: ["test"], cwd: "/work", status: "running", pid: 42 }
  const pty = parseOpenCodePty(source)
  if (!pty || pty.id !== "pty-one" || pty.args[0] !== "test" || pty.exitCode !== undefined) throw new Error("Valid OpenCode PTY metadata was rejected")
  source.args[0] = "mutated"
  if (pty.args[0] !== "test") throw new Error("OpenCode PTY arguments were not cloned")
  for (const malformed of [
    { ...source, id: "bad\npty" },
    { ...source, status: "unknown" },
    { ...source, pid: 1.5 },
    { ...source, args: [1] },
    { ...source, args: Array.from({ length: 257 }, () => "x") },
    { ...source, exitCode: Number.NaN },
  ]) {
    if (parseOpenCodePty(malformed)) throw new Error(`Malformed OpenCode PTY metadata was accepted: ${JSON.stringify(malformed).slice(0, 200)}`)
  }
})

Deno.test("native PTY and background-child methods use strict OpenCode endpoints", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ method: string; url: URL }> = []
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push({ method: init?.method ?? "GET", url })
    if (url.pathname === "/pty") return Promise.resolve(new Response(JSON.stringify([
      { id: "pty-one", title: "Tests", command: "deno", args: ["test"], cwd: "/work", status: "running", pid: 42 },
      { id: "pty-two", title: "Build", command: "deno", args: ["task", "build"], cwd: "/work", status: "exited", pid: 43, exitCode: 0 },
    ])))
    if (url.pathname === "/pty/pty-one") return Promise.resolve(new Response("true"))
    if (url.pathname === "/experimental/session/ses-parent/background") return Promise.resolve(new Response("true"))
    return Promise.resolve(new Response("false", { status: 404 }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const ptys = await client.listPtys()
    if (ptys.length !== 2 || ptys[1]?.exitCode !== 0 || !await client.deletePty("pty-one") || !await client.backgroundChildSessions("ses-parent")) {
      throw new Error("OpenCode PTY/background responses were not preserved")
    }
    if (requests.map((request) => `${request.method} ${request.url.pathname}`).join(",") !== "GET /pty,DELETE /pty/pty-one,POST /experimental/session/ses-parent/background" ||
      requests.some((request) => request.url.searchParams.get("directory") !== "/work")) {
      throw new Error(`OpenCode PTY/background endpoints were incorrect: ${requests.map((request) => `${request.method} ${request.url}`).join(",")}`)
    }
    globalThis.fetch = () => Promise.resolve(new Response("{}"))
    let malformedDeleteRejected = false
    let unsafeSessionRejected = false
    try {
      await client.deletePty("pty-two")
    } catch (error) {
      malformedDeleteRejected = /deletion data/.test(error instanceof Error ? error.message : String(error))
    }
    try {
      await client.backgroundChildSessions("bad\nsession")
    } catch (error) {
      unsafeSessionRejected = /session ID/.test(error instanceof Error ? error.message : String(error))
    }
    if (!malformedDeleteRejected || !unsafeSessionRejected) throw new Error("Malformed PTY deletion or unsafe background-session input was accepted")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("native PTY lists reject malformed, duplicate, and oversized server state", async () => {
  const originalFetch = globalThis.fetch
  const responses: unknown[] = [
    [{ id: "duplicate", title: "One", command: "sh", args: [], cwd: "/work", status: "running", pid: 1 }, { id: "duplicate", title: "Two", command: "sh", args: [], cwd: "/work", status: "running", pid: 2 }],
    [{ id: "invalid", title: "Invalid", command: "sh", args: [1], cwd: "/work", status: "running", pid: 1 }],
    Array.from({ length: 501 }, (_, index) => ({ id: `pty-${index}`, title: "PTY", command: "sh", args: [], cwd: "/work", status: "running", pid: index })),
  ]
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify(responses.shift())))
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let rejected = false
      try {
        await client.listPtys()
      } catch (error) {
        rejected = /PTY/.test(error instanceof Error ? error.message : String(error))
      }
      if (!rejected) throw new Error(`Malformed PTY list ${attempt} was accepted`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("event stream treats instance disposal as a clean end and bounds unfinished frames", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = () => Promise.resolve(new Response('data: {"id":"event-1","type":"server.instance.disposed","properties":{}}\n\n', { status: 200 }))
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const events: Array<{ id?: string; type: string }> = []
    await client.events(new AbortController().signal, () => undefined, (event) => events.push(event))
    if (events[0]?.id !== "event-1" || events[0]?.type !== "server.instance.disposed") throw new Error("Instance disposal did not preserve its ID or end the event stream cleanly")

    globalThis.fetch = () => Promise.resolve(new Response(`data: ${"x".repeat(8 * 1024 * 1024 + 1)}`, { status: 200 }))
    let bounded = false
    try {
      await client.events(new AbortController().signal, () => undefined, () => undefined)
    } catch (error) {
      bounded = error instanceof Error && error.message === "OpenCode event stream frame exceeds 8 MiB"
    }
    if (!bounded) throw new Error("Oversized unfinished SSE frame was not rejected")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("event stream preserves a large ordered burst without dropping frames", async () => {
  const originalFetch = globalThis.fetch
  const count = 20_000
  const frames = Array.from({ length: count }, (_, index) =>
    `data: ${JSON.stringify({ id: `event-${index}`, type: "message.part.delta", properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: String(index) } })}\n\n`
  ).join("") + `data: {"id":"disposed","type":"server.instance.disposed","properties":{}}\n\n`
  globalThis.fetch = () => Promise.resolve(new Response(frames, { status: 200 }))
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const received: string[] = []
    await client.events(new AbortController().signal, () => undefined, (event) => received.push(event.id ?? ""))
    if (received.length !== count + 1) throw new Error(`Event stream dropped frames: received ${received.length}`)
    for (let index = 0; index < count; index += 1) {
      if (received[index] !== `event-${index}`) throw new Error(`Event stream reordered frame ${index}: ${received[index]}`)
    }
    if (received.at(-1) !== "disposed") throw new Error("Event stream omitted the terminal disposal event")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("current permission events expose permission and patterns", () => {
  const permission = parsePermission({
    type: "permission.asked",
    properties: {
      id: "request",
      sessionID: "session",
      permission: "bash",
      patterns: ["rm protected"],
      always: ["bash:*"],
      metadata: { command: "rm protected" },
    },
  })
  if (permission?.type !== "bash" || permission.pattern?.[0] !== "rm protected" || permission.protocol !== "current") {
    throw new Error("Current permission event fields were not preserved")
  }
  const v2 = parsePermission({
    type: "permission.v2.asked",
    properties: {
      id: "request-v2",
      sessionID: "session",
      action: "read",
      resources: [".env"],
      save: ["*.env"],
      metadata: {},
    },
  })
  if (v2?.protocol !== "v2" || v2.always?.[0] !== "*.env") throw new Error("V2 permission scope was not preserved")
  if (parsePermission({ type: "permission.asked", properties: { id: "request", sessionID: "session" } })) {
    throw new Error("Incomplete permission event was accepted")
  }
  const oversized = parsePermission({
    type: "permission.asked",
    properties: { id: "request", sessionID: "session", permission: "read", patterns: ["x".repeat(20_001)], always: [] },
  })
  if (!oversized?.truncated || (oversized.pattern?.[0]?.length ?? 0) !== 20_000) throw new Error("Oversized permission scope was not safely truncated")
  const oversizedAggregate = parsePermission({
    type: "permission.asked",
    properties: {
      id: "request",
      sessionID: "session",
      permission: "read",
      patterns: Array.from({ length: 50 }, () => "x".repeat(20_000)),
      always: [],
    },
  })
  if (!oversizedAggregate?.truncated || JSON.stringify(oversizedAggregate).length > PERMISSION_AGGREGATE_CHARACTER_LIMIT) {
    throw new Error(`Permission aggregate above ${PERMISSION_AGGREGATE_CHARACTER_LIMIT} characters was not safely bounded`)
  }
})

Deno.test("truncated permission metadata remains protocol-valid and reject-only identifiable", () => {
  const permission = parsePermission({
    type: "permission.asked",
    properties: {
      id: "request",
      sessionID: "session",
      permission: "bash",
      patterns: ["command"],
      always: [],
      metadata: { command: "x".repeat(100_001) },
    },
  })
  if (!permission?.truncated) throw new Error("Truncated permission metadata was not marked")
  const parsed = parseHostMessage({
    type: "snapshot",
    snapshot: {
      connected: true,
      connectionState: "connected",
      sessions: [{ id: "session", title: "Session", status: { type: "idle" }, unread: 0 }],
      agents: [],
      models: [],
      session: {
        id: "session",
        title: "Session",
        draft: "",
        status: { type: "idle" },
        loaded: true,
        loadState: "ready",
        messages: [],
        messageRevisions: {},
        permissions: [permission],
      },
    },
  })
  if (!parsed) throw new Error("Client-bounded permission was rejected by the shared snapshot parser")
  if (parsePermission({
    type: "permission.asked",
    properties: { id: "request", sessionID: "session", permission: "bash", patterns: [], always: [], metadata: "hidden" },
  })) throw new Error("Malformed permission metadata was silently omitted")
})

Deno.test("todo parsing bounds and filters server values", () => {
  const todos = parseTodos([
    { content: "Do work", status: "pending", priority: "high" },
    { content: "x".repeat(20_001), status: "pending" },
    { id: 3, content: "invalid", status: "pending" },
  ])
  if (todos.length !== 1 || todos[0]?.content !== "Do work" || todos[0]?.id !== undefined) throw new Error("Todo parser rejected current server values or accepted invalid data")
})

Deno.test("command parsing exposes bounded native autocomplete entries", () => {
  const commands = parseCommands([{ name: "review", description: "Review workspace", source: "command", hints: ["scope"] }, { name: "x".repeat(1_025) }])
  if (commands.length !== 1 || commands[0]?.name !== "review" || commands[0]?.hints?.[0] !== "scope") throw new Error("Native command parser accepted invalid data or lost hints")
})

Deno.test("change and question parsers bound native server data", () => {
  const changes = parseChanges([{ file: "src/main.ts", patch: "diff", additions: 2, deletions: 1, status: "modified" }, { file: "bad", additions: -1, deletions: 0 }])
  if (changes.length !== 1 || changes[0]?.file !== "src/main.ts") throw new Error("Change parser accepted invalid data")
  const payload = { data: [{ id: "que_1", sessionID: "session", questions: [{ header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Proceed" }] }] }] }
  if (parseQuestions(payload, "v2")[0]?.questions[0]?.options[0]?.label !== "Yes") throw new Error("Question list was not parsed")
  if (parseQuestion({ type: "question.v2.asked", properties: payload.data[0] })?.protocol !== "v2") throw new Error("Question event was not parsed")
  const permissions = parsePermissions({ data: [{ id: "per_1", sessionID: "session", action: "read", resources: [".env"] }] }, "v2")
  if (permissions[0]?.protocol !== "v2" || permissions[0]?.pattern?.[0] !== ".env") throw new Error("V2 permission list was not parsed")
})

Deno.test("v2 request lists use location queries and native request schemas", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: URL; body?: unknown }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
    if (url.pathname === "/api/question/request") {
      return new Response(JSON.stringify({ location: {}, data: [{ id: "que_1", sessionID: "session", questions: [{ header: "Choice", question: "Continue?", options: [] }] }] }))
    }
    if (url.pathname === "/api/permission/request") {
      return new Response(JSON.stringify({ location: {}, data: [{ id: "per_1", sessionID: "session", action: "read", resources: [".env"] }] }))
    }
    if (url.pathname === "/question" || url.pathname === "/permission") return new Response("[]")
    if (url.pathname.endsWith("/permission/per_1/reply")) return new Response(null, { status: 204 })
    if (url.pathname.includes("/mcp/")) return new Response("true")
    return new Response(JSON.stringify({ info: {}, parts: [] }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const questions = await client.pendingQuestions()
    const permissions = await client.pendingPermissions()
    await client.sendCommand("session", "goal", "status", "build", "acme/model", "high", [{ type: "file", mime: "text/plain", url: "file:///work/plan.md", filename: "plan.md" }], "msg_command")
    await client.respondPermission(permissions[0]!, "once")
    await client.respondPermission(permissions[0]!, "reject", "Use a read-only path")
    await client.mcpAction("docs", "connect")

    const questionRequest = requests.find((request) => request.url.pathname === "/api/question/request")
    const permissionRequest = requests.find((request) => request.url.pathname === "/api/permission/request")
    const commandRequest = requests.find((request) => request.url.pathname.endsWith("/command"))
    if (questionRequest?.url.searchParams.get("location[directory]") !== "/work" || permissionRequest?.url.searchParams.get("location[directory]") !== "/work") {
      throw new Error("V2 request list omitted its location directory")
    }
    if (questions[0]?.protocol !== "v2" || permissions[0]?.protocol !== "v2") throw new Error("V2 requests were not preferred")
    const commandBody = commandRequest?.body as { model?: unknown; variant?: unknown; messageID?: unknown; parts?: unknown[] }
    if (commandBody?.model !== "acme/model" || commandBody.variant !== "high" || commandBody.messageID !== "msg_command" || commandBody.parts?.length !== 1) throw new Error("Command model, variant, ID, or file parts were omitted")
    const replies = requests.filter((request) => request.url.pathname.endsWith("/permission/per_1/reply"))
    if ((replies[1]?.body as { message?: string })?.message !== "Use a read-only path") throw new Error("Permission rejection feedback was omitted")
    if (!requests.some((request) => request.url.pathname === "/mcp/docs/connect")) throw new Error("MCP action used the wrong endpoint")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("v2 prompt admission preserves IDs, delivery, preferences, and file parts", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ path: string; body: unknown }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ path: url.pathname, body })
    return url.pathname.endsWith("/prompt")
      ? new Response(JSON.stringify({ data: {
        admittedSeq: 42,
        id: "msg_018bcfe568001234567890abcd",
        sessionID: "session",
        prompt: { text: "Review these", files: [] },
        delivery: "queue",
        timeCreated: 1_700_000_000_000,
      } }))
      : new Response(null, { status: 204 })
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const admission = await client.sendPrompt("session", "msg_018bcfe568001234567890abcd", "Review these", "queue", "build", "acme/model", "high", [
      { type: "file", mime: "text/plain", url: "file:///work/src/main.ts?start=4&end=8", filename: "main.ts" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,eA==", filename: "image.png" },
    ])
    const prompt = requests.find((request) => request.path.endsWith("/prompt"))?.body as { id?: string; delivery?: string; prompt?: { files?: Array<Record<string, unknown>> } }
    const model = requests.find((request) => request.path.endsWith("/model"))?.body as { model?: Record<string, unknown> }
    if (requests.map((request) => request.path).join(",") !== "/api/session/session/agent,/api/session/session/model,/api/session/session/prompt" ||
      prompt.id !== "msg_018bcfe568001234567890abcd" || prompt.delivery !== "queue" || prompt.prompt?.files?.[0]?.uri !== "file:///work/src/main.ts?start=4&end=8" ||
      prompt.prompt?.files?.[1]?.uri !== "data:image/png;base64,eA==" || model.model?.variant !== "high") {
      throw new Error("V2 prompt admission omitted durable or structured fields")
    }
    if (admission.admittedSeq !== 42 || admission.id !== prompt.id || admission.delivery !== "queue" || admission.timeCreated !== 1_700_000_000_000) {
      throw new Error(`V2 prompt admission receipt was not validated: ${JSON.stringify(admission)}`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("v2 prompt admission rejects malformed and mismatched receipts", async () => {
  const originalFetch = globalThis.fetch
  let response: unknown = { data: {} }
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    return Promise.resolve(url.pathname.endsWith("/prompt") ? new Response(JSON.stringify(response)) : new Response(null, { status: 204 }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const send = () => client.sendPrompt("session", "msg_018bcfe568001234567890abcd", "hello", "steer")
    await rejects(send, /malformed or mismatched prompt admission receipt/)
    response = { data: { admittedSeq: 1, id: "msg_018bcfe568001234567890abcd", sessionID: "other", delivery: "steer", timeCreated: 2 } }
    await rejects(send, /malformed or mismatched prompt admission receipt/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("native manual compaction validates its durable receipt", async () => {
  const originalFetch = globalThis.fetch
  let body: unknown
  globalThis.fetch = (_input, init) => {
    body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    return Promise.resolve(new Response(JSON.stringify({ data: {
      admittedSeq: 7,
      id: "msg_018bcfe568001234567890abcd",
      sessionID: "session",
      timeCreated: 123,
      type: "compaction",
    } })))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const admission = await client.compactSessionV2("session", "msg_018bcfe568001234567890abcd")
    if (JSON.stringify(body) !== JSON.stringify({ id: "msg_018bcfe568001234567890abcd" }) || admission.type !== "compaction" || admission.admittedSeq !== 7) {
      throw new Error(`Native compaction did not preserve its exact admission contract: ${JSON.stringify({ body, admission })}`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("legacy async prompts preserve custom provider model and variant", async () => {
  const originalFetch = globalThis.fetch
  let request: { path: string; body: unknown } | undefined
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    request = { path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }
    return Promise.resolve(new Response(null, { status: 204 }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    await client.sendAsync("session", "hello", "caveboss", "openai/gpt-5.6-sol", "high", [], "msg_018bcfe568001234567890abcd")
    const body = request?.body as { agent?: string; model?: { providerID?: string; modelID?: string }; variant?: string; messageID?: string }
    if (request?.path !== "/session/session/prompt_async" || body.agent !== "caveboss" || body.model?.providerID !== "openai" ||
      body.model.modelID !== "gpt-5.6-sol" || body.variant !== "high" || body.messageID !== "msg_018bcfe568001234567890abcd") {
      throw new Error("Legacy async prompt omitted its stable ID or custom provider selection")
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("structured verifier prompts declare their legacy transport with a stable OpenCode ID", async () => {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> | undefined
  globalThis.fetch = (_input, init) => {
    body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    return Promise.resolve(new Response(null, { status: 204 }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const messageID = await client.sendStructuredPrompt("verifier", "verify", { schema: { type: "object" }, retryCount: 2 })
    if (!/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(messageID) || body?.messageID !== messageID ||
      (body?.format as { type?: string } | undefined)?.type !== "json_schema" || (body?.tools as Record<string, unknown> | undefined)?.["*"] !== false) {
      throw new Error(`Structured prompt lost its explicit OpenCode legacy contract: ${JSON.stringify({ messageID, body })}`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("session status and interruption cover both v2 and legacy runners", async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    paths.push(url.pathname)
    if (url.pathname === "/session/status") return Promise.resolve(new Response(JSON.stringify({ legacy: { type: "retry", attempt: 2 } })))
    if (url.pathname === "/api/session/active") return Promise.resolve(new Response(JSON.stringify({ data: { current: { type: "running" } } })))
    if (url.pathname.endsWith("/interrupt")) return Promise.resolve(new Response(null, { status: 204 }))
    if (url.pathname.endsWith("/abort")) return Promise.resolve(new Response("false"))
    return Promise.resolve(new Response("{}"))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const statuses = await client.sessionStatuses()
    if (statuses.legacy?.type !== "retry" || statuses.current?.type !== "busy") throw new Error("V2 and legacy statuses were not combined")
    if (!await client.abort("current") || !paths.includes("/api/session/current/interrupt") || !paths.includes("/session/current/abort")) {
      throw new Error("Stop did not cover both runner protocols")
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("v2 projected messages expose durable prompts and assistant output", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname.startsWith("/api/session/")) return Promise.resolve(new Response(JSON.stringify({
      data: [
        { id: "msg_user", type: "user", time: { created: 1 }, text: "hello", files: [{ uri: "file:///work/a.txt", mime: "text/plain", name: "a.txt" }] },
        {
          id: "msg_assistant",
          type: "assistant",
          time: { created: 2, completed: 3 },
          agent: "build",
          model: { providerID: "acme", id: "model" },
          content: [
            { id: "reasoning", type: "reasoning", text: "Detailed provider thinking" },
            { id: "text", type: "text", text: "hi" },
            { id: "tool", type: "tool", name: "bash", time: { created: 2, completed: 3 }, state: { status: "completed", input: { command: "pwd" }, content: [{ type: "text", text: "/work" }], structured: {} } },
          ],
          finish: "stop",
          cost: 0.01,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        { id: "msg_compaction", type: "compaction", time: { created: 4, completed: 5 }, summary: "internal summary" },
        { id: "msg_system", type: "system", time: { created: 6 }, text: "internal context" },
        { id: "msg_synthetic", type: "synthetic", time: { created: 7 }, sessionID: "session", text: "internal lifecycle input" },
      ],
      cursor: {},
    })))
    return Promise.resolve(new Response(JSON.stringify([
      { info: { id: "msg_old", sessionID: "session", role: "user", time: { created: 0 } }, parts: [] },
      { info: { id: "msg_assistant", sessionID: "session", role: "assistant", time: { created: 2 } }, parts: [
        { id: "legacy-patch", sessionID: "session", messageID: "msg_assistant", type: "patch", text: "diff" },
        { id: "tool", sessionID: "session", messageID: "msg_assistant", type: "tool", tool: "bash", state: { status: "completed", metadata: { delegation: "kept" } } },
      ] },
    ])))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const messages = await client.messages("session")
    const user = messages.find((message) => message.info.id === "msg_user")
    const assistant = messages.find((message) => message.info.id === "msg_assistant")
    if (!messages.some((message) => message.info.id === "msg_old") || user?.parts.map((part) => part.type).join(",") !== "text,file" ||
      assistant?.parts.find((part) => part.id === "reasoning")?.text !== "Detailed provider thinking" || assistant.parts.find((part) => part.id === "text")?.text !== "hi" ||
      assistant.parts.find((part) => part.id === "tool")?.state?.output !== "/work" || !JSON.stringify(assistant.parts.find((part) => part.id === "tool")?.state?.metadata).includes("kept") ||
      !assistant.parts.some((part) => part.id === "legacy-patch") || assistant.info.providerID !== "acme" || assistant.info.modelID !== "model" ||
      messages.find((message) => message.info.id === "msg_compaction")?.parts[0]?.type !== "compaction" ||
      messages.some((message) => ["msg_system", "msg_synthetic"].includes(message.info.id))) {
      throw new Error(`V2 projected messages were not converted or merged with legacy history: ${JSON.stringify(messages)}`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("empty v2 user projections preserve legacy prompt content", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname.startsWith("/api/session/")) {
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "msg_user", type: "user", time: { created: 1 }, text: "" }], cursor: {} })))
    }
    return Promise.resolve(new Response(JSON.stringify([{
      info: { id: "msg_user", sessionID: "session", role: "user" },
      parts: [{ id: "legacy-text", sessionID: "session", messageID: "msg_user", type: "text", text: "Keep the actual prompt" }],
    }])))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const messages = await client.messages("session")
    if (messages[0]?.parts[0]?.text !== "Keep the actual prompt") throw new Error("Empty v2 projection replaced the legacy prompt")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("v2-only goal projections recognize the persisted continuation text", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname.startsWith("/api/session/")) return Promise.resolve(new Response(JSON.stringify({
      data: [{
        id: "msg_goal",
        type: "user",
        time: { created: 1 },
        text: GOAL_CONTINUATION_PROMPT,
      }, {
        id: "msg_ordinary",
        type: "user",
        time: { created: 2 },
        text: `${GOAL_CONTINUATION_PROMPT} User-authored suffix.`,
      }],
      cursor: {},
    })))
    return Promise.resolve(new Response("legacy unavailable", { status: 500 }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const history = await client.messageHistory("session")
    const part = history.messages[0]?.parts[0]
    const ordinary = history.messages[1]?.parts[0]
    if (part?.synthetic !== true || part.metadata !== undefined || ordinary?.synthetic !== undefined) {
      throw new Error(`V2-only goal continuation lost its presentation marker: ${JSON.stringify(history)}`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("message reconciliation follows v2 and legacy pagination cursors", async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${url.pathname}?${url.searchParams}`)
    if (url.pathname.startsWith("/api/session/")) {
      const older = url.searchParams.get("cursor") === "v2-older"
      return Promise.resolve(new Response(JSON.stringify(older
        ? { data: [{ id: "old", type: "user", time: { created: 1 }, text: "old" }], cursor: {} }
        : { data: [{ id: "new", type: "user", time: { created: 2 }, text: "new" }], cursor: { next: "v2-older" } })))
    }
    const older = url.searchParams.get("before") === "legacy-older"
    const data = older
      ? [{ info: { id: "old", sessionID: "session", role: "user", time: { created: 1 } }, parts: [] }]
      : [{ info: { id: "new", sessionID: "session", role: "user", time: { created: 2 } }, parts: [] }]
    return Promise.resolve(new Response(JSON.stringify(data), older ? undefined : { headers: { "x-next-cursor": "legacy-older" } }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const history = await client.messageHistory("session")
    if (history.messages.map((message) => message.info.id).join(",") !== "old,new" || history.legacyMessageIDs.join(",") !== "old,new" || history.v2MessageIDs.join(",") !== "old,new" || !requests.some((request) => request.includes("cursor=v2-older")) ||
      !requests.some((request) => request.includes("before=legacy-older"))) throw new Error("Transcript pagination did not retrieve and order older pages")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("bounded message history pages advance both protocol cursors without loading the full session", async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${url.pathname}?${url.searchParams}`)
    const older = url.searchParams.has("cursor") || url.searchParams.has("before")
    const id = older ? "old" : "new"
    if (url.pathname.startsWith("/api/session/")) return Promise.resolve(new Response(JSON.stringify({
      data: [{ id, type: "user", time: { created: older ? 1 : 2 }, text: id }],
      cursor: older ? {} : { next: "v2-older" },
    })))
    const message = { info: { id, sessionID: "session", role: "user", time: { created: older ? 1 : 2 } }, parts: [] }
    return Promise.resolve(new Response(JSON.stringify([message]), older ? undefined : { headers: { "x-next-cursor": "legacy-older" } }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const recent = await client.messageHistoryPage("session", undefined, 400)
    const older = await client.messageHistoryPage("session", recent.cursor, 1_000)
    if (recent.messages.map((message) => message.info.id).join(",") !== "new" || recent.cursor.legacyComplete || recent.cursor.v2Complete ||
      older.messages.map((message) => message.info.id).join(",") !== "old" || !older.cursor.legacyComplete || !older.cursor.v2Complete ||
      !requests.some((request) => request.includes("limit=200")) || !requests.some((request) => request.includes("limit=500")) ||
      !requests.some((request) => request.includes("cursor=v2-older")) || !requests.some((request) => request.includes("before=legacy-older"))) {
      throw new Error(`Bounded history pagination did not preserve both cursors: ${JSON.stringify({ recent, older, requests })}`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("prompt admission checks durable session history", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const after = url.searchParams.get("after")
    return Promise.resolve(new Response(JSON.stringify(after === "0"
      ? { data: [{ type: "session.next.prompt.admitted", durable: { seq: 4 }, data: { messageID: "msg_target" } }], hasMore: false }
      : { data: [], hasMore: false })))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    if (await client.hasPromptAdmission("session", "msg_target") !== true || await client.hasPromptAdmission("session", "msg_missing") !== false) {
      throw new Error("Durable prompt admission was not detected")
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("ordinary requests reject oversized bodies and support lifecycle cancellation", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response("{}", { headers: { "content-length": String(32 * 1024 * 1024 + 1) } })
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    let oversized = false
    try {
      await client.path()
    } catch (error) {
      oversized = /size limit/.test(error instanceof Error ? error.message : String(error))
    }
    if (!oversized) throw new Error("Oversized OpenCode response was accepted")

    globalThis.fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
    const pending = client.path().then(() => false, () => true)
    client.cancelPendingRequests()
    if (!await pending) throw new Error("Pending OpenCode request was not cancelled")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("runtime and todo methods use native endpoints and catalog context limits", async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    paths.push(url.pathname)
    const provider = { id: "acme", name: "Acme", source: "api", models: { model: { name: "Model", limit: { context: 128_000, input: 120_000, output: 8_000 }, capabilities: { reasoning: true, attachment: true, toolcall: true, temperature: true, input: { text: true, audio: false, image: true, video: false, pdf: true }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false }, status: "active", release_date: "2026-01-01", variants: { low: {}, high: {} } } } }
    const value: unknown = url.pathname === "/config/providers"
      ? { providers: [provider], default: { acme: "model" } }
      : url.pathname === "/agent"
      ? [{ name: "build", mode: "primary", model: { providerID: "acme", modelID: "model" }, variant: "high" }, { name: "hidden", mode: "primary", hidden: true }, { name: "research", mode: "subagent" }]
      : url.pathname === "/config"
      ? { model: "acme/model", default_agent: "build" }
      : url.pathname === "/experimental/resource"
      ? { docs: { name: "Docs", uri: "mcp://docs", client: "docs", description: "Documentation" } }
      : url.pathname.endsWith("/todo")
      ? [{ content: "Work", status: "pending", priority: "high" }]
      : {}
    return Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } }))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    await Promise.all([client.path(), client.vcs(), client.lsp(), client.formatter(), client.mcp(), client.todos("session")])
    const catalogs = await client.catalogs()
    for (const path of ["/path", "/vcs", "/lsp", "/formatter", "/mcp", "/session/session/todo", "/config", "/config/providers", "/experimental/resource"]) {
      if (!paths.includes(path)) throw new Error(`Native endpoint was not requested: ${path}`)
    }
    if (catalogs.models[0]?.contextLimit !== 128_000) throw new Error("Provider context limit was not exposed")
    if (catalogs.models[0]?.inputLimit !== 120_000 || catalogs.models[0]?.outputLimit !== 8_000 || !catalogs.models[0]?.capabilities?.input?.image) throw new Error("Provider model capabilities and separate limits were not exposed")
    if (catalogs.models[0]?.variants?.join(",") !== "low,high") throw new Error("Provider reasoning variants were not exposed")
    if (catalogs.agents[0]?.model?.providerID !== "acme" || catalogs.agents[0]?.model?.modelID !== "model") throw new Error("Agent model default was not exposed")
    if (catalogs.agents.some((agent) => agent.name === "hidden") || catalogs.mentionAgents[0]?.name !== "research" || catalogs.resources[0]?.uri !== "mcp://docs") throw new Error("Hidden agents or mention/resource catalogs were incorrect")
    if (catalogs.defaults.agent !== "build" || catalogs.defaults.model !== "acme/model" || catalogs.defaults.variant !== "high") {
      throw new Error("OpenCode configuration defaults were not exposed")
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
