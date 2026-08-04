export type GoalStatus = "active" | "paused" | "budgetLimited" | "usageLimited" | "complete" | "unmet"
export type MutableGoalStatus = "active" | "paused"

export interface GoalHistoryEntry {
  type: "created" | "updated" | "paused" | "resumed" | "completed" | "unmet" | "checkpoint" | "limited" | "autoContinue" | "warning" | "error"
  detail: string
  timestamp: number
}

export interface GoalCheckpoint {
  summary: string
  timestamp: number
}

export interface Goal {
  sessionID: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokenBaseline: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  lastAccountedAt: number | null
  autoTurns: number
  maxAutoTurns: number | null
  maxDurationSeconds: number | null
  lastStatus: string | null
  stopReason: string | null
  completionEvidence: string | null
  blocker: string | null
  closedAt: number | null
  history: GoalHistoryEntry[]
  checkpoints: GoalCheckpoint[]
  lastCheckpoint: GoalCheckpoint | null
}

export interface GoalState {
  version: 1
  goals: Record<string, Goal>
}

export interface GoalSnapshot extends Omit<Goal, "lastAccountedAt" | "tokenBaseline"> {
  remainingTokens: number | null
  sampledAt: number
}

export interface CreateGoalInput {
  objective: string
  tokenBudget?: number | null
  maxAutoTurns?: number | null
  maxDurationSeconds?: number | null
  agent?: string
}

const MAX_GOALS = 2_000
const MAX_HISTORY = 50
const MAX_CHECKPOINTS = 8

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function nonNegativeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function boundedText(value: unknown, limit: number, fallback = ""): string {
  return typeof value === "string" && value.length <= limit ? value : fallback
}

function nullableText(value: unknown, limit: number): string | null {
  return value === null || value === undefined ? null : boundedText(value, limit) || null
}

function summarize(value: string, limit = 400): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function objective(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error("Goal objective must not be empty")
  if ([...normalized].length > 4_000) throw new Error("Goal objective must be at most 4,000 characters")
  return normalized
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${label} must not be empty`)
  if ([...normalized].length > 4_000) throw new Error(`${label} must be at most 4,000 characters`)
  return normalized
}

function history(value: unknown): GoalHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!record(entry) || !["created", "updated", "paused", "resumed", "completed", "unmet", "checkpoint", "limited", "autoContinue", "warning", "error"].includes(String(entry.type))) return []
    const detail = boundedText(entry.detail, 4_000).trim()
    if (!detail) return []
    return [{ type: entry.type as GoalHistoryEntry["type"], detail: summarize(detail), timestamp: integer(entry.timestamp) }]
  }).slice(-MAX_HISTORY)
}

function checkpoints(value: unknown): GoalCheckpoint[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!record(entry)) return []
    const summary = boundedText(entry.summary, 4_000).trim()
    return summary ? [{ summary: summarize(summary, 280), timestamp: integer(entry.timestamp) }] : []
  }).slice(-MAX_CHECKPOINTS)
}

function parseGoal(value: unknown, key: string): Goal | undefined {
  if (!record(value)) return undefined
  const sessionID = boundedText(value.sessionID, 1_024, key)
  const goalObjective = boundedText(value.objective, 4_000).trim()
  const status = String(value.status) as GoalStatus
  if (!sessionID || sessionID !== key || !goalObjective || !["active", "paused", "budgetLimited", "usageLimited", "complete", "unmet"].includes(status)) return undefined
  const goalCheckpoints = checkpoints(value.checkpoints)
  const lastCheckpointValue = record(value.lastCheckpoint)
    ? checkpoints([value.lastCheckpoint])[0] ?? null
    : goalCheckpoints.at(-1) ?? null
  return {
    sessionID,
    objective: goalObjective,
    status,
    tokenBudget: positiveOrNull(value.tokenBudget),
    tokenBaseline: nonNegativeOrNull(value.tokenBaseline),
    tokensUsed: integer(value.tokensUsed),
    timeUsedSeconds: integer(value.timeUsedSeconds),
    createdAt: integer(value.createdAt),
    updatedAt: integer(value.updatedAt),
    lastAccountedAt: value.lastAccountedAt === null ? null : integer(value.lastAccountedAt) || null,
    autoTurns: integer(value.autoTurns),
    maxAutoTurns: positiveOrNull(value.maxAutoTurns),
    maxDurationSeconds: positiveOrNull(value.maxDurationSeconds),
    lastStatus: nullableText(value.lastStatus, 4_000),
    stopReason: nullableText(value.stopReason, 4_000),
    completionEvidence: nullableText(value.completionEvidence, 4_000),
    blocker: nullableText(value.blocker, 4_000),
    closedAt: value.closedAt === null ? null : integer(value.closedAt) || null,
    history: history(value.history),
    checkpoints: goalCheckpoints,
    lastCheckpoint: lastCheckpointValue,
  }
}

export function emptyGoalState(): GoalState {
  return { version: 1, goals: Object.create(null) as Record<string, Goal> }
}

export function parseGoalState(value: unknown): GoalState {
  if (!record(value) || value.version !== 1 || !record(value.goals)) throw new Error("Invalid or unsupported Workbench goal state")
  const goals = Object.create(null) as Record<string, Goal>
  for (const [key, candidate] of Object.entries(value.goals).slice(0, MAX_GOALS)) {
    const goal = parseGoal(candidate, key)
    if (!goal) throw new Error("Invalid Workbench goal state")
    goals[key] = goal
  }
  return { version: 1, goals }
}

export function importLegacyGoalState(value: unknown): GoalState | undefined {
  try {
    return parseGoalState(value)
  } catch {
    return undefined
  }
}

function pushHistory(goal: Goal, type: GoalHistoryEntry["type"], detail: string, at = nowSeconds()): void {
  const value = summarize(detail)
  if (!value) return
  goal.history = [...goal.history, { type, detail: value, timestamp: at }].slice(-MAX_HISTORY)
}

function accountTime(goal: Goal, at = nowSeconds()): void {
  if (goal.status !== "active") return
  if (goal.lastAccountedAt !== null) goal.timeUsedSeconds += Math.max(0, at - goal.lastAccountedAt)
  goal.lastAccountedAt = at
}

function applyLimits(goal: Goal): void {
  if (goal.status !== "active") return
  if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
    goal.status = "budgetLimited"
    goal.lastAccountedAt = null
    goal.stopReason = `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`
    goal.lastStatus = "Token budget reached; user action is required."
    pushHistory(goal, "limited", goal.stopReason)
  } else if (goal.maxDurationSeconds !== null && goal.timeUsedSeconds >= goal.maxDurationSeconds) {
    goal.status = "usageLimited"
    goal.lastAccountedAt = null
    goal.stopReason = `max duration reached (${goal.maxDurationSeconds}s)`
    goal.lastStatus = "Duration limit reached; user action is required."
    pushHistory(goal, "limited", goal.stopReason)
  }
}

export function snapshotGoal(goal: Goal, at = nowSeconds()): GoalSnapshot {
  const extra = goal.status === "active" && goal.lastAccountedAt !== null ? Math.max(0, at - goal.lastAccountedAt) : 0
  const timeUsedSeconds = goal.timeUsedSeconds + extra
  const { lastAccountedAt: _lastAccountedAt, tokenBaseline: _tokenBaseline, ...visible } = goal
  return {
    ...visible,
    timeUsedSeconds,
    remainingTokens: goal.tokenBudget === null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed),
    sampledAt: at,
  }
}

export function refreshGoal(state: GoalState, sessionID: string, at = nowSeconds()): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal) return null
  accountTime(goal, at)
  applyLimits(goal)
  goal.updatedAt = at
  return snapshotGoal(goal, at)
}

export function createGoal(state: GoalState, sessionID: string, input: CreateGoalInput, at = nowSeconds()): GoalSnapshot {
  const existing = state.goals[sessionID]
  if (existing && existing.status !== "complete" && existing.status !== "unmet") throw new Error("This session already has a non-closed goal")
  if (!existing && Object.keys(state.goals).length >= MAX_GOALS) throw new Error("Workbench goal state has reached its session limit")
  const paused = input.agent?.trim().toLowerCase() === "plan"
  const goal: Goal = {
    sessionID,
    objective: objective(input.objective),
    status: paused ? "paused" : "active",
    tokenBudget: positiveOrNull(input.tokenBudget),
    tokenBaseline: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: at,
    updatedAt: at,
    lastAccountedAt: paused ? null : at,
    autoTurns: 0,
    maxAutoTurns: positiveOrNull(input.maxAutoTurns),
    maxDurationSeconds: positiveOrNull(input.maxDurationSeconds),
    lastStatus: paused ? "Goal recorded in Plan mode; switch to Build mode to resume it." : "Goal set.",
    stopReason: paused ? "plan mode" : null,
    completionEvidence: null,
    blocker: paused ? "Goal execution is paused while the session is in Plan mode." : null,
    closedAt: null,
    history: [],
    checkpoints: [],
    lastCheckpoint: null,
  }
  pushHistory(goal, "created", paused ? "Goal created and paused in Plan mode." : "Goal created.", at)
  state.goals[sessionID] = goal
  return snapshotGoal(goal, at)
}

export function updateGoalObjective(state: GoalState, sessionID: string, nextObjective: string, status?: MutableGoalStatus, agent?: string, at = nowSeconds()): GoalSnapshot {
  const goal = state.goals[sessionID]
  if (!goal) throw new Error("This session has no goal")
  accountTime(goal, at)
  const nextStatus = status ?? (goal.status === "active" ? "active" : "paused")
  const pausedForPlan = nextStatus === "active" && agent?.trim().toLowerCase() === "plan"
  goal.objective = objective(nextObjective)
  goal.status = pausedForPlan ? "paused" : nextStatus
  goal.updatedAt = at
  goal.lastAccountedAt = goal.status === "active" ? at : null
  goal.stopReason = pausedForPlan ? "plan mode" : goal.status === "paused" ? "paused" : null
  goal.blocker = pausedForPlan ? "Goal execution is paused while the session is in Plan mode." : null
  goal.completionEvidence = null
  goal.closedAt = null
  goal.lastStatus = pausedForPlan ? "Goal objective updated and paused in Plan mode." : `Goal objective updated and ${goal.status === "active" ? "resumed" : "paused"}.`
  pushHistory(goal, "updated", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function setGoalStatus(state: GoalState, sessionID: string, status: MutableGoalStatus, agent?: string, at = nowSeconds()): GoalSnapshot {
  const goal = state.goals[sessionID]
  if (!goal) throw new Error("This session has no goal")
  if (status === "active" && agent?.trim().toLowerCase() === "plan") throw new Error("Cannot resume a goal in Plan mode; switch to Build mode first")
  accountTime(goal, at)
  goal.status = status
  goal.updatedAt = at
  goal.lastAccountedAt = status === "active" ? at : null
  goal.stopReason = status === "paused" ? "paused" : null
  goal.blocker = status === "active" ? null : goal.blocker
  goal.lastStatus = status === "active" ? "Goal resumed." : "Goal paused."
  pushHistory(goal, status === "active" ? "resumed" : "paused", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function closeGoal(state: GoalState, sessionID: string, status: "complete" | "unmet", detail: string | undefined, at = nowSeconds()): GoalSnapshot {
  const goal = state.goals[sessionID]
  if (!goal) throw new Error("This session has no goal")
  accountTime(goal, at)
  goal.status = status
  goal.updatedAt = at
  goal.closedAt = at
  goal.lastAccountedAt = null
  if (status === "complete") {
    goal.completionEvidence = requiredText(detail, "Completion evidence")
    goal.blocker = null
    goal.stopReason = null
    goal.lastStatus = "Goal completed."
    pushHistory(goal, "completed", goal.completionEvidence, at)
  } else {
    goal.blocker = requiredText(detail, "Blocker")
    goal.completionEvidence = null
    goal.stopReason = "blocked"
    goal.lastStatus = "Goal marked unmet."
    pushHistory(goal, "unmet", goal.blocker, at)
  }
  return snapshotGoal(goal, at)
}

export function recordGoalCheckpoint(state: GoalState, sessionID: string, summary: string, at = nowSeconds()): GoalSnapshot {
  const goal = state.goals[sessionID]
  if (!goal) throw new Error("This session has no goal")
  if (goal.status !== "active") throw new Error("Progress checkpoints require an active goal")
  const checkpoint = { summary: summarize(requiredText(summary, "Checkpoint"), 280), timestamp: at }
  if (goal.lastCheckpoint?.summary !== checkpoint.summary) {
    goal.lastCheckpoint = checkpoint
    goal.checkpoints = [...goal.checkpoints, checkpoint].slice(-MAX_CHECKPOINTS)
    pushHistory(goal, "checkpoint", checkpoint.summary, at)
  }
  goal.lastStatus = "Goal checkpoint recorded."
  goal.updatedAt = at
  return snapshotGoal(goal, at)
}

export function clearGoal(state: GoalState, sessionID: string): boolean {
  const existed = Object.hasOwn(state.goals, sessionID)
  delete state.goals[sessionID]
  return existed
}

export function accountGoalTokens(state: GoalState, sessionID: string, tokens: number, at = nowSeconds()): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal) return null
  accountTime(goal, at)
  if (Number.isSafeInteger(tokens) && tokens >= 0) {
    if (goal.tokenBaseline === null) goal.tokenBaseline = Math.max(0, tokens - goal.tokensUsed)
    goal.tokensUsed = Math.max(goal.tokensUsed, tokens - goal.tokenBaseline)
  }
  applyLimits(goal)
  goal.updatedAt = at
  return snapshotGoal(goal, at)
}

export function reserveGoalAutoContinue(state: GoalState, sessionID: string, at = nowSeconds()): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal) return null
  accountTime(goal, at)
  applyLimits(goal)
  if (goal.status !== "active") {
    goal.updatedAt = at
    return null
  }
  if (goal.maxAutoTurns !== null && goal.autoTurns >= goal.maxAutoTurns) {
    goal.status = "usageLimited"
    goal.lastAccountedAt = null
    goal.stopReason = `max auto-turns reached (${goal.autoTurns}/${goal.maxAutoTurns})`
    goal.lastStatus = "Auto-turn limit reached; user action is required."
    goal.updatedAt = at
    pushHistory(goal, "limited", goal.stopReason, at)
    return null
  }
  goal.autoTurns += 1
  goal.lastStatus = `Auto-continuation ${goal.autoTurns} admitted.`
  goal.updatedAt = at
  pushHistory(goal, "autoContinue", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function cancelGoalAutoContinueReservation(state: GoalState, sessionID: string, reservedTurn: number, at = nowSeconds()): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal) return null
  if (goal.autoTurns === reservedTurn && reservedTurn > 0) {
    goal.autoTurns -= 1
    goal.lastStatus = "Auto-continuation cancelled before prompt admission."
    goal.updatedAt = at
    pushHistory(goal, "warning", goal.lastStatus, at)
  }
  return snapshotGoal(goal, at)
}

export function failGoalAutoContinue(state: GoalState, sessionID: string, detail: string, at = nowSeconds()): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal || goal.status !== "active") return goal ? snapshotGoal(goal, at) : null
  accountTime(goal, at)
  goal.status = "paused"
  goal.lastAccountedAt = null
  goal.stopReason = "auto-continuation failed"
  goal.lastStatus = `Auto-continuation failed: ${summarize(detail)}`
  goal.updatedAt = at
  pushHistory(goal, "error", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function goalHistoryReport(goal: GoalSnapshot | null): string {
  if (!goal) return "No goal history is available for this session."
  if (!goal.history.length) return "No goal history recorded yet."
  return goal.history.map((entry) => `- [${new Date(entry.timestamp * 1_000).toISOString()}] ${entry.type}: ${entry.detail}`).join("\n")
}
