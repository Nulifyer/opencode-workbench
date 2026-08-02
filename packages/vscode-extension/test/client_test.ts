import { PERMISSION_AGGREGATE_CHARACTER_LIMIT, parseHostMessage } from "@opencode-workbench/shared"
import { OpenCodeClient, parseChanges, parseCommands, parsePermission, parsePermissions, parseQuestion, parseQuestions, parseTodos, validateServerUrl } from "../src/opencode-client.ts"

function throws(operation: () => void, pattern: RegExp): void {
  try {
    operation()
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return
    throw error
  }
  throw new Error("Expected operation to throw")
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
      sessions: [{ id: "session", title: "Session", status: { type: "idle" }, unread: 0 }],
      agents: [],
      models: [],
      session: {
        id: "session",
        title: "Session",
        draft: "",
        status: { type: "idle" },
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
    return url.pathname.endsWith("/prompt") ? new Response(JSON.stringify({ data: {} })) : new Response(null, { status: 204 })
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    await client.sendPrompt("session", "msg_request", "Review these", "queue", "build", "acme/model", "high", [
      { type: "file", mime: "text/plain", url: "file:///work/src/main.ts?start=4&end=8", filename: "main.ts" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,eA==", filename: "image.png" },
    ])
    const prompt = requests.find((request) => request.path.endsWith("/prompt"))?.body as { id?: string; delivery?: string; prompt?: { files?: Array<Record<string, unknown>> } }
    const model = requests.find((request) => request.path.endsWith("/model"))?.body as { model?: Record<string, unknown> }
    if (requests.map((request) => request.path).join(",") !== "/api/session/session/agent,/api/session/session/model,/api/session/session/prompt" ||
      prompt.id !== "msg_request" || prompt.delivery !== "queue" || prompt.prompt?.files?.[0]?.uri !== "file:///work/src/main.ts?start=4&end=8" ||
      prompt.prompt?.files?.[1]?.uri !== "data:image/png;base64,eA==" || model.model?.variant !== "high") {
      throw new Error("V2 prompt admission omitted durable or structured fields")
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
    await client.sendAsync("session", "hello", "caveboss", "openai/gpt-5.6-sol", "high")
    const body = request?.body as { agent?: string; model?: { providerID?: string; modelID?: string }; variant?: string }
    if (request?.path !== "/session/session/prompt_async" || body.agent !== "caveboss" || body.model?.providerID !== "openai" ||
      body.model.modelID !== "gpt-5.6-sol" || body.variant !== "high") {
      throw new Error("Legacy async prompt omitted custom provider selection")
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
            { id: "text", type: "text", text: "hi" },
            { id: "tool", type: "tool", name: "bash", time: { created: 2, completed: 3 }, state: { status: "completed", input: { command: "pwd" }, content: [{ type: "text", text: "/work" }], structured: {} } },
          ],
          finish: "stop",
          cost: 0.01,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
      cursor: {},
    })))
    return Promise.resolve(new Response(JSON.stringify([{ info: { id: "msg_old", sessionID: "session", role: "user" }, parts: [] }])))
  }
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "", password: "", directory: "/work" })
    const messages = await client.messages("session")
    const user = messages.find((message) => message.info.id === "msg_user")
    const assistant = messages.find((message) => message.info.id === "msg_assistant")
    if (!messages.some((message) => message.info.id === "msg_old") || user?.parts.map((part) => part.type).join(",") !== "text,file" ||
      assistant?.parts[0]?.text !== "hi" || assistant.parts[1]?.state?.output !== "/work" || assistant.info.providerID !== "acme" || assistant.info.modelID !== "model") {
      throw new Error("V2 projected messages were not converted or merged with legacy history")
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
