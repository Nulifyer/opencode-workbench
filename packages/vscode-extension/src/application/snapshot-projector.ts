import type { ContextSummary, GoalMetricSummary, GoalSummary, MessageBundle, MessagePart, ModelOption, RuntimeService, RuntimeStatus, TranscriptHistoryState, WorkbenchState } from "@opencode-workbench/shared"

type JsonRecord = Record<string, unknown>
function record(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value) }

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

export function boundedText(value: unknown, limit: number): string | undefined {
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
  if (part.metadata !== undefined) {
    const metadata = boundedJson(part.metadata)
    if (metadata !== OMIT) output.metadata = metadata
  }
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

export function snapshotPartCharacters(part: MessagePart): number {
  return (part.text?.length ?? 0) + (typeof part.mime === "string" ? part.mime.length : 0) + (typeof part.filename === "string" ? part.filename.length : 0) +
    (part.metadata === undefined ? 0 : JSON.stringify(part.metadata).length) +
    (part.state?.title?.length ?? 0) + (part.state?.output?.length ?? 0) +
    (part.state?.error?.length ?? 0) + (part.state?.input === undefined ? 0 : JSON.stringify(part.state.input).length) +
    (part.state?.metadata === undefined ? 0 : JSON.stringify(part.state.metadata).length)
}

export function snapshotMessage(message: MessageBundle, pendingText?: string): MessageBundle | undefined {
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
  const fallbackText = boundedText(pendingText, 500_000)
  if (info.role === "user" && fallbackText && characters + fallbackText.length <= 1_500_000 &&
    !parts.some((part) => part.type === "text" && !part.synthetic && Boolean(part.text))) {
    parts.push({ id: `${info.id}-pending-text`, sessionID: info.sessionID, messageID: info.id, type: "text", text: fallbackText })
  }
  return { info: safeInfo, parts }
}

export function snapshotTranscript(
  messages: MessageBundle[],
  revisions: Map<string, number>,
  characterLimit = 3_800_000,
  partLimit = 19_000,
  messageLimit = 5_000,
  pendingText?: (messageID: string) => string | undefined,
): { messages: MessageBundle[]; revisions: Record<string, number>; history: TranscriptHistoryState } {
  const output: MessageBundle[] = []
  let parts = 0
  let characters = 0
  const windowStart = Math.max(0, messages.length - messageLimit)
  let limitedBy: TranscriptHistoryState["limitedBy"] = windowStart > 0 ? "messages" : undefined
  let stoppedForBudget = false
  for (let index = messages.length - 1; index >= windowStart; index -= 1) {
    const message = messages[index]!
    const safe = snapshotMessage(message, pendingText?.(message.info.id))
    if (!safe) continue
    const nextParts = parts + safe.parts.length
    const nextCharacters = characters + safe.parts.reduce((total, part) => total + snapshotPartCharacters(part), 0)
    if (nextParts > partLimit || nextCharacters > characterLimit) {
      limitedBy = nextParts > partLimit ? "parts" : "characters"
      stoppedForBudget = true
      break
    }
    parts = nextParts
    characters = nextCharacters
    output.push(safe)
  }
  output.reverse()
  return {
    messages: output,
    revisions: Object.fromEntries(output.map((message) => [message.info.id, revisions.get(message.info.id) ?? 0])),
    history: {
      totalMessages: messages.length,
      visibleMessages: output.length,
      hasOlder: windowStart > 0 || stoppedForBudget,
      limitedBy,
    },
  }
}


export function boundedRuntimeString(value: unknown, limit: number): string | undefined {
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

function runtimeFormatters(value: unknown): RuntimeService[] {
  return runtimeServices(value).filter((formatter) => typeof formatter.enabled === "boolean" && Boolean(formatter.extensions))
}

export function normalizeRuntime(path: unknown, vcs: unknown, lsp: unknown, formatter: unknown, mcp: unknown): RuntimeStatus {
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
    formatters: runtimeFormatters(formatter),
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

export function deriveContext(messages: WorkbenchState["sessions"][string]["messages"], models: ModelOption[], fallbackModel?: ModelOption, sessionCost?: number): ContextSummary | undefined {
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
  const usageReported = tokens.totalTokens > 0
  return {
    ...tokens,
    cost,
    contextLimit,
    inputLimit: model?.inputLimit,
    outputLimit: model?.outputLimit,
    model: model ? `${model.providerID}/${model.id}` : providerID && modelID ? `${providerID}/${modelID}` : undefined,
    usageReported,
    usagePercent: usageReported && contextLimit ? Math.min(100, tokens.totalTokens / contextLimit * 100) : undefined,
  }
}


export const GOAL_TOOLS = new Set([
  "get_goal",
  "get_goal_history",
  "create_goal",
  "set_goal",
  "update_goal",
  "update_goal_status",
  "update_goal_objective",
  "configure_goal_verification",
  "record_goal_verdict",
  "update_goal_checkpoint",
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
  const latestVerdict = record(goal.latestVerdict) && ["continue", "complete", "blocked", "needs-user"].includes(String(goal.latestVerdict.verdict)) && typeof goal.latestVerdict.reason === "string" && Array.isArray(goal.latestVerdict.missingCriteria) && ["low", "medium", "high"].includes(String(goal.latestVerdict.confidence))
    ? { verdict: goal.latestVerdict.verdict as "continue" | "complete" | "blocked" | "needs-user", reason: goal.latestVerdict.reason.slice(0, 4_000), missingCriteria: goal.latestVerdict.missingCriteria.filter((item): item is string => typeof item === "string").slice(0, 100), confidence: goal.latestVerdict.confidence as "low" | "medium" | "high" }
    : undefined
  const verifierValue = record(goal.verifier) ? goal.verifier : undefined
  const verifier = verifierValue && typeof verifierValue.enabled === "boolean" && Number.isSafeInteger(verifierValue.timeoutMilliseconds) && Number.isSafeInteger(verifierValue.repeatedBlockThreshold)
    ? { enabled: verifierValue.enabled, model: textFromRecord(verifierValue, "model", 1_024), agent: textFromRecord(verifierValue, "agent", 1_024), timeoutMilliseconds: Number(verifierValue.timeoutMilliseconds), repeatedBlockThreshold: Number(verifierValue.repeatedBlockThreshold) }
    : undefined
  const result: GoalSummary = {
    id: text("id", 256),
    sequence: integer("sequence"),
    sourceTool: "goal",
    objective: text("objective"),
    status: text("status", 100),
    tokenBudget: integer("tokenBudget"),
    tokensUsed: integer("tokensUsed"),
    remainingTokens: integer("remainingTokens"),
    timeUsedSeconds: integer("timeUsedSeconds"),
    maxDurationSeconds: integer("maxDurationSeconds"),
    turnsUsed: integer("turnsUsed"),
    autoTurns: integer("autoTurns"),
    maxAutoTurns: integer("maxAutoTurns"),
    lastStatus: text("lastStatus"),
    stopReason: text("stopReason"),
    checkpoint,
    completionEvidence: text("completionEvidence"),
    blocker: text("blocker"),
    acceptanceCriteria: Array.isArray(goal.acceptanceCriteria) ? goal.acceptanceCriteria.filter((item): item is string => typeof item === "string").slice(0, 100) : undefined,
    verifier,
    latestVerdict,
    evidenceReferences: Array.isArray(goal.evidenceReferences) ? goal.evidenceReferences.filter((item): item is string => typeof item === "string").slice(0, 500) : undefined,
    consecutiveBlockedVerdicts: integer("consecutiveBlockedVerdicts"),
    pendingContinuation: goal.pendingContinuation === true,
    settlementGeneration: integer("settlementGeneration"),
    planReference: text("planReference", 8_192),
    runGroupReference: text("runGroupReference", 1_024),
    createdAt: integer("createdAt"),
    closedAt: integer("closedAt"),
    archivedGoals: parseGoalMetrics(goal.archivedGoals),
    sampledAt: integer("sampledAt"),
  }
  return result.objective !== undefined || result.status !== undefined ? result : undefined
}

function parseGoalMetrics(value: unknown): GoalMetricSummary[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((candidate) => {
    if (!record(candidate)) return []
    const text = (key: string, limit: number) => typeof candidate[key] === "string" && candidate[key].length <= limit ? candidate[key] as string : undefined
    const number = (key: string) => Number.isSafeInteger(candidate[key]) && Number(candidate[key]) >= 0 ? Number(candidate[key]) : undefined
    const id = text("id", 256)
    const sequence = number("sequence")
    const objective = text("objective", 400)
    const status = text("status", 100)
    const tokensUsed = number("tokensUsed")
    const timeUsedSeconds = number("timeUsedSeconds")
    const turnsUsed = number("turnsUsed")
    const autoTurns = number("autoTurns")
    const createdAt = number("createdAt")
    const closedAt = number("closedAt")
    return id && sequence && objective && status && tokensUsed !== undefined && timeUsedSeconds !== undefined && turnsUsed !== undefined && autoTurns !== undefined && createdAt !== undefined && closedAt !== undefined
      ? [{ id, sequence, objective, status, tokensUsed, timeUsedSeconds, turnsUsed, autoTurns, createdAt, closedAt }]
      : []
  }).slice(-100)
}

function outputGoalMetrics(output: unknown): GoalMetricSummary[] | undefined {
  if (typeof output !== "string" || output.length === 0 || output.length > 64 * 1024) return undefined
  try {
    const value = JSON.parse(output)
    if (!record(value)) return undefined
    if (record(value.goal)) return parseGoalMetrics(value.goal.archivedGoals)
    return parseGoalMetrics(value.archived_goals ?? value.archivedGoals)
  } catch {
    return undefined
  }
}

function textFromRecord(value: JsonRecord, key: string, limit: number): string | undefined {
  const item = value[key]
  return typeof item === "string" && item.length <= limit ? item : undefined
}

export function deriveGoal(messages: WorkbenchState["sessions"][string]["messages"]): GoalSummary | undefined {
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

export function deriveGoalHistory(messages: WorkbenchState["sessions"][string]["messages"]): GoalMetricSummary[] {
  let history: GoalMetricSummary[] = []
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool || !GOAL_TOOLS.has(part.tool) ||
        (part.state?.status !== "completed" && part.state?.status !== "complete")) continue
      const parsed = outputGoalMetrics(part.state?.output)
      if (parsed) history = parsed
    }
  }
  return history
}
