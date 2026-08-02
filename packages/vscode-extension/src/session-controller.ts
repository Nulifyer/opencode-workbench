import { randomUUID } from "node:crypto"
import type {
  AgentOption,
  ChatSnapshot,
  CommandOption,
  ContextSummary,
  DelegationProgress,
  FileChange,
  GoalSummary,
  MessageBundle,
  MessagePart,
  MessagePatch,
  ModelOption,
  OpenCodeEvent,
  PermissionRequest,
  ProviderOption,
  QuestionRequest,
  ResourceOption,
  RuntimeService,
  RuntimeStatus,
  SessionStatus,
  TodoItem,
  WorkbenchState,
} from "@opencode-workbench/shared"
import {
  initialWorkbenchState,
  PERMISSION_AGGREGATE_CHARACTER_LIMIT,
  PROMPT_ATTACHMENT_CHARACTER_LIMIT,
  PROMPT_ATTACHMENT_COUNT_LIMIT,
  PROMPT_QUEUE_CHARACTER_LIMIT,
  PROMPT_QUEUE_COUNT_LIMIT,
  PROMPT_TEXT_CHARACTER_LIMIT,
  permissionRequestCharacters,
  sessionReducer,
} from "@opencode-workbench/shared"
import { OpenCodeClient, parseChanges, parsePermission, parseQuestion, parseTodos, type PromptFilePart } from "./opencode-client.js"

export interface ControllerCallbacks {
  error(message: string): void
  attention?(request: PermissionRequest | QuestionRequest): void
  preferencesChanged?(preferences: ComposerPreferences): void
}

export interface ComposerPreferences {
  currentAgent?: string
  lastModel?: string
  /** Legacy per-agent values are read only to migrate existing workspace preferences. */
  agentModels?: Array<[string, string]>
  modelVariants?: Array<[string, string | null]>
}

export type ControllerUpdate = Parameters<typeof sessionReducer>[1]

type JsonRecord = Record<string, unknown>

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const OMIT = Symbol("omit")

interface JsonBudget {
  nodes: number
  characters: number
}

function boundedJson(value: unknown, depth = 0, budget: JsonBudget = { nodes: 0, characters: 0 }): unknown | typeof OMIT {
  if (budget.nodes >= 900 || budget.characters >= 100_000) return OMIT
  budget.nodes += 1
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const remaining = 100_000 - budget.characters
    budget.characters += Math.min(value.length, remaining)
    return value.slice(0, remaining)
  }
  if (depth >= 8) return "[Truncated]"
  if (Array.isArray(value)) {
    const output: unknown[] = []
    for (const entry of value.slice(0, 100)) {
      const bounded = boundedJson(entry, depth + 1, budget)
      if (bounded === OMIT) break
      output.push(bounded)
    }
    return output
  }
  if (record(value)) {
    const output: JsonRecord = Object.create(null) as JsonRecord
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      const remaining = 100_000 - budget.characters
      if (remaining <= 0) break
      const boundedKey = key.slice(0, Math.min(1_024, remaining))
      if (!boundedKey || Object.hasOwn(output, boundedKey)) continue
      budget.characters += boundedKey.length
      const bounded = boundedJson(entry, depth + 1, budget)
      if (bounded === OMIT) break
      output[boundedKey] = bounded
    }
    return output
  }
  return String(value).slice(0, 1_024)
}

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined
}

function boundedTime(value: unknown): { start?: number; end?: number } | undefined {
  if (!record(value)) return undefined
  const start = typeof value.start === "number" && Number.isFinite(value.start) && value.start >= 0 ? value.start : undefined
  const end = typeof value.end === "number" && Number.isFinite(value.end) && value.end >= 0 ? value.end : undefined
  return start === undefined && end === undefined ? undefined : { start, end }
}

function snapshotPart(part: MessagePart): MessagePart | undefined {
  if (typeof part.id !== "string" || !part.id || part.id.length > 1_024 ||
    typeof part.sessionID !== "string" || !part.sessionID || part.sessionID.length > 1_024 ||
    typeof part.messageID !== "string" || !part.messageID || part.messageID.length > 1_024 ||
    typeof part.type !== "string" || !part.type || part.type.length > 100) return undefined
  const output: MessagePart = {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: part.type,
  }
  const text = boundedText(part.text, 500_000)
  if (text !== undefined) output.text = text
  if (typeof part.synthetic === "boolean") output.synthetic = part.synthetic
  const tool = boundedText(part.tool, 1_024)
  if (tool !== undefined) output.tool = tool
  if (part.type === "file") {
    const mime = boundedText(part.mime, 100)
    const filename = boundedText(part.filename, 255)
    if (mime !== undefined) output.mime = mime
    if (filename !== undefined) output.filename = filename
  }
  const time = boundedTime(part.time)
  if (time) output.time = time
  if (record(part.state)) {
    const state: NonNullable<MessagePart["state"]> = {}
    const status = boundedText(part.state.status, 100)
    const title = boundedText(part.state.title, 2_000)
    const stateOutput = boundedText(part.state.output, 100_000)
    const error = boundedText(part.state.error, 100_000)
    if (status !== undefined) state.status = status
    if (title !== undefined) state.title = title
    if (stateOutput !== undefined) state.output = stateOutput
    if (error !== undefined) state.error = error
    for (const key of ["input", "metadata"] as const) {
      if (part.state[key] === undefined) continue
      const value = boundedJson(part.state[key])
      if (value !== OMIT) state[key] = value
    }
    const stateTime = boundedTime(part.state.time)
    if (stateTime) state.time = stateTime
    output.state = state
  }
  return output
}

function snapshotPartCharacters(part: MessagePart): number {
  return (part.text?.length ?? 0) + (typeof part.mime === "string" ? part.mime.length : 0) + (typeof part.filename === "string" ? part.filename.length : 0) +
    (part.state?.title?.length ?? 0) + (part.state?.output?.length ?? 0) +
    (part.state?.error?.length ?? 0) + (part.state?.input === undefined ? 0 : JSON.stringify(part.state.input).length) +
    (part.state?.metadata === undefined ? 0 : JSON.stringify(part.state.metadata).length)
}

function snapshotMessage(message: MessageBundle): MessageBundle | undefined {
  const info = message.info
  if (typeof info.id !== "string" || !info.id || info.id.length > 1_024 ||
    typeof info.sessionID !== "string" || !info.sessionID || info.sessionID.length > 1_024 ||
    (info.role !== "user" && info.role !== "assistant")) return undefined
  const safeInfo: MessageBundle["info"] = { id: info.id, sessionID: info.sessionID, role: info.role }
  if (record(info.time)) {
    const created = typeof info.time.created === "number" && Number.isFinite(info.time.created) && info.time.created >= 0 ? info.time.created : undefined
    const completed = typeof info.time.completed === "number" && Number.isFinite(info.time.completed) && info.time.completed >= 0 ? info.time.completed : undefined
    if (created !== undefined || completed !== undefined) safeInfo.time = { created, completed }
  }
  if (info.error !== undefined) {
    const error = boundedJson(info.error)
    if (error !== OMIT) safeInfo.error = error
  }
  const parts: MessagePart[] = []
  let characters = 0
  for (const part of message.parts.slice(-2_000).reverse()) {
    const safe = snapshotPart(part)
    if (!safe) continue
    const size = snapshotPartCharacters(safe)
    if (characters + size > 1_500_000) break
    characters += size
    parts.push(safe)
  }
  parts.reverse()
  return { info: safeInfo, parts }
}

function snapshotTranscript(
  messages: MessageBundle[],
  revisions: Map<string, number>,
  characterLimit = 3_800_000,
  partLimit = 19_000,
  messageLimit = 5_000,
): { messages: MessageBundle[]; revisions: Record<string, number> } {
  const output: MessageBundle[] = []
  let parts = 0
  let characters = 0
  for (const message of messages.slice(-messageLimit).reverse()) {
    const safe = snapshotMessage(message)
    if (!safe) continue
    const nextParts = parts + safe.parts.length
    const nextCharacters = characters + safe.parts.reduce((total, part) => total + snapshotPartCharacters(part), 0)
    if (nextParts > partLimit || nextCharacters > characterLimit) break
    parts = nextParts
    characters = nextCharacters
    output.push(safe)
  }
  output.reverse()
  return {
    messages: output,
    revisions: Object.fromEntries(output.map((message) => [message.info.id, revisions.get(message.info.id) ?? 0])),
  }
}

function delegationSessionID(part: MessagePart): string | undefined {
  if (part.type !== "tool" || part.tool !== "task" || !record(part.state?.metadata)) return undefined
  const sessionID = part.state.metadata.sessionId
  return typeof sessionID === "string" && sessionID.length > 0 && sessionID.length <= 1_024 ? sessionID : undefined
}

function boundedRuntimeString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length <= limit ? value : undefined
}

function runtimeServices(value: unknown, objectEntries = false): RuntimeService[] {
  const entries: Array<[string | undefined, unknown]> = Array.isArray(value)
    ? value.slice(0, 500).map((entry) => [undefined, entry])
    : objectEntries && record(value)
    ? Object.entries(value).slice(0, 500)
    : []
  const services: RuntimeService[] = []
  let characters = 0
  for (const [key, entry] of entries) {
    if (!record(entry)) continue
    const id = boundedRuntimeString(entry.id, 1_024) ?? boundedRuntimeString(entry.name, 1_024) ?? boundedRuntimeString(key, 1_024)
    if (!id) continue
    const extensions = Array.isArray(entry.extensions)
      ? entry.extensions.slice(0, 200).filter((item): item is string => typeof item === "string" && item.length <= 100)
      : undefined
    const service: RuntimeService = {
      id,
      name: boundedRuntimeString(entry.name, 2_000),
      status: boundedRuntimeString(entry.status, 100) ?? boundedRuntimeString(entry.type, 100),
      root: boundedRuntimeString(entry.root, 8_192),
      error: boundedRuntimeString(entry.error, 20_000),
      extensions,
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
    }
    characters += id.length + (service.name?.length ?? 0) + (service.root?.length ?? 0) + (service.error?.length ?? 0) +
      (extensions?.reduce((total, extension) => total + extension.length, 0) ?? 0)
    if (characters > 1_000_000) break
    services.push(service)
  }
  return services
}

function normalizeRuntime(path: unknown, vcs: unknown, lsp: unknown, formatter: unknown, mcp: unknown): RuntimeStatus {
  const pathRecord = record(path) ? path : undefined
  const vcsRecord = record(vcs) ? vcs : undefined
  return {
    path: pathRecord
      ? {
          home: boundedRuntimeString(pathRecord.home, 8_192),
          state: boundedRuntimeString(pathRecord.state, 8_192),
          config: boundedRuntimeString(pathRecord.config, 8_192),
          worktree: boundedRuntimeString(pathRecord.worktree, 8_192),
          directory: boundedRuntimeString(pathRecord.directory, 8_192),
        }
      : undefined,
    vcs: vcsRecord ? { branch: boundedRuntimeString(vcsRecord.branch, 2_000) } : undefined,
    lsp: runtimeServices(lsp),
    formatters: runtimeServices(formatter),
    mcp: runtimeServices(mcp, true),
    updatedAt: Date.now(),
  }
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), 1_000_000_000_000) : 0
}

function tokenCounts(value: unknown): Omit<ContextSummary, "contextLimit" | "inputLimit" | "outputLimit" | "model" | "usagePercent" | "cost"> | undefined {
  if (!record(value)) return undefined
  const cache = record(value.cache) ? value.cache : undefined
  const inputTokens = count(value.input)
  const outputTokens = count(value.output)
  const reasoningTokens = count(value.reasoning)
  const cacheReadTokens = count(value.cacheRead ?? cache?.read)
  const cacheWriteTokens = count(value.cacheWrite ?? cache?.write)
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens,
  }
}

function finiteCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, 1_000_000_000_000) : undefined
}

function deriveContext(messages: WorkbenchState["sessions"][string]["messages"], models: ModelOption[], fallbackModel?: ModelOption, sessionCost?: number): ContextSummary | undefined {
  const assistant = messages.slice().reverse().find((entry) => entry.info.role === "assistant" &&
    (entry.info.time?.completed !== undefined || tokenCounts(entry.info.tokens) !== undefined || entry.parts.some((part) => part.type === "step-finish" && tokenCounts(part.tokens) !== undefined)))
  if (!assistant) return undefined
  const finish = assistant.parts.slice().reverse().find((part) => part.type === "step-finish")
  const tokens = tokenCounts(finish?.tokens) ?? tokenCounts(assistant.info.tokens)
  if (!tokens) return undefined
  let cost = finiteCost(sessionCost) ?? 0
  if (finiteCost(sessionCost) === undefined) for (const entry of messages) {
    if (entry.info.role !== "assistant") continue
    const messageCost = finiteCost(entry.info.cost)
    if (messageCost !== undefined) cost = Math.min(1_000_000_000_000, cost + messageCost)
    else for (const part of entry.parts) if (part.type === "step-finish") cost = Math.min(1_000_000_000_000, cost + (finiteCost(part.cost) ?? 0))
  }
  const providerID = typeof assistant.info.providerID === "string" ? assistant.info.providerID : undefined
  const modelID = typeof assistant.info.modelID === "string" ? assistant.info.modelID : undefined
  const model = providerID && modelID ? models.find((candidate) => candidate.providerID === providerID && candidate.id === modelID) : fallbackModel
  const contextLimit = model?.contextLimit
  return {
    ...tokens,
    cost,
    contextLimit,
    inputLimit: model?.inputLimit,
    outputLimit: model?.outputLimit,
    model: model ? `${model.providerID}/${model.id}` : providerID && modelID ? `${providerID}/${modelID}` : undefined,
    usagePercent: contextLimit ? Math.min(100, tokens.totalTokens / contextLimit * 100) : undefined,
  }
}

const GOAL_TOOLS = new Set([
  "get_goal",
  "get_goal_history",
  "create_goal",
  "set_goal",
  "update_goal",
  "update_goal_status",
  "update_goal_objective",
  "clear_goal",
])

function parsedGoal(output: unknown): GoalSummary | undefined {
  if (typeof output !== "string" || output.length === 0 || output.length > 64 * 1024) return undefined
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!record(value)) return undefined
  const goal = record(value.goal) ? value.goal : value
  const text = (key: string, limit = 20_000) => typeof goal[key] === "string" && goal[key].length <= limit ? goal[key] : undefined
  const integer = (key: string) => Number.isSafeInteger(goal[key]) && Number(goal[key]) >= 0 ? Number(goal[key]) : undefined
  const checkpoint = record(goal.lastCheckpoint) ? textFromRecord(goal.lastCheckpoint, "summary", 20_000) : undefined
  const result: GoalSummary = {
    sourceTool: "goal",
    objective: text("objective"),
    status: text("status", 100),
    tokenBudget: integer("tokenBudget"),
    tokensUsed: integer("tokensUsed"),
    remainingTokens: integer("remainingTokens"),
    timeUsedSeconds: integer("timeUsedSeconds"),
    maxDurationSeconds: integer("maxDurationSeconds"),
    autoTurns: integer("autoTurns"),
    maxAutoTurns: integer("maxAutoTurns"),
    lastStatus: text("lastStatus"),
    stopReason: text("stopReason"),
    checkpoint,
    completionEvidence: text("completionEvidence"),
    blocker: text("blocker"),
  }
  return result.objective !== undefined || result.status !== undefined ? result : undefined
}

function textFromRecord(value: JsonRecord, key: string, limit: number): string | undefined {
  const item = value[key]
  return typeof item === "string" && item.length <= limit ? item : undefined
}

function deriveGoal(messages: WorkbenchState["sessions"][string]["messages"]): GoalSummary | undefined {
  let summary: GoalSummary | undefined
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool || !GOAL_TOOLS.has(part.tool) ||
        (part.state?.status !== "completed" && part.state?.status !== "complete")) continue
      if (part.tool === "clear_goal") {
        summary = undefined
        continue
      }
      const parsed = parsedGoal(part.state?.output)
      if (!parsed) continue
      summary = {
        ...summary,
        ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)),
        sourceTool: part.tool,
      }
    }
  }
  return summary
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", aborted, { once: true })
  })
}

function mergeTranscripts(server: WorkbenchState["sessions"][string]["messages"], current: WorkbenchState["sessions"][string]["messages"]) {
  const merged = server.map((message) => ({ ...message, parts: message.parts.slice() }))
  for (const live of current) {
    const index = merged.findIndex((message) => message.info.id === live.info.id)
    if (index < 0) {
      merged.push(live)
      continue
    }
    const base = merged[index]!
    const parts = base.parts.slice()
    for (const part of live.parts) {
      const partIndex = parts.findIndex((candidate) => candidate.id === part.id)
      if (partIndex < 0) parts.push(part)
      else parts[partIndex] = part
    }
    merged[index] = { info: { ...base.info, ...live.info }, parts }
  }
  return merged
}

function descendantSessions(state: WorkbenchState, parentID: string): WorkbenchState["sessions"][string][] {
  const children = new Map<string, WorkbenchState["sessions"][string][]>()
  for (const session of Object.values(state.sessions)) {
    const parent = session.info.parentID
    if (!parent) continue
    const values = children.get(parent) ?? []
    values.push(session)
    children.set(parent, values)
  }
  const output: WorkbenchState["sessions"][string][] = []
  const queue = [parentID]
  const visited = new Set(queue)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parent = queue[cursor]!
    for (const session of children.get(parent) ?? []) {
      if (visited.has(session.info.id)) continue
      visited.add(session.info.id)
      output.push(session)
      queue.push(session.info.id)
    }
  }
  return output
}

function rejectOnlyPermission(request: PermissionRequest): PermissionRequest {
  return { id: request.id, sessionID: request.sessionID, title: request.title, type: request.type, protocol: request.protocol, truncated: true }
}

function boundedPermissionList(requests: PermissionRequest[]): PermissionRequest[] {
  const output: PermissionRequest[] = []
  let characters = 0
  for (const request of requests) {
    if (output.length >= 100) break
    let safe = request
    let size = permissionRequestCharacters(safe)
    if (characters + size > PERMISSION_AGGREGATE_CHARACTER_LIMIT) {
      safe = rejectOnlyPermission(request)
      size = permissionRequestCharacters(safe)
    }
    if (characters + size > PERMISSION_AGGREGATE_CHARACTER_LIMIT) break
    output.push(safe)
    characters += size
  }
  return output
}

export class SessionController {
  private state: WorkbenchState = initialWorkbenchState
  private readonly listeners = new Set<(update: ControllerUpdate) => void>()
  private stream?: AbortController
  private disposed = false
  private readonly respondingPermissions = new Set<string>()
  private readonly respondingQuestions = new Set<string>()
  private permissionRevision = 0
  private permissionGeneration = 0
  private agents: AgentOption[] = []
  private models: ModelOption[] = []
  private commands: CommandOption[] = []
  private defaultAgent?: string
  private defaultModel?: string
  private defaultVariant?: string
  private currentAgent?: string
  private lastModel?: string
  private readonly modelVariants = new Map<string, string | undefined>()
  private runtime?: RuntimeStatus
  private runtimeGeneration = 0
  private runtimeRefreshTimer?: NodeJS.Timeout
  private reconcileGeneration = 0
  private sessionRevision = 0
  private statusRevision = 0
  private readonly transcriptRevisions = new Map<string, number>()
  private readonly transcriptGenerations = new Map<string, number>()
  private readonly transcriptRefreshTimers = new Map<string, NodeJS.Timeout>()
  private readonly removedMessages = new Map<string, Map<string, number>>()
  private readonly removedParts = new Map<string, Map<string, number>>()
  private readonly sendGenerations = new Map<string, number>()
  private readonly drainingQueues = new Set<string>()
  private readonly sendingPrompts = new Map<string, string>()
  private readonly steeringPrompts = new Set<string>()
  private readonly promptFiles = new Map<string, PromptFilePart[]>()
  private readonly promptAgents = new Map<string, string[]>()
  private promptAdmissionPaused = false
  private readonly messageRevisions = new Map<string, Map<string, number>>()
  private readonly todoRevisions = new Map<string, number>()
  private readonly todoGenerations = new Map<string, number>()
  private readonly changeGenerations = new Map<string, number>()
  private readonly changeRevisions = new Map<string, number>()
  private questionGeneration = 0
  private questionRevision = 0
  private selectionIntent = 0
  private mentionAgents: AgentOption[] = []
  private providers: ProviderOption[] = []
  private resources: ResourceOption[] = []
  private catalog: NonNullable<ChatSnapshot["catalog"]> = { status: "error" }

  constructor(
    private readonly client: OpenCodeClient,
    private readonly callbacks: ControllerCallbacks,
    preferences?: ComposerPreferences,
  ) {
    if (typeof preferences?.currentAgent === "string" && preferences.currentAgent.length <= 1_024) this.currentAgent = preferences.currentAgent
    if (typeof preferences?.lastModel === "string" && preferences.lastModel.length <= 1_024) this.lastModel = preferences.lastModel
    if (!this.lastModel) {
      const legacy = preferences?.agentModels?.find(([agent]) => agent === this.currentAgent) ?? preferences?.agentModels?.at(-1)
      if (legacy && legacy.every((value) => typeof value === "string" && value.length <= 1_024)) this.lastModel = legacy[1]
    }
    for (const entry of preferences?.modelVariants?.slice(0, 500) ?? []) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0].length > 1_024 ||
        (entry[1] !== null && (typeof entry[1] !== "string" || entry[1].length > 1_024))) continue
      this.modelVariants.set(entry[0], entry[1] ?? undefined)
    }
  }

  get snapshot(): WorkbenchState {
    return this.state
  }

  canAttachWorkspaceFiles(): boolean {
    return this.client.canReadLocalFiles()
  }

  resourceAttachment(uri: string): PromptFilePart | undefined {
    const resource = this.resources.find((candidate) => candidate.uri === uri)
    return resource ? { type: "file", mime: resource.mimeType ?? "text/plain", url: resource.uri, filename: resource.name.slice(0, 255) } : undefined
  }

  planFileName(sessionID: string): string | undefined {
    const info = this.state.sessions[sessionID]?.info
    const slug = typeof info?.slug === "string" && /^[A-Za-z0-9._-]{1,255}$/.test(info.slug) ? info.slug : undefined
    const created = info?.time.created
    return slug && Number.isSafeInteger(created) && Number(created) >= 0 ? `${created}-${slug}.md` : undefined
  }

  mentionedAgents(text: string): string[] {
    const names = new Set<string>()
    for (const match of text.matchAll(/(?:^|[\s(])@([A-Za-z0-9._-]+)/g)) {
      if (this.mentionAgents.some((agent) => agent.name === match[1])) names.add(match[1]!)
    }
    return [...names].slice(0, 20)
  }

  subscribe(listener: (update: ControllerUpdate) => void): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  start(): void {
    if (this.stream || this.disposed) return
    this.stream = new AbortController()
    void this.runEventLoop(this.stream.signal)
  }

  reconnect(): void {
    this.client.cancelPendingRequests?.()
    this.stream?.abort()
    this.stream = undefined
    this.reconcileGeneration += 1
    this.permissionGeneration += 1
    this.questionGeneration += 1
    for (const [sessionID, generation] of this.transcriptGenerations) {
      this.transcriptGenerations.set(sessionID, generation + 1)
    }
    this.dispatch({ type: "connected", connected: false })
    this.start()
  }

  dispose(): void {
    this.disposed = true
    this.permissionGeneration += 1
    this.questionGeneration += 1
    this.stream?.abort()
    this.stream = undefined
    this.client.cancelPendingRequests?.()
    if (this.runtimeRefreshTimer) clearTimeout(this.runtimeRefreshTimer)
    for (const timer of this.transcriptRefreshTimers.values()) clearTimeout(timer)
    this.transcriptRefreshTimers.clear()
    this.promptFiles.clear()
    this.promptAgents.clear()
    this.listeners.clear()
  }

  private notify(update: ControllerUpdate): void {
    for (const listener of this.listeners) listener(update)
  }

  private dispatch(action: ControllerUpdate): void {
    const next = sessionReducer(this.state, action)
    if (next === this.state) return
    this.state = next
    this.notify(action)
  }

  private async readRuntime(): Promise<RuntimeStatus> {
    const values = await Promise.all([
      this.client.path?.() ?? Promise.resolve(undefined),
      this.client.vcs?.() ?? Promise.resolve(undefined),
      this.client.lsp?.() ?? Promise.resolve(undefined),
      this.client.formatter?.() ?? Promise.resolve(undefined),
      this.client.mcp?.() ?? Promise.resolve(undefined),
    ].map((request) => Promise.resolve(request).catch(() => undefined)))
    return normalizeRuntime(...values as [unknown, unknown, unknown, unknown, unknown])
  }

  private async refreshRuntime(): Promise<void> {
    const generation = ++this.runtimeGeneration
    const runtime = await this.readRuntime()
    if (this.disposed || generation !== this.runtimeGeneration) return
    this.runtime = runtime
    this.notify({ type: "connected", connected: this.state.connected })
  }

  messageUpdateKey(update: ControllerUpdate): { sessionID: string; messageID: string } | undefined {
    if (update.type !== "event" || !["message.updated", "message.part.updated"].includes(update.event.type)) return undefined
    const info = update.event.properties.info
    const part = update.event.properties.part
    if (record(part) && part.type === "tool" && typeof part.tool === "string" && GOAL_TOOLS.has(part.tool) && record(part.state) &&
      (part.state.status === "completed" || part.state.status === "complete")) return undefined
    const sessionID = record(info) && typeof info.sessionID === "string"
      ? info.sessionID
      : record(part) && typeof part.sessionID === "string" ? part.sessionID : undefined
    const messageID = record(info) && typeof info.id === "string"
      ? info.id
      : record(part) && typeof part.messageID === "string" ? part.messageID : undefined
    return sessionID && messageID && sessionID === this.state.selectedID ? { sessionID, messageID } : undefined
  }

  messagePatches(keys: Array<{ sessionID: string; messageID: string }>): MessagePatch[] | undefined {
    if (keys.length > 100) return undefined
    const patches: MessagePatch[] = []
    let characters = 0
    for (const { sessionID, messageID } of keys) {
      const session = this.state.sessions[sessionID]
      if (!session || this.state.selectedID !== sessionID) continue
      const index = session.messages.findIndex((entry) => entry.info.id === messageID)
      const message = index < 0 ? undefined : session.messages[index]
      const safe = message ? snapshotMessage(message) : undefined
      const nextCharacters = characters + (safe?.parts.reduce((total, part) => total + snapshotPartCharacters(part), 0) ?? 0)
      if (nextCharacters > 3_800_000) return undefined
      characters = nextCharacters
      patches.push({
        sessionID,
        messageID,
        message: safe,
        revision: this.messageRevisions.get(sessionID)?.get(messageID) ?? 0,
        active: session.status.type === "busy" || session.status.type === "retry",
        append: index === session.messages.length - 1,
        afterMessageID: index > 0 ? session.messages[index - 1]?.info.id : undefined,
      })
    }
    return patches
  }

  private updateDraft(sessionID: string, draft: string): void {
    this.dispatch({ type: "draft", sessionID, draft })
  }

  private validAgent(name?: string): name is string {
    return Boolean(name && this.agents.some((agent) => agent.name === name))
  }

  private validModel(value?: string): value is string {
    return Boolean(value && this.models.some((model) => `${model.providerID}/${model.id}` === value))
  }

  private modelForAgent(agent?: string): string | undefined {
    const configured = this.agents.find((candidate) => candidate.name === agent)?.model
    const configuredValue = configured ? `${configured.providerID}/${configured.modelID}` : undefined
    if (this.validModel(configuredValue)) return configuredValue
    return this.validModel(this.lastModel) ? this.lastModel : this.defaultModel
  }

  private requiresLegacyPromptTransport(agent?: string, model?: string): boolean {
    const effectiveAgent = this.validAgent(agent) ? agent : this.currentAgent ?? this.defaultAgent
    const effectiveModel = this.validModel(model) ? model : this.modelForAgent(effectiveAgent)
    const separator = effectiveModel?.indexOf("/") ?? -1
    if (!effectiveModel || separator <= 0) return false
    const providerID = effectiveModel.slice(0, separator)
    return this.providers.find((provider) => provider.id === providerID)?.source === "custom"
  }

  private persistPreferences(): void {
    this.callbacks.preferencesChanged?.({
      currentAgent: this.currentAgent,
      lastModel: this.lastModel,
      modelVariants: [...this.modelVariants].map(([key, value]) => [key, value ?? null]),
    })
  }

  private rememberPreference(agent?: string, model?: string, variant?: string, rememberVariant = false): void {
    let changed = false
    if (this.validAgent(agent) && this.currentAgent !== agent) {
      this.currentAgent = agent
      changed = true
    }
    if (!this.validModel(model)) {
      if (changed) this.persistPreferences()
      return
    }
    if (this.lastModel !== model) {
      this.lastModel = model
      changed = true
    }
    if ((rememberVariant || variant !== undefined) && (!this.modelVariants.has(model) || this.modelVariants.get(model) !== (variant || undefined))) {
      this.modelVariants.set(model, variant || undefined)
      changed = true
    }
    if (changed) this.persistPreferences()
  }

  private validatePreference(agent?: string, model?: string, variant?: string): void {
    if (agent && !this.validAgent(agent)) throw new Error("Unknown OpenCode agent")
    if (model && !this.validModel(model)) throw new Error("Unknown OpenCode model")
    if (!variant) return
    const session = this.state.selectedID ? this.state.sessions[this.state.selectedID] : undefined
    const effectiveAgent = agent || session?.agent || this.currentAgent || this.defaultAgent
    const effectiveModel = model === "" ? this.modelForAgent(effectiveAgent) : model || session?.model || this.modelForAgent(effectiveAgent)
    const selectedModel = this.models.find((candidate) => `${candidate.providerID}/${candidate.id}` === effectiveModel)
    if (!selectedModel?.variants?.includes(variant)) throw new Error("Unknown reasoning level for the selected model")
  }

  private bumpMessageRevision(sessionID: string, messageID: string): void {
    const revisions = this.messageRevisions.get(sessionID) ?? new Map<string, number>()
    revisions.set(messageID, (revisions.get(messageID) ?? 0) + 1)
    this.messageRevisions.set(sessionID, revisions)
  }

  private refreshMessageRevisions(sessionID: string, messages: WorkbenchState["sessions"][string]["messages"]): void {
    const revisions = this.messageRevisions.get(sessionID) ?? new Map<string, number>()
    const current = new Set(messages.map((entry) => entry.info.id))
    for (const entry of messages) revisions.set(entry.info.id, (revisions.get(entry.info.id) ?? 0) + 1)
    for (const messageID of revisions.keys()) if (!current.has(messageID)) revisions.delete(messageID)
    this.messageRevisions.set(sessionID, revisions)
  }

  private async runEventLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted) {
      try {
        await this.client.events(
          signal,
          async () => {
            attempt = 0
            this.dispatch({ type: "connected", connected: true })
            await this.reconcile()
            await this.reconcilePermissions().catch((error) => this.callbacks.error(`Could not reconcile permission requests: ${message(error)}`))
            await this.reconcileQuestions().catch((error) => this.callbacks.error(`Could not reconcile questions: ${message(error)}`))
          },
          (event) => {
            if (!signal.aborted) this.handleEvent(event)
          },
        )
      } catch (error) {
        if (signal.aborted) return
        this.dispatch({ type: "connected", connected: false })
        if (attempt === 0) this.callbacks.error(message(error))
        attempt += 1
        try {
          await delay(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)), signal)
        } catch {
          return
        }
      }
    }
  }

  async reconcile(): Promise<void> {
    const generation = ++this.reconcileGeneration
    const runtimeGeneration = ++this.runtimeGeneration
    const sessionRevision = this.sessionRevision
    const statusRevision = this.statusRevision
    let catalogError: string | undefined
    const [sessions, statuses, catalogs, commands, runtime] = await Promise.all([
      this.client.listSessions(),
      this.client.sessionStatuses(),
      this.client.catalogs().catch((error) => {
        catalogError = message(error)
        return { agents: this.agents, mentionAgents: this.mentionAgents, providers: this.providers, models: this.models, resources: this.resources, defaults: { agent: this.defaultAgent, model: this.defaultModel, variant: this.defaultVariant } }
      }),
      this.client.commands?.().catch(() => this.commands) ?? Promise.resolve(this.commands),
      this.readRuntime(),
    ])
    if (this.disposed || generation !== this.reconcileGeneration) return
    if (sessionRevision !== this.sessionRevision) {
      void this.reconcile()
      return
    }
    this.agents = catalogs.agents
    this.mentionAgents = catalogs.mentionAgents ?? []
    this.providers = catalogs.providers ?? []
    this.models = catalogs.models
    this.resources = catalogs.resources ?? []
    this.catalog = catalogError
      ? { status: this.models.length ? "stale" : "error", updatedAt: this.catalog.updatedAt, error: catalogError.slice(0, 20_000) }
      : { status: "ready", updatedAt: Date.now() }
    this.defaultAgent = catalogs.defaults?.agent
    this.defaultModel = catalogs.defaults?.model
    this.defaultVariant = catalogs.defaults?.variant
    if (!this.validAgent(this.currentAgent)) this.currentAgent = this.defaultAgent
    let changedPreferences = false
    if (this.lastModel && !this.validModel(this.lastModel)) {
      this.lastModel = undefined
      changedPreferences = true
    }
    for (const [model, variant] of this.modelVariants) {
      const option = this.models.find((candidate) => `${candidate.providerID}/${candidate.id}` === model)
      if (!option || (variant && !option.variants?.includes(variant))) {
        this.modelVariants.delete(model)
        changedPreferences = true
      }
    }
    if (changedPreferences) this.persistPreferences()
    this.commands = commands
    if (runtimeGeneration === this.runtimeGeneration) this.runtime = runtime
    const effectiveStatuses = statusRevision === this.statusRevision
      ? statuses
      : Object.fromEntries(Object.entries(this.state.sessions).map(([id, session]) => [id, session.status]))
    const retained = new Set(sessions.map((session) => session.id))
    for (const id of this.state.order) if (!retained.has(id)) this.cleanupSession(id)
    this.dispatch({ type: "reconcile", sessions, statuses: effectiveStatuses })
    for (const id of this.state.order) if (this.state.sessions[id]?.status.type === "idle" && this.state.sessions[id]!.queue.length) void this.drainQueue(id)
    const refreshIDs = this.state.order.filter((id) =>
      id === this.state.selectedID ||
      this.state.sessions[id]?.loaded ||
      effectiveStatuses[id]?.type === "busy" ||
      effectiveStatuses[id]?.type === "retry",
    )
    await Promise.allSettled([
      ...refreshIDs.map((id) => this.loadTranscript(id)),
      ...refreshIDs.map((id) => this.loadChanges(id)),
      ...refreshIDs.map((id) => this.loadTodos(id)),
    ])
    if (this.state.selectedID) await this.loadDelegationTranscripts(this.state.selectedID)
  }

  async refresh(): Promise<void> {
    if (await this.client.disposeInstance() !== true) throw new Error("OpenCode did not refresh the workspace instance")
    this.reconnect()
  }

  async manageMcp(sessionID: string, name: string, action: "connect" | "disconnect" | "authenticate" | "removeAuth"): Promise<void> {
    this.requireSession(sessionID)
    if (!this.runtime?.mcp.some((service) => service.id === name)) throw new Error("MCP server is no longer available")
    const accepted = await this.client.mcpAction(name, action)
    if ((action === "connect" || action === "disconnect") && accepted !== true) throw new Error(`OpenCode did not ${action} the MCP server`)
    await this.refreshRuntime()
  }

  private async reconcilePermissions(): Promise<void> {
    const generation = ++this.permissionGeneration
    const revision = this.permissionRevision
    let requests: PermissionRequest[]
    let succeeded: Array<"current" | "v2"> = ["current", "v2"]
    try {
      if (typeof this.client.pendingPermissionsDetailed === "function") {
        const result = await this.client.pendingPermissionsDetailed()
        requests = result.requests
        succeeded = result.succeeded
      } else requests = await this.client.pendingPermissions()
    } catch (error) {
      if (this.disposed || generation !== this.permissionGeneration) return
      throw error
    }
    if (this.disposed || generation !== this.permissionGeneration) return
    if (revision !== this.permissionRevision) {
      void this.reconcilePermissions().catch((error) => this.callbacks.error(`Could not reconcile permission requests: ${message(error)}`))
      return
    }
    const grouped = new Map<string, PermissionRequest[]>()
    const characters = new Map<string, number>()
    for (const sessionID of this.state.order) {
      const retained = this.state.sessions[sessionID]?.permissions.filter((request) =>
        request.protocol === "legacy" || !succeeded.includes(request.protocol)
      ) ?? []
      grouped.set(sessionID, retained)
      characters.set(sessionID, retained.reduce((total, request) => total + permissionRequestCharacters(request), 0))
    }
    for (const request of requests.slice(0, 10_000)) {
      if (!Object.hasOwn(this.state.sessions, request.sessionID)) continue
      const values = grouped.get(request.sessionID) ?? []
      const requestCharacters = permissionRequestCharacters(request)
      const nextCharacters = (characters.get(request.sessionID) ?? 0) + requestCharacters
      if (values.length < 100 && !values.some((candidate) => candidate.id === request.id && candidate.protocol === request.protocol)) {
        const safe = nextCharacters <= PERMISSION_AGGREGATE_CHARACTER_LIMIT ? request : rejectOnlyPermission(request)
        const safeCharacters = (characters.get(request.sessionID) ?? 0) + permissionRequestCharacters(safe)
        if (safeCharacters <= PERMISSION_AGGREGATE_CHARACTER_LIMIT) {
          values.push(safe)
          characters.set(request.sessionID, safeCharacters)
        }
      }
      grouped.set(request.sessionID, values)
    }
    for (const sessionID of this.state.order) this.dispatch({ type: "permissions", sessionID, permissions: grouped.get(sessionID) ?? [] })
    for (const requests of grouped.values()) for (const request of requests) this.maybeAutoRespond(request)
  }

  private async reconcileQuestions(): Promise<void> {
    if (!this.client.pendingQuestions) return
    const generation = ++this.questionGeneration
    const revision = this.questionRevision
    const result = typeof this.client.pendingQuestionsDetailed === "function"
      ? await this.client.pendingQuestionsDetailed()
      : { requests: await this.client.pendingQuestions(), succeeded: ["legacy" as const, "v2" as const] }
    if (this.disposed || generation !== this.questionGeneration) return
    if (revision !== this.questionRevision) {
      void this.reconcileQuestions().catch((error) => this.callbacks.error(`Could not reconcile questions: ${message(error)}`))
      return
    }
    const grouped = new Map<string, QuestionRequest[]>()
    for (const sessionID of this.state.order) {
      grouped.set(sessionID, this.state.sessions[sessionID]?.questions.filter((request) => !result.succeeded.includes(request.protocol)) ?? [])
    }
    for (const request of result.requests) {
      if (!Object.hasOwn(this.state.sessions, request.sessionID)) continue
      const values = grouped.get(request.sessionID) ?? []
      if (values.length < 100 && !values.some((candidate) => candidate.id === request.id)) values.push(request)
      grouped.set(request.sessionID, values)
    }
    for (const sessionID of this.state.order) this.dispatch({ type: "questions", sessionID, questions: grouped.get(sessionID) ?? [] })
  }

  async createSession(title?: string, draft?: string): Promise<string> {
    const intent = ++this.selectionIntent
    const session = await this.client.createSession(title)
    this.sessionRevision += 1
    this.dispatch({ type: "event", event: { type: "session.created", properties: { info: session } } })
    if (draft) this.updateDraft(session.id, draft)
    if (intent === this.selectionIntent) await this.selectKnown(session.id)
    return session.id
  }

  async createSessionWithPrompt(text: string): Promise<string> {
    if (!text.trim() || text.length > PROMPT_TEXT_CHARACTER_LIMIT) throw new Error("Prompt must contain text")
    const sessionID = await this.createSession(undefined, text)
    if (this.state.selectedID !== sessionID) throw new Error("Session selection changed while creating the conversation")
    const composer = this.chatSnapshot().session
    await this.send(text, composer?.agent, composer?.model, composer?.variant)
    return sessionID
  }

  async deleteSession(sessionID: string): Promise<void> {
    if (await this.client.deleteSession(sessionID) !== true) throw new Error("OpenCode did not delete the session")
    this.sessionRevision += 1
    const info = this.state.sessions[sessionID]?.info
    this.cleanupSession(sessionID)
    if (info) this.dispatch({ type: "event", event: { type: "session.deleted", properties: { info } } })
    const selectedID = this.state.selectedID
    if (selectedID && !this.state.sessions[selectedID]?.loaded) await this.loadTranscript(selectedID)
  }

  async renameSession(sessionID: string, title: string): Promise<void> {
    this.requireSession(sessionID)
    const value = title.trim()
    if (!value || value.length > 2_000) throw new Error("Session title must contain between 1 and 2,000 characters")
    const info = await this.client.renameSession(sessionID, value)
    this.sessionRevision += 1
    this.dispatch({ type: "event", event: { type: "session.updated", properties: { info } } })
  }

  async forkSession(sessionID: string): Promise<string> {
    this.requireSession(sessionID)
    const info = await this.client.forkSession(sessionID)
    this.sessionRevision += 1
    this.dispatch({ type: "event", event: { type: "session.created", properties: { info } } })
    await this.selectKnown(info.id)
    return info.id
  }

  async undoSession(sessionID: string): Promise<void> {
    const session = this.requireSession(sessionID)
    const messageID = session.messages.slice().reverse().find((entry) => entry.info.role === "user")?.info.id
    if (!messageID) throw new Error("This session has no user message to undo")
    const info = await this.client.revertSession(sessionID, messageID)
    this.sessionRevision += 1
    this.dispatch({ type: "event", event: { type: "session.updated", properties: { info } } })
    await this.reloadSession(sessionID)
  }

  async redoSession(sessionID: string): Promise<void> {
    this.requireSession(sessionID)
    const info = await this.client.unrevertSession(sessionID)
    this.sessionRevision += 1
    this.dispatch({ type: "event", event: { type: "session.updated", properties: { info } } })
    await this.reloadSession(sessionID)
  }

  async compactSession(sessionID: string): Promise<void> {
    const session = this.requireSession(sessionID)
    const model = session.model
    const separator = model?.indexOf("/") ?? -1
    if (!model || separator <= 0 || separator === model.length - 1) throw new Error("Select a model before compacting this session")
    if (await this.client.summarizeSession(sessionID, model.slice(0, separator), model.slice(separator + 1)) !== true) {
      throw new Error("OpenCode did not compact the session")
    }
  }

  async shareSession(sessionID: string): Promise<string | undefined> {
    this.requireSession(sessionID)
    const info = await this.client.shareSession(sessionID)
    this.sessionRevision += 1
    this.dispatch({ type: "event", event: { type: "session.updated", properties: { info } } })
    const share = record(info.share) ? info.share : undefined
    return typeof share?.url === "string" && share.url.length <= 8_192 ? share.url : undefined
  }

  async unshareSession(sessionID: string): Promise<void> {
    this.requireSession(sessionID)
    const info = await this.client.unshareSession(sessionID)
    this.sessionRevision += 1
    this.dispatch({ type: "event", event: { type: "session.updated", properties: { info } } })
  }

  private async reloadSession(sessionID: string): Promise<void> {
    const [messages, changes] = await Promise.all([
      this.client.messages(sessionID),
      this.client.changes?.(sessionID) ?? Promise.resolve([] as FileChange[]),
    ])
    if (!Object.hasOwn(this.state.sessions, sessionID)) return
    this.refreshMessageRevisions(sessionID, messages)
    this.dispatch({ type: "transcript", sessionID, messages })
    this.dispatch({ type: "changes", sessionID, changes })
  }

  async select(sessionID: string): Promise<void> {
    if (!Object.hasOwn(this.state.sessions, sessionID)) throw new Error("Unknown OpenCode session")
    this.selectionIntent += 1
    await this.selectKnown(sessionID)
  }

  private async selectKnown(sessionID: string): Promise<void> {
    this.dispatch({ type: "select", sessionID })
    await Promise.allSettled([
      this.state.sessions[sessionID]?.loaded ? Promise.resolve() : this.loadTranscript(sessionID),
      this.loadTodos(sessionID),
      this.loadChanges(sessionID),
    ])
    await this.loadDelegationTranscripts(sessionID)
  }

  private async loadDelegationTranscripts(parentID: string): Promise<void> {
    const parent = this.state.sessions[parentID]
    if (!parent) return
    const sessionIDs = parent.messages.flatMap((message) => message.parts.map(delegationSessionID)).filter((value): value is string => Boolean(value))
    const unique = [...new Set(sessionIDs)].slice(-20)
    await Promise.allSettled(unique.map((sessionID) => {
      const child = this.state.sessions[sessionID]
      return child && !child.loaded ? this.loadTranscript(sessionID) : Promise.resolve()
    }))
  }

  private async loadTranscript(sessionID: string, markLoading = true): Promise<void> {
    const generation = (this.transcriptGenerations.get(sessionID) ?? 0) + 1
    this.transcriptGenerations.set(sessionID, generation)
    const revision = this.transcriptRevisions.get(sessionID) ?? 0
    if (markLoading) this.dispatch({ type: "transcriptLoading", sessionID })
    let messages: MessageBundle[]
    try {
      messages = await this.client.messages(sessionID)
    } catch (error) {
      if (markLoading && this.transcriptGenerations.get(sessionID) === generation && Object.hasOwn(this.state.sessions, sessionID)) {
        this.dispatch({ type: "transcriptError", sessionID })
      }
      throw error
    }
    if (this.transcriptGenerations.get(sessionID) !== generation) return
    const current = this.state.sessions[sessionID]
    if (!current) return
    let transcript = (this.transcriptRevisions.get(sessionID) ?? 0) === revision
      ? messages
      : mergeTranscripts(messages, current.messages)
    const removedMessages = this.removedMessages.get(sessionID)
    const removedParts = this.removedParts.get(sessionID)
    transcript = transcript
      .filter((message) => (removedMessages?.get(message.info.id) ?? 0) <= revision)
      .map((message) => ({
        ...message,
        parts: message.parts.filter((part) => (removedParts?.get(`${message.info.id}:${part.id}`) ?? 0) <= revision),
      }))
    this.refreshMessageRevisions(sessionID, transcript)
    this.dispatch({ type: "transcript", sessionID, messages: transcript })
    for (const [id, removedAt] of removedMessages ?? []) if (removedAt <= revision) removedMessages?.delete(id)
    for (const [id, removedAt] of removedParts ?? []) if (removedAt <= revision) removedParts?.delete(id)
    const lastUser = messages.slice().reverse().find((entry) => entry.info.role === "user")?.info
    const model = lastUser?.model
    const modelRecord = model && typeof model === "object" ? model as Record<string, unknown> : undefined
    const inferredModel = modelRecord && typeof modelRecord.providerID === "string" && typeof modelRecord.modelID === "string"
      ? `${modelRecord.providerID}/${modelRecord.modelID}`
      : undefined
    const inferredVariant = modelRecord && typeof modelRecord.variant === "string" ? modelRecord.variant : undefined
    const inferredAgent = typeof lastUser?.agent === "string" ? lastUser.agent : undefined
    if ((!current.agent && inferredAgent) || (!current.model && inferredModel) || (!current.variant && inferredVariant)) {
      this.dispatch({
        type: "preference",
        sessionID,
        agent: current.agent ? undefined : inferredAgent,
        model: current.model ? undefined : inferredModel,
        variant: current.variant ? undefined : inferredVariant,
      })
    }
  }

  private scheduleTranscriptRefresh(sessionID: string): void {
    const existing = this.transcriptRefreshTimers.get(sessionID)
    if (existing) clearTimeout(existing)
    this.transcriptRefreshTimers.set(sessionID, setTimeout(() => {
      this.transcriptRefreshTimers.delete(sessionID)
      void this.loadTranscript(sessionID, false).catch((error) => this.callbacks.error(`Could not refresh OpenCode transcript: ${message(error)}`))
    }, 25))
  }

  private async loadTodos(sessionID: string): Promise<void> {
    if (!this.client.todos) return
    const generation = (this.todoGenerations.get(sessionID) ?? 0) + 1
    this.todoGenerations.set(sessionID, generation)
    const revision = this.todoRevisions.get(sessionID) ?? 0
    const todos = await this.client.todos(sessionID)
    if (this.todoGenerations.get(sessionID) !== generation || (this.todoRevisions.get(sessionID) ?? 0) !== revision ||
      !Object.hasOwn(this.state.sessions, sessionID)) return
    this.dispatch({ type: "todos", sessionID, todos })
  }

  private async loadChanges(sessionID: string): Promise<void> {
    if (!this.client.changes) return
    const generation = (this.changeGenerations.get(sessionID) ?? 0) + 1
    this.changeGenerations.set(sessionID, generation)
    const revision = this.changeRevisions.get(sessionID) ?? 0
    const changes = await this.client.changes(sessionID)
    if (this.changeGenerations.get(sessionID) !== generation || (this.changeRevisions.get(sessionID) ?? 0) !== revision ||
      !Object.hasOwn(this.state.sessions, sessionID)) return
    this.dispatch({ type: "changes", sessionID, changes })
  }

  setDraft(draft: string): void {
    const sessionID = this.state.selectedID
    if (sessionID) this.updateDraft(sessionID, draft)
  }

  setPromptAdmissionPaused(paused: boolean): void {
    if (this.promptAdmissionPaused === paused) return
    this.promptAdmissionPaused = paused
    if (paused) return
    for (const sessionID of this.state.order) {
      const session = this.state.sessions[sessionID]
      if (session?.queue.length && (session.status.type === "idle" || session.status.type === "error")) {
        void this.drainQueue(sessionID).catch((error) => this.callbacks.error(`Could not send queued prompt: ${message(error)}`))
      }
    }
  }

  setSessionDraft(sessionID: string, draft: string): void {
    this.requireSession(sessionID)
    this.updateDraft(sessionID, draft)
  }

  setPreference(agent?: string, model?: string, variant?: string): void {
    const sessionID = this.state.selectedID
    if (!sessionID) return
    this.validatePreference(agent, model, variant)
    this.rememberPreference(agent, model, variant, variant !== undefined)
    this.dispatch({ type: "preference", sessionID, agent, model, variant: model && variant === undefined ? "" : variant })
  }

  async send(text: string, agent?: string, model?: string, variant?: string, files: PromptFilePart[] = [], mentionedAgents: string[] = []): Promise<void> {
    if (this.promptAdmissionPaused) throw new Error("OpenCode is waiting to reload; send another prompt after reconnecting")
    const sessionID = this.state.selectedID
    if (!sessionID) throw new Error("Create or select a session first")
    const session = this.state.sessions[sessionID]
    if (!session) throw new Error("Unknown OpenCode session")
    if ((!text.trim() && !files.length) || text.length > PROMPT_TEXT_CHARACTER_LIMIT) throw new Error("Prompt must contain text or an attachment")
    const attachmentCharacters = files.reduce((total, file) => total + file.filename.length + file.mime.length + file.url.length, 0)
    if (files.length > PROMPT_ATTACHMENT_COUNT_LIMIT || attachmentCharacters > PROMPT_ATTACHMENT_CHARACTER_LIMIT ||
      files.some((file) => file.type !== "file" || !file.filename || file.filename.length > 255 || file.mime.length > 100 || file.url.length > PROMPT_ATTACHMENT_CHARACTER_LIMIT)) {
      throw new Error("Prompt attachments exceed Workbench limits")
    }
    if ((agent?.length ?? 0) > 1_024 || (model?.length ?? 0) > 1_024 || (variant?.length ?? 0) > 1_024) throw new Error("Agent, model, and reasoning identifiers must not exceed 1,024 characters")
    if (mentionedAgents.length > 20 || mentionedAgents.some((name) => !this.mentionAgents.some((candidate) => candidate.name === name))) throw new Error("Prompt contains an unknown OpenCode agent mention")
    this.validatePreference(agent, model, variant)
    if (session.queue.length >= PROMPT_QUEUE_COUNT_LIMIT) throw new Error(`This session already has ${PROMPT_QUEUE_COUNT_LIMIT} queued prompts`)
    const queuedCharacters = session.queue.reduce((total, prompt) =>
      total + prompt.id.length + prompt.text.length + (prompt.agent?.length ?? 0) + (prompt.model?.length ?? 0) + (prompt.variant?.length ?? 0), 0)
    if (queuedCharacters + text.length + (agent?.length ?? 0) + (model?.length ?? 0) + (variant?.length ?? 0) > PROMPT_QUEUE_CHARACTER_LIMIT) {
      throw new Error("Queued prompts exceed Workbench's aggregate text limit")
    }
    this.dispatch({ type: "preference", sessionID, agent, model, variant })
    this.updateDraft(sessionID, "")
    const promptID = `msg_${randomUUID().replaceAll("-", "")}`
    if (files.length) this.promptFiles.set(promptID, files)
    if (mentionedAgents.length) this.promptAgents.set(promptID, [...new Set(mentionedAgents)])
    this.dispatch({
      type: "queue",
      sessionID,
      prompt: { id: promptID, text, agent, model, variant, attachments: files.length ? files.map((file) => ({ name: file.filename, mime: file.mime })) : undefined, createdAt: Date.now() },
    })
    await this.drainQueue(sessionID)
  }

  removeQueued(sessionID: string, promptID: string): void {
    this.requireSession(sessionID)
    if (this.sendingPrompts.get(sessionID) === promptID) throw new Error("The queued prompt is already being sent")
    this.promptFiles.delete(promptID)
    this.promptAgents.delete(promptID)
    this.dispatch({ type: "removeQueued", sessionID, promptID })
  }

  reorderQueue(sessionID: string, promptIDs: string[]): void {
    const session = this.requireSession(sessionID)
    if (this.sendingPrompts.has(sessionID) && promptIDs[0] !== this.sendingPrompts.get(sessionID)) {
      throw new Error("The prompt being sent must remain first")
    }
    if (promptIDs.length !== session.queue.length || new Set(promptIDs).size !== promptIDs.length ||
      promptIDs.some((id) => typeof id !== "string" || id.length === 0 || id.length > 1_024)) throw new Error("Queue order does not match the session queue")
    this.dispatch({ type: "reorderQueue", sessionID, promptIDs })
  }

  async sendQueuedNow(sessionID: string, promptID: string): Promise<void> {
    const session = this.requireSession(sessionID)
    const index = session.queue.findIndex((prompt) => prompt.id === promptID)
    if (index < 0) throw new Error("Unknown queued prompt")
    if ((session.status.type === "busy" || session.status.type === "retry") && /^\/[A-Za-z0-9._-]+(?:\s|$)/.test(session.queue[index]!.text.trimStart())) {
      throw new Error("Slash commands cannot steer a busy OpenCode session")
    }
    if (this.sendingPrompts.has(sessionID)) throw new Error("A queued prompt is already being sent")
    this.dispatch({ type: "reorderQueue", sessionID, promptIDs: [promptID, ...session.queue.filter((prompt) => prompt.id !== promptID).map((prompt) => prompt.id)] })
    this.steeringPrompts.add(promptID)
    try {
      await this.drainQueue(sessionID)
    } finally {
      this.steeringPrompts.delete(promptID)
    }
  }

  private requireSession(sessionID: string): WorkbenchState["sessions"][string] {
    if (!Object.hasOwn(this.state.sessions, sessionID)) throw new Error("Unknown OpenCode session")
    return this.state.sessions[sessionID]!
  }

  private cleanupSession(sessionID: string): void {
    const session = this.state.sessions[sessionID]
    for (const prompt of session?.queue ?? []) this.promptFiles.delete(prompt.id)
    const sending = this.sendingPrompts.get(sessionID)
    if (sending) this.promptFiles.delete(sending)
    for (const prompt of session?.queue ?? []) this.promptAgents.delete(prompt.id)
    if (sending) this.promptAgents.delete(sending)
    this.sendingPrompts.delete(sessionID)
    this.drainingQueues.delete(sessionID)
    this.sendGenerations.delete(sessionID)
    this.transcriptRevisions.delete(sessionID)
    this.transcriptGenerations.delete(sessionID)
    this.removedMessages.delete(sessionID)
    this.removedParts.delete(sessionID)
    this.messageRevisions.delete(sessionID)
    this.todoRevisions.delete(sessionID)
    this.todoGenerations.delete(sessionID)
    this.changeRevisions.delete(sessionID)
    this.changeGenerations.delete(sessionID)
    const refreshTimer = this.transcriptRefreshTimers.get(sessionID)
    if (refreshTimer) clearTimeout(refreshTimer)
    this.transcriptRefreshTimers.delete(sessionID)
  }

  private async drainQueue(sessionID: string): Promise<void> {
    if (this.promptAdmissionPaused) return
    if (this.drainingQueues.has(sessionID)) return
    const session = this.state.sessions[sessionID]
    if (!session || !session.queue.length) return
    const prompt = session.queue[0]!
    const trimmed = prompt.text.trimStart()
    const command = /^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
    if (command && session.status.type !== "idle" && session.status.type !== "error") return
    const legacy = !command && this.requiresLegacyPromptTransport(prompt.agent, prompt.model)
    if (legacy && (session.status.type === "busy" || session.status.type === "retry") && !this.steeringPrompts.has(prompt.id)) return
    const delivery = this.steeringPrompts.has(prompt.id) || session.status.type === "idle" || session.status.type === "error" ? "steer" : "queue"
    this.drainingQueues.add(sessionID)
    this.sendingPrompts.set(sessionID, prompt.id)
    const generation = (this.sendGenerations.get(sessionID) ?? 0) + 1
    this.sendGenerations.set(sessionID, generation)
    let accepted = false
    if (delivery === "steer") {
      this.statusRevision += 1
      this.dispatch({ type: "event", event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    }
    try {
      if (command) await this.client.sendCommand(sessionID, command[1]!, command[2] ?? "", prompt.agent, prompt.model, prompt.variant, this.promptFiles.get(prompt.id) ?? [], prompt.id)
      else {
        const files = this.promptFiles.get(prompt.id) ?? []
        if (legacy) await this.client.sendAsync(sessionID, prompt.text, prompt.agent, prompt.model, prompt.variant, files)
        else await this.client.sendPrompt(sessionID, prompt.id, prompt.text, delivery, prompt.agent, prompt.model, prompt.variant, files, this.promptAgents.get(prompt.id) ?? [])
        if (!legacy) {
          const slash = prompt.model?.indexOf("/") ?? -1
          this.handleEvent({
            type: "message.updated",
            properties: {
              info: {
                id: prompt.id,
                sessionID,
                role: "user",
                time: { created: prompt.createdAt },
                agent: prompt.agent,
                model: slash > 0 ? { providerID: prompt.model!.slice(0, slash), modelID: prompt.model!.slice(slash + 1), variant: prompt.variant } : undefined,
              },
            },
          })
          if (prompt.text) this.handleEvent({
            type: "message.part.updated",
            properties: { part: { id: `${prompt.id}-text`, sessionID, messageID: prompt.id, type: "text", text: prompt.text } },
          })
          for (const [index, file] of files.entries()) this.handleEvent({
            type: "message.part.updated",
            properties: { part: { id: `${prompt.id}-file-${index}`, sessionID, messageID: prompt.id, type: "file", mime: file.mime, filename: file.filename, url: file.url } },
          })
        }
        this.scheduleTranscriptRefresh(sessionID)
      }
      accepted = true
      if (this.sendGenerations.get(sessionID) === generation) {
        this.promptFiles.delete(prompt.id)
        this.promptAgents.delete(prompt.id)
        this.dispatch({ type: "removeQueued", sessionID, promptID: prompt.id })
      }
    } catch (error) {
      if (delivery === "steer" && this.sendGenerations.get(sessionID) === generation) {
        this.statusRevision += 1
        this.dispatch({ type: "event", event: { type: "session.status", properties: { sessionID, status: { type: "error", message: message(error) } } } })
      }
      throw error
    } finally {
      this.sendingPrompts.delete(sessionID)
      this.drainingQueues.delete(sessionID)
      const current = this.state.sessions[sessionID]
      if (accepted && current?.queue.length) void this.drainQueue(sessionID)
    }
  }

  async abortSelected(): Promise<void> {
    const sessionID = this.state.selectedID
    if (!sessionID) return
    const accepted = await this.client.abort(sessionID)
    if (!accepted) throw new Error("OpenCode did not accept the stop request")
    this.statusRevision += 1
    this.dispatch({ type: "event", event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
  }

  private delegationProgress(session: WorkbenchState["sessions"][string]): DelegationProgress[] {
    const parts = session.messages.flatMap((message) => message.parts.filter((part) => delegationSessionID(part))).slice(-20)
    const output: DelegationProgress[] = []
    let aggregateCharacters = 0
    let aggregateParts = 0
    for (const part of parts.reverse()) {
      const sessionID = delegationSessionID(part)!
      const child = this.state.sessions[sessionID]
      const transcript = snapshotTranscript(child?.messages ?? [], this.messageRevisions.get(sessionID) ?? new Map(), 500_000, 1_000, 500)
      let characters = 0
      let childParts = 0
      for (const message of transcript.messages) for (const childPart of message.parts) {
        childParts += 1
        characters += (childPart.text?.length ?? 0) + (childPart.state?.title?.length ?? 0) +
          (childPart.state?.output?.length ?? 0) + (childPart.state?.error?.length ?? 0)
      }
      const messages = aggregateCharacters + characters <= 2_000_000 && aggregateParts + childParts <= 10_000 ? transcript.messages : []
      if (messages.length) {
        aggregateCharacters += characters
        aggregateParts += childParts
      }
      const input = record(part.state?.input) ? part.state.input : undefined
      const title = boundedText(part.state?.title, 2_000) ?? boundedText(input?.description, 2_000) ?? "Delegated task"
      const partStatus = String(part.state?.status ?? "").toLowerCase()
      const status = child?.status ?? (partStatus === "error" || partStatus === "failed"
        ? { type: "error" as const, message: boundedText(part.state?.error, 20_000) }
        : partStatus === "running" || partStatus === "pending"
        ? { type: "busy" as const }
        : { type: "idle" as const })
      output.push({
        partID: part.id,
        sessionID,
        title,
        status,
        messages,
        revision: this.transcriptRevisions.get(sessionID) ?? 0,
      })
    }
    return output.reverse()
  }

  chatSnapshot(): ChatSnapshot {
    const current = this.state.selectedID ? this.state.sessions[this.state.selectedID] : undefined
    const transcript = current ? snapshotTranscript(current.messages, this.messageRevisions.get(current.info.id) ?? new Map()) : undefined
    const delegations = current ? this.delegationProgress(current) : []
    const delegatedSessions = current && !current.info.parentID ? descendantSessions(this.state, current.info.id) : []
    const rootMemo = new Map<string, string>()
    const rootID = (sessionID: string): string => {
      const cached = rootMemo.get(sessionID)
      if (cached) return cached
      const path: string[] = []
      const visited = new Set<string>()
      let candidate = sessionID
      while (!visited.has(candidate)) {
        visited.add(candidate)
        path.push(candidate)
        const parentID = this.state.sessions[candidate]?.info.parentID
        if (!parentID || !this.state.sessions[parentID]) break
        const parentRoot = rootMemo.get(parentID)
        if (parentRoot) {
          candidate = parentRoot
          break
        }
        candidate = parentID
      }
      for (const id of path) rootMemo.set(id, candidate)
      return candidate
    }
    const childAttention = new Map<string, { permissions: number; questions: number }>()
    for (const session of Object.values(this.state.sessions)) {
      if (!session.info.parentID) continue
      const root = rootID(session.info.id)
      const counts = childAttention.get(root) ?? { permissions: 0, questions: 0 }
      counts.permissions += session.permissions.length
      counts.questions += session.questions.length
      childAttention.set(root, counts)
    }
    const allRootIDs = this.state.order.filter((id) => !this.state.sessions[id]?.info.parentID)
    const visibleRootIDs = allRootIDs.slice(0, 5_000)
    const selectedRootID = current ? rootID(current.info.id) : undefined
    if (selectedRootID && !visibleRootIDs.includes(selectedRootID)) {
      if (visibleRootIDs.length >= 5_000) visibleRootIDs[visibleRootIDs.length - 1] = selectedRootID
      else visibleRootIDs.push(selectedRootID)
    }
    const effectiveAgent = current?.agent ?? this.currentAgent ?? this.defaultAgent
    const effectiveModel = current?.model ?? this.modelForAgent(effectiveAgent)
    const selectedModel = effectiveModel
      ? this.models.find((model) => `${model.providerID}/${model.id}` === effectiveModel)
      : undefined
    const configuredAgent = this.agents.find((agent) => agent.name === effectiveAgent)
    const configuredAgentModel = configuredAgent?.model ? `${configuredAgent.model.providerID}/${configuredAgent.model.modelID}` : undefined
    const agentVariant = configuredAgentModel === effectiveModel && selectedModel?.variants?.includes(configuredAgent?.variant ?? "") ? configuredAgent?.variant : undefined
    const fallbackVariant = agentVariant ?? (selectedModel?.variants?.includes(this.defaultVariant ?? "") ? this.defaultVariant : undefined)
    const effectiveVariant = current?.variant ?? (effectiveModel && this.modelVariants.has(effectiveModel) ? this.modelVariants.get(effectiveModel) : fallbackVariant)
    return {
      connected: this.state.connected,
      sessions: visibleRootIDs.flatMap((id) => {
        const session = this.state.sessions[id]
        const childPermissions = childAttention.get(id)?.permissions ?? 0
        const childQuestions = childAttention.get(id)?.questions ?? 0
        return session && !session.info.parentID ? [{
          id,
          title: session.info.title || "Untitled session",
          status: session.status,
          unread: session.unread,
          directory: session.info.directory.slice(0, 8_192),
          parentID: session.info.parentID?.slice(0, 1_024),
          updatedAt: Number.isSafeInteger(session.info.time.updated) && session.info.time.updated >= 0 ? session.info.time.updated : 0,
          attention: session.permissions.length + session.questions.length + childPermissions + childQuestions,
          questionCount: session.questions.length + childQuestions,
          permissionCount: session.permissions.length + childPermissions,
          queued: session.queue.filter((prompt) => prompt.id !== this.sendingPrompts.get(session.info.id)).length,
          todo: {
            completed: session.todos.filter((todo) => todo.status === "completed").length,
            total: session.todos.length,
          },
          changeCount: session.changes.length,
        }] : []
      }),
      agents: this.agents,
      mentionAgents: this.mentionAgents,
      providers: this.providers,
      models: this.models,
      resources: this.resources,
      catalog: this.catalog,
      commands: this.commands,
      autoApproval: current ? this.autoApprovalFor(current.info.id) : false,
      runtime: this.runtime,
      session: current ? {
        id: current.info.id,
        parentID: current.info.parentID,
        directory: current.info.directory,
        title: current.info.title,
        draft: current.draft,
        status: current.status,
        loadState: current.loadState,
        messages: transcript!.messages,
        messageRevisions: transcript!.revisions,
        agent: effectiveAgent,
        model: effectiveModel,
        variant: effectiveVariant,
        queue: current.queue,
        inFlightPromptID: this.sendingPrompts.get(current.info.id),
        permissions: current.info.parentID ? [] : boundedPermissionList([...current.permissions, ...delegatedSessions.flatMap((session) => session.permissions)]),
        questions: current.info.parentID ? [] : [...current.questions, ...delegatedSessions.flatMap((session) => session.questions)].slice(0, 100),
        todos: current.todos,
        changes: current.changes,
        context: deriveContext(current.messages, this.models, selectedModel, current.info.cost),
        goal: deriveGoal(current.messages),
        delegations,
      } : undefined,
    }
  }

  private handleEvent(event: OpenCodeEvent): void {
    if (["session.created", "session.updated", "session.deleted"].includes(event.type)) this.sessionRevision += 1
    if (["session.status", "session.idle", "session.error"].includes(event.type) || event.type.startsWith("session.next.")) this.statusRevision += 1
    const info = event.properties.info
    const part = event.properties.part
    const sessionID = typeof event.properties.sessionID === "string"
      ? event.properties.sessionID
      : info && typeof info === "object" && "sessionID" in info && typeof info.sessionID === "string"
      ? info.sessionID
      : part && typeof part === "object" && "sessionID" in part && typeof part.sessionID === "string"
      ? part.sessionID
      : undefined
    if (sessionID && event.type.startsWith("message.")) {
      const revision = (this.transcriptRevisions.get(sessionID) ?? 0) + 1
      this.transcriptRevisions.set(sessionID, revision)
      if (event.type === "message.removed" && typeof event.properties.messageID === "string") {
        const removed = this.removedMessages.get(sessionID) ?? new Map<string, number>()
        removed.set(event.properties.messageID, revision)
        this.removedMessages.set(sessionID, removed)
      }
      if (event.type === "message.part.removed" && typeof event.properties.messageID === "string" && typeof event.properties.partID === "string") {
        const removed = this.removedParts.get(sessionID) ?? new Map<string, number>()
        removed.set(`${event.properties.messageID}:${event.properties.partID}`, revision)
        this.removedParts.set(sessionID, removed)
      }
      const messageID = typeof event.properties.messageID === "string"
        ? event.properties.messageID
        : info && typeof info === "object" && "id" in info && typeof info.id === "string"
        ? info.id
        : part && typeof part === "object" && "messageID" in part && typeof part.messageID === "string"
        ? part.messageID
        : undefined
      if (messageID && event.type === "message.removed") this.messageRevisions.get(sessionID)?.delete(messageID)
      else if (messageID) this.bumpMessageRevision(sessionID, messageID)
    }
    let normalizedEvent = event
    if (event.type === "todo.updated") {
      this.todoRevisions.set(sessionID ?? "", (this.todoRevisions.get(sessionID ?? "") ?? 0) + 1)
      normalizedEvent = { ...event, properties: { ...event.properties, todos: parseTodos(event.properties.todos) } }
    } else if (event.type === "session.diff" && sessionID) {
      this.changeRevisions.set(sessionID, (this.changeRevisions.get(sessionID) ?? 0) + 1)
      const changes = parseChanges(event.properties.diff)
      this.dispatch({ type: "changes", sessionID, changes })
    }
    if (event.type === "session.deleted" && record(event.properties.info) && typeof event.properties.info.id === "string") {
      this.cleanupSession(event.properties.info.id)
    }
    this.dispatch({ type: "event", event: normalizedEvent })
    if (sessionID && event.type.startsWith("session.next.")) {
      this.scheduleTranscriptRefresh(sessionID)
      let status: SessionStatus | undefined
      if (event.type === "session.next.retried") {
        const error = record(event.properties.error) && typeof event.properties.error.message === "string" ? event.properties.error.message : undefined
        status = { type: "retry", attempt: typeof event.properties.attempt === "number" ? event.properties.attempt : undefined, message: error }
      } else if (event.type === "session.next.step.failed") {
        const error = record(event.properties.error) && typeof event.properties.error.message === "string" ? event.properties.error.message : "OpenCode response failed"
        status = { type: "error", message: error }
      } else if (event.type === "session.next.step.ended") {
        status = event.properties.finish === "tool-calls" ? { type: "busy" } : { type: "idle" }
      } else if (["session.next.prompt.admitted", "session.next.prompted", "session.next.step.started"].includes(event.type)) {
        status = { type: "busy" }
      }
      if (status) this.dispatch({ type: "event", event: { type: "session.status", properties: { sessionID, status } } })
      if (status?.type === "idle" || status?.type === "error") {
        void this.drainQueue(sessionID).catch((error) => this.callbacks.error(`Could not send queued prompt: ${message(error)}`))
      }
    }
    if (event.type === "vcs.branch.updated") {
      const branch = boundedRuntimeString(event.properties.branch, 2_000)
      this.runtime = { ...(this.runtime ?? { lsp: [], formatters: [], mcp: [], updatedAt: Date.now() }), vcs: { branch }, updatedAt: Date.now() }
      this.notify({ type: "connected", connected: this.state.connected })
    } else if (event.type === "file.watcher.updated") {
      if (this.runtimeRefreshTimer) clearTimeout(this.runtimeRefreshTimer)
      this.runtimeRefreshTimer = setTimeout(() => {
        this.runtimeRefreshTimer = undefined
        void this.refreshRuntime()
      }, 500)
    } else if (event.type === "lsp.updated" || event.type.startsWith("mcp.")) void this.refreshRuntime()
    if (part && typeof part === "object") {
      const childID = delegationSessionID(part as MessagePart)
      if (childID && this.state.sessions[childID] && !this.state.sessions[childID]!.loaded) void this.loadTranscript(childID).catch(() => undefined)
    }
    if (sessionID && (event.type === "session.idle" ||
      (event.type === "session.status" && record(event.properties.status) && event.properties.status.type === "idle"))) {
      void this.drainQueue(sessionID).catch((error) => this.callbacks.error(`Could not send queued prompt: ${message(error)}`))
    }
    const permission = parsePermission(event)
    if (permission) this.storePermission(permission)
    if (["permission.replied", "permission.v2.replied"].includes(event.type) && sessionID) {
      const requestID = typeof event.properties.requestID === "string"
        ? event.properties.requestID
        : typeof event.properties.id === "string"
        ? event.properties.id
        : undefined
      if (requestID) this.removePermission(sessionID, requestID, event.type === "permission.v2.replied" ? ["v2"] : ["legacy", "current"])
    }
    const question = parseQuestion(event)
    if (question) this.storeQuestion(question)
    if (["question.replied", "question.rejected", "question.v2.replied", "question.v2.rejected"].includes(event.type) && sessionID) {
      const requestID = typeof event.properties.requestID === "string" ? event.properties.requestID : undefined
      if (requestID) this.removeQuestion(sessionID, requestID)
    }
  }

  private rootSessionID(sessionID: string): string {
    let current = sessionID
    const visited = new Set<string>()
    while (this.state.sessions[current]?.info.parentID && !visited.has(current)) {
      visited.add(current)
      current = this.state.sessions[current]!.info.parentID!
    }
    return current
  }

  private autoApprovalFor(sessionID: string): boolean {
    return this.state.sessions[this.rootSessionID(sessionID)]?.autoApproval === true
  }

  setAutoApproval(sessionID: string, enabled: boolean): void {
    this.requireSession(sessionID)
    const rootID = this.rootSessionID(sessionID)
    this.dispatch({ type: "autoApproval", sessionID: rootID, enabled })
    if (!enabled) return
    for (const session of Object.values(this.state.sessions)) {
      if (this.rootSessionID(session.info.id) === rootID) for (const request of session.permissions) this.maybeAutoRespond(request)
    }
  }

  async respondPermission(requestID: string, response: "once" | "always" | "reject", sessionID = this.state.selectedID, protocol?: PermissionRequest["protocol"], feedback?: string): Promise<void> {
    if (!sessionID) throw new Error("Select the session that owns the permission request")
    const session = this.requireSession(sessionID)
    const request = session.permissions.find((candidate) => candidate.id === requestID && candidate.sessionID === sessionID && (!protocol || candidate.protocol === protocol))
    if (!request) throw new Error("Permission request is no longer pending for this session")
    if (request.truncated && response !== "reject") throw new Error("Incomplete permission details can only be rejected")
    if (response === "always" && !request.always?.length) throw new Error("This permission has no reusable always-allow scope")
    const key = `${request.protocol}\0${sessionID}\0${requestID}`
    if (this.respondingPermissions.has(key)) throw new Error("Permission response is already in progress")
    this.respondingPermissions.add(key)
    try {
      await this.client.respondPermission(request, response, feedback)
      if (response === "reject") this.clearPermissions(sessionID, request.protocol === "v2" ? ["v2"] : ["legacy", "current"])
      else this.removePermission(sessionID, requestID, [request.protocol])
    } catch (error) {
      this.callbacks.error(`Could not answer permission request: ${message(error)}`)
      throw error
    } finally {
      this.respondingPermissions.delete(key)
    }
  }

  private storePermission(request: PermissionRequest): void {
    const session = this.state.sessions[request.sessionID]
    if (!session) return
    const index = session.permissions.findIndex((candidate) => candidate.id === request.id && candidate.protocol === request.protocol)
    const permissions = session.permissions.slice()
    if (index < 0) {
      if (permissions.length >= 100) {
        this.callbacks.error("OpenCode permission request limit reached for this session")
        return
      }
      permissions.push(request)
    } else permissions[index] = request
    if (permissions.reduce((total, candidate) => total + permissionRequestCharacters(candidate), 0) > PERMISSION_AGGREGATE_CHARACTER_LIMIT) {
      permissions[index < 0 ? permissions.length - 1 : index] = rejectOnlyPermission(request)
      if (permissions.reduce((total, candidate) => total + permissionRequestCharacters(candidate), 0) > PERMISSION_AGGREGATE_CHARACTER_LIMIT) {
        this.callbacks.error("OpenCode permission request detail limit reached for this session")
        return
      }
    }
    const storedRequest = permissions[index < 0 ? permissions.length - 1 : index]!
    if (index < 0 && (storedRequest.type === "vscode.reload_opencode" || !this.autoApprovalFor(request.sessionID) || storedRequest.truncated)) {
      this.callbacks.attention?.(storedRequest)
    }
    this.permissionRevision += 1
    this.dispatch({ type: "permissions", sessionID: request.sessionID, permissions })
    this.maybeAutoRespond(storedRequest)
  }

  private removePermission(sessionID: string, requestID: string, protocols?: PermissionRequest["protocol"][]): void {
    const session = this.state.sessions[sessionID]
    if (!session) return
    const permissions = session.permissions.filter((request) => request.id !== requestID || (protocols && !protocols.includes(request.protocol)))
    if (permissions.length === session.permissions.length) return
    this.permissionRevision += 1
    this.dispatch({ type: "permissions", sessionID, permissions })
  }

  private clearPermissions(sessionID: string, protocols: PermissionRequest["protocol"][]): void {
    const session = this.state.sessions[sessionID]
    if (!session?.permissions.length) return
    const permissions = session.permissions.filter((request) => !protocols.includes(request.protocol))
    if (permissions.length === session.permissions.length) return
    this.permissionRevision += 1
    this.dispatch({ type: "permissions", sessionID, permissions })
  }

  private maybeAutoRespond(request: PermissionRequest): void {
    if (!this.autoApprovalFor(request.sessionID) || request.truncated || request.type === "vscode.reload_opencode") return
    const key = `${request.protocol}\0${request.sessionID}\0${request.id}`
    if (this.respondingPermissions.has(key)) return
    void this.respondPermission(request.id, "once", request.sessionID, request.protocol).catch(() => undefined)
  }

  async respondQuestion(requestID: string, answers: string[][], sessionID = this.state.selectedID): Promise<void> {
    if (!sessionID) throw new Error("Select the session that owns the question")
    const session = this.requireSession(sessionID)
    const request = session.questions.find((candidate) => candidate.id === requestID && candidate.sessionID === sessionID)
    if (!request) throw new Error("Question is no longer pending for this session")
    if (answers.length !== request.questions.length || answers.some((answer) => !Array.isArray(answer) || answer.length === 0 || answer.length > 20 ||
      answer.some((item) => typeof item !== "string" || !item.trim() || item.length > 20_000))) throw new Error("Answer every question before submitting")
    const key = `${sessionID}\0${requestID}`
    if (this.respondingQuestions.has(key)) throw new Error("Question response is already in progress")
    this.respondingQuestions.add(key)
    try {
      await this.client.respondQuestion(request, answers)
      this.removeQuestion(sessionID, requestID)
    } finally {
      this.respondingQuestions.delete(key)
    }
  }

  async rejectQuestion(requestID: string, sessionID = this.state.selectedID): Promise<void> {
    if (!sessionID) throw new Error("Select the session that owns the question")
    const session = this.requireSession(sessionID)
    const request = session.questions.find((candidate) => candidate.id === requestID && candidate.sessionID === sessionID)
    if (!request) throw new Error("Question is no longer pending for this session")
    const key = `${sessionID}\0${requestID}`
    if (this.respondingQuestions.has(key)) throw new Error("Question response is already in progress")
    this.respondingQuestions.add(key)
    try {
      await this.client.rejectQuestion(request)
      this.removeQuestion(sessionID, requestID)
    } finally {
      this.respondingQuestions.delete(key)
    }
  }

  private storeQuestion(request: QuestionRequest): void {
    const session = this.state.sessions[request.sessionID]
    if (!session) return
    const index = session.questions.findIndex((candidate) => candidate.id === request.id)
    const questions = session.questions.slice()
    if (index < 0) {
      if (questions.length >= 100) return
      questions.push(request)
      this.callbacks.attention?.(request)
    } else questions[index] = request
    this.questionRevision += 1
    this.dispatch({ type: "questions", sessionID: request.sessionID, questions })
  }

  private removeQuestion(sessionID: string, requestID: string): void {
    const session = this.state.sessions[sessionID]
    if (!session) return
    const questions = session.questions.filter((request) => request.id !== requestID)
    if (questions.length === session.questions.length) return
    this.questionRevision += 1
    this.dispatch({ type: "questions", sessionID, questions })
  }
}
