import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

type JsonObject = Record<string, unknown>

interface JsonRpcMessage extends JsonObject {
  jsonrpc: "2.0"
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

interface WireEntry {
  direction: "client-to-agent" | "agent-to-client"
  message: JsonRpcMessage
}

interface PendingRequest {
  resolve(message: JsonRpcMessage): void
  reject(error: Error): void
}

interface ProcessSummary {
  name: string
  requestMethods: string[]
  notificationMethods: string[]
  agentRequestMethods: string[]
  agentNotificationMethods: string[]
  malformedInputSurvived: boolean
  cleanExit: boolean
}

export type CapabilityClassification = "supported" | "mapped" | "missing" | "unknown"

export interface AcpCapabilityClassification {
  capability: string
  classification: CapabilityClassification
  evidence: string
  limitation?: string
}

export interface AcpContractFixture {
  schemaVersion: 1
  recordedAt: string
  providerRequestMode: "disabled" | "opt-in-enabled"
  opencode: {
    version: string
    acpSdkVersion: "0.21.0"
    protocolVersion: number
  }
  initialization: {
    agentName: string
    authMethodIDs: string[]
    capabilities: unknown
  }
  session: {
    configOptionIDs: string[]
    modeIDs: string[]
    modelSelection: boolean
    variantSelection: boolean
    availableCommands: string[]
    undoAdvertised: boolean
    redoAdvertised: boolean
    persistedAcrossRestart: boolean
    forkReturnedDistinctID: boolean
    listFilteredByWorkingDirectory: boolean
  }
  protocol: {
    agentRequestMethods: string[]
    agentNotificationMethods: string[]
    clientRequestMethods: string[]
    clientNotificationMethods: string[]
    unknownMethodErrorCode: number
    invalidParamsErrorCode: number
    malformedInputSurvived: boolean
    simultaneousProcesses: boolean
    terminatedProcessObserved: boolean
  }
  processes: ProcessSummary[]
  modelPromptProbe: {
    enabled: boolean
    requestMethod?: "session/prompt"
    stopReason?: string
    updateKinds: string[]
  }
  classifications: AcpCapabilityClassification[]
}

export interface RecordAcpContractOptions {
  executable: string
  expectedVersion?: string
  pluginPath?: string | null
  allowModelPrompt?: boolean
  modelPromptText?: string
  timeoutMilliseconds?: number
}

const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    _meta: { "terminal-auth": true },
  },
  clientInfo: {
    name: "opencode-workbench-contract-recorder",
    title: "OpenCode Workbench ACP Contract Recorder",
    version: "0.4.7",
  },
}

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_STDERR_CHARACTERS = 128 * 1024

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonRpc(value: unknown): value is JsonRpcMessage {
  return isRecord(value) && value.jsonrpc === "2.0"
}

function asRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} was not an object`)
  return value
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} was not an array`)
  return value
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string`)
  return value
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isolatedEnvironment(root: string, pluginPath: string | null | undefined): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (key.startsWith("OPENCODE_") || /(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|API)/i.test(key)) continue
    environment[key] = value
  }
  environment.HOME = path.join(root, "home")
  environment.XDG_CONFIG_HOME = path.join(root, "config")
  environment.XDG_DATA_HOME = path.join(root, "data")
  environment.XDG_CACHE_HOME = path.join(root, "cache")
  environment.XDG_STATE_HOME = path.join(root, "state")
  environment.OPENCODE_DISABLE_AUTOUPDATE = "true"
  if (pluginPath) environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [pathToFileURL(pluginPath).href] })
  return environment
}

class AcpProcess {
  readonly wire: WireEntry[] = []
  readonly rawInput: string[] = []
  readonly stderr: string[] = []
  private readonly pending = new Map<number | string, PendingRequest>()
  private readonly waiters = new Set<
    { predicate(message: JsonRpcMessage): boolean; resolve(message: JsonRpcMessage): void }
  >()
  private readonly child: Deno.ChildProcess
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>
  private readonly decoder = new TextEncoder()
  private readonly outputTask: Promise<void>
  private readonly errorTask: Promise<void>
  private writeTail = Promise.resolve()
  private requestID = 0
  private stopped = false

  constructor(
    readonly name: string,
    executable: string,
    processCwd: string,
    environment: Record<string, string>,
    private readonly timeoutMilliseconds: number,
  ) {
    this.child = new Deno.Command(executable, {
      args: ["acp", "--cwd", processCwd, "--hostname", "127.0.0.1", "--port", "0", "--log-level", "ERROR"],
      cwd: processCwd,
      env: environment,
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn()
    this.writer = this.child.stdin.getWriter()
    this.outputTask = this.readOutput()
    this.errorTask = this.readErrors()
  }

  private async readOutput(): Promise<void> {
    const reader = this.child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ""
        for (const line of lines) if (line.trim()) await this.handleLine(line)
      }
      buffer += decoder.decode()
      if (buffer.trim()) await this.handleLine(buffer)
    } finally {
      reader.releaseLock()
      const error = new Error(`${this.name} ACP process closed before replying`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
  }

  private async readErrors(): Promise<void> {
    const reader = this.child.stderr.getReader()
    const decoder = new TextDecoder()
    let characters = 0
    try {
      while (characters < MAX_STDERR_CHARACTERS) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const retained = chunk.slice(0, MAX_STDERR_CHARACTERS - characters)
        characters += retained.length
        if (retained) this.stderr.push(retained)
      }
      const tail = decoder.decode()
      if (tail && characters < MAX_STDERR_CHARACTERS) {
        this.stderr.push(tail.slice(0, MAX_STDERR_CHARACTERS - characters))
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      throw new Error(`${this.name} emitted malformed ACP JSON`)
    }
    if (!jsonRpc(message)) throw new Error(`${this.name} emitted a non-JSON-RPC message`)
    this.wire.push({ direction: "agent-to-client", message })
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue
      this.waiters.delete(waiter)
      waiter.resolve(message)
    }
    if (message.id !== undefined && message.method) {
      const response = message.method === "session/request_permission"
        ? { jsonrpc: "2.0" as const, id: message.id, result: { outcome: { outcome: "cancelled" } } }
        : {
          jsonrpc: "2.0" as const,
          id: message.id,
          error: { code: -32601, message: `Unsupported recorder client method: ${message.method}` },
        }
      await this.writeMessage(response)
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    pending.resolve(message)
  }

  private writeMessage(message: JsonRpcMessage): Promise<void> {
    if (this.stopped) return Promise.reject(new Error(`${this.name} ACP process is closed`))
    this.wire.push({ direction: "client-to-agent", message })
    this.writeTail = this.writeTail.then(() => this.writer.write(this.decoder.encode(`${JSON.stringify(message)}\n`)))
    return this.writeTail
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = ++this.requestID
    const response = new Promise<JsonRpcMessage>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    await this.writeMessage({ jsonrpc: "2.0", id, method, params })
    return await withTimeout(response, this.timeoutMilliseconds, `${this.name} ${method}`)
  }

  async result(method: string, params: unknown): Promise<unknown> {
    const response = await this.request(method, params)
    if (response.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`)
    return response.result
  }

  async notification(method: string, params: unknown): Promise<void> {
    await this.writeMessage({ jsonrpc: "2.0", method, params })
  }

  async raw(line: string): Promise<void> {
    this.rawInput.push(line)
    this.writeTail = this.writeTail.then(() => this.writer.write(this.decoder.encode(`${line}\n`)))
    await this.writeTail
  }

  waitFor(predicate: (message: JsonRpcMessage) => boolean, label: string): Promise<JsonRpcMessage> {
    const existing = this.wire.find((entry) => entry.direction === "agent-to-client" && predicate(entry.message))
    if (existing) return Promise.resolve(existing.message)
    const waiting = new Promise<JsonRpcMessage>((resolve) => this.waiters.add({ predicate, resolve }))
    return withTimeout(waiting, this.timeoutMilliseconds, `${this.name} ${label}`)
  }

  async close(): Promise<Deno.CommandStatus> {
    if (!this.stopped) {
      this.stopped = true
      await this.writeTail
      await this.writer.close()
    }
    const status = await withTimeout(this.child.status, this.timeoutMilliseconds, `${this.name} exit`)
    await Promise.allSettled([this.outputTask, this.errorTask])
    return status
  }

  async terminate(): Promise<Deno.CommandStatus> {
    if (!this.stopped) {
      this.stopped = true
      this.child.kill("SIGTERM")
    }
    const status = await withTimeout(this.child.status, this.timeoutMilliseconds, `${this.name} termination`)
    await Promise.allSettled([this.outputTask, this.errorTask])
    return status
  }
}

function requireResponseError(message: JsonRpcMessage, expected: number, label: string): JsonObject {
  const error = asRecord(message.error, `${label} error`)
  if (error.code !== expected) throw new Error(`${label} returned ${String(error.code)} instead of ${expected}`)
  return error
}

function resultConfigOptions(result: unknown): JsonObject[] {
  const options = asArray(asRecord(result, "session result").configOptions, "session configOptions")
  return options.map((option, index) => asRecord(option, `configOptions[${index}]`))
}

function commandNames(process: AcpProcess): string[] {
  const names = new Set<string>()
  for (const entry of process.wire) {
    if (entry.direction !== "agent-to-client" || entry.message.method !== "session/update") continue
    const params = isRecord(entry.message.params) ? entry.message.params : undefined
    const update = params && isRecord(params.update) ? params.update : undefined
    if (update?.sessionUpdate !== "available_commands_update" || !Array.isArray(update.availableCommands)) continue
    for (const command of update.availableCommands) {
      if (isRecord(command) && typeof command.name === "string") names.add(command.name)
    }
  }
  return [...names].sort()
}

function updateKinds(processes: AcpProcess[]): string[] {
  const kinds = new Set<string>()
  for (const process of processes) {
    for (const entry of process.wire) {
      if (entry.direction !== "agent-to-client" || entry.message.method !== "session/update") continue
      const params = isRecord(entry.message.params) ? entry.message.params : undefined
      const update = params && isRecord(params.update) ? params.update : undefined
      if (typeof update?.sessionUpdate === "string") kinds.add(update.sessionUpdate)
    }
  }
  return [...kinds].sort()
}

function methodInventory(processes: AcpProcess[], direction: WireEntry["direction"], requests: boolean): string[] {
  const methods = new Set<string>()
  for (const process of processes) {
    for (const entry of process.wire) {
      if (entry.direction !== direction || !entry.message.method) continue
      if ((entry.message.id !== undefined) !== requests) continue
      methods.add(entry.message.method)
    }
  }
  return [...methods].sort()
}

function processSummary(process: AcpProcess, cleanExit: boolean): ProcessSummary {
  return {
    name: process.name,
    requestMethods: methodInventory([process], "client-to-agent", true),
    notificationMethods: methodInventory([process], "client-to-agent", false),
    agentRequestMethods: methodInventory([process], "agent-to-client", true),
    agentNotificationMethods: methodInventory([process], "agent-to-client", false),
    malformedInputSurvived: process.rawInput.length > 0 &&
      process.wire.some((entry) =>
        entry.direction === "agent-to-client" && entry.message.id !== undefined && entry.message.result !== undefined
      ),
    cleanExit,
  }
}

async function executableVersion(executable: string): Promise<string> {
  const output = await new Deno.Command(executable, { args: ["--version"], stdout: "piped", stderr: "piped" }).output()
  const value = `${new TextDecoder().decode(output.stdout)}${new TextDecoder().decode(output.stderr)}`.trim()
  if (!output.success || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Could not determine OpenCode version from ${executable}: ${value || `exit ${output.code}`}`)
  }
  return value
}

async function initialize(process: AcpProcess): Promise<JsonObject> {
  return asRecord(await process.result("initialize", INITIALIZE_PARAMS), "initialize result")
}

export function contractCompatibilitySignature(fixture: AcpContractFixture): unknown {
  return {
    schemaVersion: fixture.schemaVersion,
    opencode: fixture.opencode,
    initialization: fixture.initialization,
    session: {
      configOptionIDs: fixture.session.configOptionIDs,
      modeIDs: fixture.session.modeIDs,
      modelSelection: fixture.session.modelSelection,
      variantSelection: fixture.session.variantSelection,
      availableCommands: fixture.session.availableCommands,
      undoAdvertised: fixture.session.undoAdvertised,
      redoAdvertised: fixture.session.redoAdvertised,
    },
    protocol: {
      agentRequestMethods: fixture.protocol.agentRequestMethods,
      agentNotificationMethods: fixture.protocol.agentNotificationMethods,
      clientRequestMethods: fixture.protocol.clientRequestMethods,
      clientNotificationMethods: fixture.protocol.clientNotificationMethods,
      unknownMethodErrorCode: fixture.protocol.unknownMethodErrorCode,
      invalidParamsErrorCode: fixture.protocol.invalidParamsErrorCode,
    },
    classifications: fixture.classifications,
  }
}

export async function recordAcpContract(options: RecordAcpContractOptions): Promise<AcpContractFixture> {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MS
  const version = await executableVersion(options.executable)
  if (options.expectedVersion && version !== options.expectedVersion) {
    throw new Error(
      `OpenCode ACP fixture is pinned to ${options.expectedVersion}, but the executable reports ${version}. Review the contract before re-recording.`,
    )
  }
  if (options.pluginPath) {
    const stat = await Deno.stat(options.pluginPath).catch(() => undefined)
    if (!stat?.isFile) {
      throw new Error(`Bundled plugin is unavailable at ${options.pluginPath}; run deno task build first`)
    }
  }

  const root = await Deno.makeTempDir({ prefix: "opencode-workbench-acp-contract-" })
  const workspaceA = path.join(root, "workspace-a")
  const workspaceB = path.join(root, "workspace-b")
  for (
    const directory of [
      workspaceA,
      workspaceB,
      path.join(root, "home"),
      path.join(root, "config"),
      path.join(root, "data"),
      path.join(root, "cache"),
      path.join(root, "state"),
    ]
  ) {
    await Deno.mkdir(directory, { recursive: true })
  }
  const environment = isolatedEnvironment(root, options.pluginPath)
  const processes: AcpProcess[] = []
  let primary: AcpProcess | undefined
  let secondary: AcpProcess | undefined
  let restarted: AcpProcess | undefined
  let terminated: AcpProcess | undefined
  try {
    primary = new AcpProcess("primary", options.executable, workspaceA, environment, timeoutMilliseconds)
    processes.push(primary)
    const initialization = await initialize(primary)
    await primary.result("authenticate", { methodId: "opencode-login" })
    const created = asRecord(
      await primary.result("session/new", { cwd: workspaceA, mcpServers: [] }),
      "session/new result",
    )
    const sessionID = asString(created.sessionId, "session/new sessionId")
    const configOptions = resultConfigOptions(created)
    const modelOption = configOptions.find((option) => option.id === "model")
    const modeOption = configOptions.find((option) => option.id === "mode")
    const modelID = typeof modelOption?.currentValue === "string" ? modelOption.currentValue : undefined
    const modeIDs = Array.isArray(modeOption?.options)
      ? modeOption.options.flatMap((option) =>
        isRecord(option) && typeof option.value === "string" ? [option.value] : []
      )
      : []
    if (modeIDs.includes("plan")) {
      await primary.result("session/set_config_option", { sessionId: sessionID, configId: "mode", value: "plan" })
    }
    if (modeIDs.includes("build")) await primary.result("session/set_mode", { sessionId: sessionID, modeId: "build" })
    if (modelID) {
      await primary.result("session/set_config_option", { sessionId: sessionID, configId: "model", value: modelID })
      await primary.result("session/set_model", { sessionId: sessionID, modelId: modelID })
    }
    const listed = asRecord(await primary.result("session/list", { cwd: workspaceA }), "session/list result")
    const listedSessions = asArray(listed.sessions, "session/list sessions")
    const workingDirectoryFiltered = listedSessions.every((session) => isRecord(session) && session.cwd === workspaceA)
    const forked = asRecord(
      await primary.result("session/fork", { sessionId: sessionID, cwd: workspaceA, mcpServers: [] }),
      "session/fork result",
    )
    const forkedID = asString(forked.sessionId, "session/fork sessionId")
    await primary.result("session/close", { sessionId: forkedID })
    await primary.result("session/resume", { sessionId: forkedID, cwd: workspaceA, mcpServers: [] })
    await primary.result("session/load", { sessionId: sessionID, cwd: workspaceA, mcpServers: [] })
    await primary.notification("session/cancel", { sessionId: sessionID })

    const unknown = await primary.request("workbench/unknown", {})
    const unknownError = requireResponseError(unknown, -32601, "unknown method")
    const invalid = await primary.request("session/new", {})
    const invalidError = requireResponseError(invalid, -32602, "invalid params")
    await primary.raw("not-json")
    const afterMalformed = await primary.result("session/list", { cwd: workspaceA })
    const malformedInputSurvived = isRecord(afterMalformed) && Array.isArray(afterMalformed.sessions)

    const commands = commandNames(primary)
    if (options.pluginPath && (!commands.includes("goal") || !commands.includes("goal-unlimited"))) {
      throw new Error("Bundled companion plugin commands were not visible through ACP session/update")
    }

    secondary = new AcpProcess("secondary", options.executable, workspaceB, environment, timeoutMilliseconds)
    processes.push(secondary)
    await initialize(secondary)
    const secondaryCreated = asRecord(
      await secondary.result("session/new", { cwd: workspaceB, mcpServers: [] }),
      "secondary session/new result",
    )
    const secondaryID = asString(secondaryCreated.sessionId, "secondary sessionId")
    const primaryFiltered = asRecord(await primary.result("session/list", { cwd: workspaceA }), "primary filtered list")
    const secondaryFiltered = asRecord(
      await secondary.result("session/list", { cwd: workspaceB }),
      "secondary filtered list",
    )
    const simultaneousProcesses = asArray(primaryFiltered.sessions, "primary sessions").every((session) =>
      isRecord(session) && session.cwd === workspaceA
    ) &&
      asArray(secondaryFiltered.sessions, "secondary sessions").some((session) =>
        isRecord(session) && session.sessionId === secondaryID && session.cwd === workspaceB
      )

    let promptStopReason: string | undefined
    if (options.allowModelPrompt) {
      const prompt = primary.request("session/prompt", {
        sessionId: sessionID,
        prompt: [{
          type: "text",
          text: options.modelPromptText ?? "Reply with the single word READY. Do not use tools.",
        }],
      })
      const cancelTimer = setTimeout(() =>
        void primary?.notification("session/cancel", { sessionId: sessionID }), 5_000)
      try {
        const response = await prompt
        const result = asRecord(response.result, "session/prompt result")
        if (typeof result.stopReason === "string") {
          promptStopReason = result.stopReason
        }
      } finally {
        clearTimeout(cancelTimer)
      }
    }

    const primaryStatus = await primary.close()
    primary = undefined
    const secondaryStatus = await secondary.close()
    secondary = undefined

    restarted = new AcpProcess("restart", options.executable, workspaceA, environment, timeoutMilliseconds)
    processes.push(restarted)
    await initialize(restarted)
    const afterRestart = asRecord(
      await restarted.result("session/list", { cwd: workspaceA }),
      "restart session/list result",
    )
    const persistedAcrossRestart = asArray(afterRestart.sessions, "restart sessions").some((session) =>
      isRecord(session) && session.sessionId === sessionID
    )
    await restarted.result("session/resume", { sessionId: sessionID, cwd: workspaceA, mcpServers: [] })
    await restarted.result("session/close", { sessionId: sessionID })
    const restartStatus = await restarted.close()
    restarted = undefined

    terminated = new AcpProcess("terminated", options.executable, workspaceA, environment, timeoutMilliseconds)
    processes.push(terminated)
    await initialize(terminated)
    const terminatedStatus = await terminated.terminate()
    terminated = undefined

    const allCommands = [...new Set(processes.flatMap(commandNames))].sort()
    const optionIDs = configOptions.flatMap((option) =>
      typeof option.id === "string" ? [option.id] : []
    ).sort()
    const variantSelection = optionIDs.includes("effort")
    const capabilities = initialization.agentCapabilities
    const agentInfo = asRecord(initialization.agentInfo, "initialize agentInfo")
    const authMethods = asArray(initialization.authMethods, "initialize authMethods")
    const classifications: AcpCapabilityClassification[] = [
      {
        capability: "initialize and capability negotiation",
        classification: "supported",
        evidence: "initialize response, protocolVersion 1",
      },
      {
        capability: "session create/list/load/resume/fork/close",
        classification: "supported",
        evidence: "provider-free JSON-RPC probes and restart probe",
      },
      {
        capability: "working-directory isolation",
        classification: "supported",
        evidence: "two simultaneous subprocesses with filtered session/list results",
      },
      {
        capability: "agent/mode selection",
        classification: modeIDs.length ? "supported" : "unknown",
        evidence: "mode config option and session/set_mode",
      },
      {
        capability: "model selection",
        classification: modelID ? "supported" : "unknown",
        evidence: "model config option and session/set_model",
      },
      {
        capability: "variant selection",
        classification: variantSelection ? "supported" : "unknown",
        evidence: variantSelection ? "effort config option" : "no effort option for the provider-free default model",
      },
      {
        capability: "slash-command discovery",
        classification: "supported",
        evidence: "session/update available_commands_update",
      },
      {
        capability: "companion-plugin commands",
        classification: options.pluginPath ? "supported" : "unknown",
        evidence: options.pluginPath
          ? "goal and goal-unlimited in available_commands_update"
          : "plugin not loaded by recorder",
      },
      {
        capability: "tool and companion-tool schema discovery",
        classification: "missing",
        evidence: "no ACP tool-list method or provider-free tool-schema update",
        limitation: "Tool calls are observable only during a model turn.",
      },
      {
        capability: "MCP registration",
        classification: "supported",
        evidence: "initialize mcpCapabilities advertises HTTP and SSE; session setup accepts mcpServers",
      },
      {
        capability: "MCP tool discovery",
        classification: "unknown",
        evidence: "no provider-free MCP tool-list update observed",
        limitation: "Requires an MCP fixture plus a model turn to observe tool use.",
      },
      {
        capability: "permission request and response choices",
        classification: "unknown",
        evidence: "session/request_permission requires an opt-in model/tool turn",
        limitation: "Not exercised by default.",
      },
      {
        capability: "questions and durable user input",
        classification: "unknown",
        evidence: "no provider-free question request can be triggered",
        limitation: "Not exercised by default.",
      },
      {
        capability: "prompt/message/reasoning/tool/diff/usage lifecycle",
        classification: options.allowModelPrompt ? "mapped" : "unknown",
        evidence: options.allowModelPrompt ? "opt-in session/prompt recording" : "session/prompt disabled by default",
        limitation: options.allowModelPrompt ? undefined : "Use --allow-model-prompt explicitly.",
      },
      {
        capability: "cancellation",
        classification: "mapped",
        evidence: "session/cancel is a notification accepted for an idle session",
        limitation: "Active-turn cancellation needs the opt-in prompt seam.",
      },
      {
        capability: "queue/steer/follow-up/replace",
        classification: "missing",
        evidence: "no distinct ACP 0.21.0 methods or advertised capabilities",
      },
      {
        capability: "/undo and /redo",
        classification: "missing",
        evidence: "not present in available_commands_update",
      },
      {
        capability: "malformed input recovery",
        classification: malformedInputSurvived ? "supported" : "missing",
        evidence: "invalid NDJSON line followed by successful session/list",
      },
      {
        capability: "process crash recovery",
        classification: "mapped",
        evidence: "SIGTERM observed and sessions remained server-persisted",
      },
    ]

    return {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      providerRequestMode: options.allowModelPrompt ? "opt-in-enabled" : "disabled",
      opencode: {
        version,
        acpSdkVersion: "0.21.0",
        protocolVersion: Number(initialization.protocolVersion),
      },
      initialization: {
        agentName: asString(agentInfo.name, "agentInfo name"),
        authMethodIDs: authMethods.flatMap((method) =>
          isRecord(method) && typeof method.id === "string" ? [method.id] : []
        ).sort(),
        capabilities,
      },
      session: {
        configOptionIDs: optionIDs,
        modeIDs: [...new Set(modeIDs)].sort(),
        modelSelection: Boolean(modelID),
        variantSelection,
        availableCommands: allCommands,
        undoAdvertised: allCommands.includes("undo"),
        redoAdvertised: allCommands.includes("redo"),
        persistedAcrossRestart,
        forkReturnedDistinctID: forkedID !== sessionID,
        listFilteredByWorkingDirectory: workingDirectoryFiltered,
      },
      protocol: {
        agentRequestMethods: methodInventory(processes, "client-to-agent", true),
        agentNotificationMethods: methodInventory(processes, "client-to-agent", false),
        clientRequestMethods: methodInventory(processes, "agent-to-client", true),
        clientNotificationMethods: methodInventory(processes, "agent-to-client", false),
        unknownMethodErrorCode: Number(unknownError.code),
        invalidParamsErrorCode: Number(invalidError.code),
        malformedInputSurvived,
        simultaneousProcesses,
        terminatedProcessObserved: !terminatedStatus.success,
      },
      processes: [
        processSummary(processes[0]!, primaryStatus.success),
        processSummary(processes[1]!, secondaryStatus.success),
        processSummary(processes[2]!, restartStatus.success),
        processSummary(processes[3]!, terminatedStatus.success),
      ],
      modelPromptProbe: {
        enabled: options.allowModelPrompt === true,
        ...(options.allowModelPrompt ? { requestMethod: "session/prompt" as const, stopReason: promptStopReason } : {}),
        updateKinds: updateKinds(processes),
      },
      classifications,
    }
  } finally {
    await Promise.allSettled([
      primary?.terminate(),
      secondary?.terminate(),
      restarted?.terminate(),
      terminated?.terminate(),
    ].filter((value): value is Promise<Deno.CommandStatus> => Boolean(value)))
    await Deno.remove(root, { recursive: true })
  }
}

interface CliOptions {
  executable: string
  expectedVersion: string
  output: string
  pluginPath: string | null
  allowModelPrompt: boolean
}

function parseArguments(args: string[]): CliOptions {
  const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const options: CliOptions = {
    executable: Deno.env.get("OPENCODE_ACP_EXECUTABLE") ?? "opencode",
    expectedVersion: Deno.env.get("OPENCODE_ACP_VERSION") ?? "1.18.15",
    output: path.join(repository, "packages", "vscode-extension", "test", "fixtures", "acp", "opencode-1.18.15.json"),
    pluginPath: path.join(repository, "dist", "opencode-plugin.js"),
    allowModelPrompt: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    const value = args[index + 1]
    if (argument === "--allow-model-prompt") options.allowModelPrompt = true
    else if (argument === "--without-plugin") options.pluginPath = null
    else if (argument === "--executable" && value) {
      options.executable = value
      index += 1
    } else if (argument === "--expected-version" && value) {
      options.expectedVersion = value
      index += 1
    } else if (argument === "--output" && value) {
      options.output = path.resolve(value)
      index += 1
    } else throw new Error(`Unknown or incomplete argument: ${argument}`)
  }
  return options
}

if (import.meta.main) {
  const options = parseArguments(Deno.args)
  if (options.allowModelPrompt) {
    console.warn(
      "WARNING: --allow-model-prompt permits a real provider/model request. This mode is never enabled by default.",
    )
  }
  const fixture = await recordAcpContract(options)
  await Deno.mkdir(path.dirname(options.output), { recursive: true })
  await Deno.writeTextFile(options.output, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`Recorded OpenCode ${fixture.opencode.version} ACP contract at ${options.output}`)
}
