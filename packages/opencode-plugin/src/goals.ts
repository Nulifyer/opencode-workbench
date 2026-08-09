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

export interface GoalVerifierConfig {
  enabled: boolean
  model: string | null
  agent: string | null
  timeoutMilliseconds: number
  repeatedBlockThreshold: number
}

export interface GoalVerdictRecord {
  verdict: "continue" | "complete" | "blocked" | "needs-user"
  reason: string
  missingCriteria: string[]
  confidence: "low" | "medium" | "high"
  verifiedAt: number
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
  acceptanceCriteria: string[]
  verifier: GoalVerifierConfig
  evidenceReferences: string[]
  latestVerdict: GoalVerdictRecord | null
  consecutiveBlockedVerdicts: number
  pendingContinuation: boolean
  pendingContinuationMessageID: string | null
  pendingContinuationID: string | null
  pendingContinuationReservedAt: number | null
  settlementGeneration: number
  planReference: string | null
  runGroupReference: string | null
}

export interface GoalState {
  version: 2
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
  acceptanceCriteria?: string[]
  verifier?: Partial<GoalVerifierConfig>
  planReference?: string
  runGroupReference?: string
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
  const verifierValue = record(value.verifier) ? value.verifier : {}
  const autoTurns = integer(value.autoTurns)
  const pendingContinuation = value.pendingContinuation === true && autoTurns > 0 && status === "active"
  const latestVerdictValue = record(value.latestVerdict) && ["continue", "complete", "blocked", "needs-user"].includes(String(value.latestVerdict.verdict))
    ? {
      verdict: value.latestVerdict.verdict as GoalVerdictRecord["verdict"],
      reason: boundedText(value.latestVerdict.reason, 4_000),
      missingCriteria: Array.isArray(value.latestVerdict.missingCriteria) ? value.latestVerdict.missingCriteria.filter((item): item is string => typeof item === "string" && item.length <= 2_000).slice(0, 100) : [],
      confidence: ["low", "medium", "high"].includes(String(value.latestVerdict.confidence)) ? value.latestVerdict.confidence as GoalVerdictRecord["confidence"] : "low" as const,
      verifiedAt: integer(value.latestVerdict.verifiedAt),
    }
    : null
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
    autoTurns,
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
    acceptanceCriteria: Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 2_000).slice(0, 100) : [],
    verifier: {
      enabled: verifierValue.enabled === true,
      model: nullableText(verifierValue.model, 1_024),
      agent: nullableText(verifierValue.agent, 1_024),
      timeoutMilliseconds: Math.min(300_000, Math.max(1_000, integer(verifierValue.timeoutMilliseconds, 60_000))),
      repeatedBlockThreshold: Math.min(10, Math.max(1, integer(verifierValue.repeatedBlockThreshold, 3))),
    },
    evidenceReferences: Array.isArray(value.evidenceReferences) ? value.evidenceReferences.filter((item): item is string => typeof item === "string" && item.length <= 1_024).slice(0, 500) : [],
    latestVerdict: latestVerdictValue,
    consecutiveBlockedVerdicts: integer(value.consecutiveBlockedVerdicts),
    pendingContinuation,
    pendingContinuationMessageID: pendingContinuation ? nullableText(value.pendingContinuationMessageID, 256) : null,
    pendingContinuationID: pendingContinuation ? nullableText(value.pendingContinuationID, 256) : null,
    pendingContinuationReservedAt: !pendingContinuation || value.pendingContinuationReservedAt === null
      ? null
      : integer(value.pendingContinuationReservedAt) || null,
    settlementGeneration: integer(value.settlementGeneration),
    planReference: nullableText(value.planReference, 8_192),
    runGroupReference: nullableText(value.runGroupReference, 1_024),
  }
}

export function emptyGoalState(): GoalState {
  return { version: 2, goals: Object.create(null) as Record<string, Goal> }
}

export function parseGoalState(value: unknown): GoalState {
  if (!record(value) || (value.version !== 1 && value.version !== 2) || !record(value.goals)) throw new Error("Invalid or unsupported Workbench goal state")
  const goals = Object.create(null) as Record<string, Goal>
  for (const [key, candidate] of Object.entries(value.goals).slice(0, MAX_GOALS)) {
    const goal = parseGoal(candidate, key)
    if (!goal) throw new Error("Invalid Workbench goal state")
    goals[key] = goal
  }
  return { version: 2, goals }
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

function advanceSettlementGeneration(goal: Goal): void {
  goal.settlementGeneration += 1
}

function clearPendingContinuation(goal: Goal): void {
  goal.pendingContinuation = false
  goal.pendingContinuationMessageID = null
  goal.pendingContinuationID = null
  goal.pendingContinuationReservedAt = null
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
  const previousStatus = goal.status
  accountTime(goal, at)
  applyLimits(goal)
  if (goal.status !== previousStatus) advanceSettlementGeneration(goal)
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
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map((criterion) => requiredText(criterion, "Acceptance criterion")).slice(0, 100),
    verifier: {
      enabled: input.verifier?.enabled === true,
      model: nullableText(input.verifier?.model, 1_024),
      agent: nullableText(input.verifier?.agent, 1_024),
      timeoutMilliseconds: Math.min(300_000, Math.max(1_000, integer(input.verifier?.timeoutMilliseconds, 60_000))),
      repeatedBlockThreshold: Math.min(10, Math.max(1, integer(input.verifier?.repeatedBlockThreshold, 3))),
    },
    evidenceReferences: [],
    latestVerdict: null,
    consecutiveBlockedVerdicts: 0,
    pendingContinuation: false,
    pendingContinuationMessageID: null,
    pendingContinuationID: null,
    pendingContinuationReservedAt: null,
    settlementGeneration: 0,
    planReference: nullableText(input.planReference, 8_192),
    runGroupReference: nullableText(input.runGroupReference, 1_024),
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
  goal.latestVerdict = null
  goal.evidenceReferences = []
  goal.consecutiveBlockedVerdicts = 0
  clearPendingContinuation(goal)
  advanceSettlementGeneration(goal)
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
  if (status === "paused") clearPendingContinuation(goal)
  goal.lastStatus = status === "active" ? "Goal resumed." : "Goal paused."
  advanceSettlementGeneration(goal)
  pushHistory(goal, status === "active" ? "resumed" : "paused", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function closeGoal(state: GoalState, sessionID: string, status: "complete" | "unmet", detail: string | undefined, at = nowSeconds()): GoalSnapshot {
  const goal = state.goals[sessionID]
  if (!goal) throw new Error("This session has no goal")
  const resolvedDetail = requiredText(detail, status === "complete" ? "Completion evidence" : "Blocker")
  accountTime(goal, at)
  goal.status = status
  goal.updatedAt = at
  goal.closedAt = at
  clearPendingContinuation(goal)
  advanceSettlementGeneration(goal)
  goal.lastAccountedAt = null
  if (status === "complete") {
    goal.completionEvidence = resolvedDetail
    goal.blocker = null
    goal.stopReason = null
    goal.lastStatus = "Goal completed."
    pushHistory(goal, "completed", goal.completionEvidence, at)
  } else {
    goal.blocker = resolvedDetail
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
    advanceSettlementGeneration(goal)
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
  const previousTokens = goal.tokensUsed
  const previousStatus = goal.status
  accountTime(goal, at)
  if (Number.isSafeInteger(tokens) && tokens >= 0) {
    if (goal.tokenBaseline === null) goal.tokenBaseline = Math.max(0, tokens - goal.tokensUsed)
    goal.tokensUsed = Math.max(goal.tokensUsed, tokens - goal.tokenBaseline)
  }
  applyLimits(goal)
  if (goal.tokensUsed !== previousTokens || goal.status !== previousStatus) advanceSettlementGeneration(goal)
  goal.updatedAt = at
  return snapshotGoal(goal, at)
}

export function reserveGoalAutoContinue(
  state: GoalState,
  sessionID: string,
  at = nowSeconds(),
  continuationID?: string,
  continuationMessageID?: string,
): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal) return null
  accountTime(goal, at)
  applyLimits(goal)
  if (goal.status !== "active") {
    goal.updatedAt = at
    return null
  }
  if (goal.pendingContinuation) {
    let attachedIdentity = false
    if (!goal.pendingContinuationID && continuationID) {
      goal.pendingContinuationID = boundedText(continuationID, 256).trim() || null
      attachedIdentity = goal.pendingContinuationID !== null
    }
    if (!goal.pendingContinuationMessageID && continuationMessageID) {
      goal.pendingContinuationMessageID = boundedText(continuationMessageID, 256).trim() || null
      attachedIdentity = attachedIdentity || goal.pendingContinuationMessageID !== null
    }
    if (attachedIdentity) {
      goal.pendingContinuationReservedAt ??= at
      goal.updatedAt = at
      advanceSettlementGeneration(goal)
    }
    return snapshotGoal(goal, at)
  }
  if (goal.maxAutoTurns !== null && goal.autoTurns >= goal.maxAutoTurns) {
    goal.status = "usageLimited"
    goal.lastAccountedAt = null
    goal.stopReason = `max auto-turns reached (${goal.autoTurns}/${goal.maxAutoTurns})`
    goal.lastStatus = "Auto-turn limit reached; user action is required."
    goal.updatedAt = at
    advanceSettlementGeneration(goal)
    pushHistory(goal, "limited", goal.stopReason, at)
    return null
  }
  goal.autoTurns += 1
  goal.pendingContinuation = true
  goal.pendingContinuationMessageID = continuationMessageID ? boundedText(continuationMessageID, 256).trim() || null : null
  goal.pendingContinuationID = continuationID ? boundedText(continuationID, 256).trim() || null : null
  goal.pendingContinuationReservedAt = at
  advanceSettlementGeneration(goal)
  goal.lastStatus = `Auto-continuation ${goal.autoTurns} admitted.`
  goal.updatedAt = at
  pushHistory(goal, "autoContinue", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function cancelGoalAutoContinueReservation(state: GoalState, sessionID: string, reservedTurn: number, at = nowSeconds()): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal) return null
  if (goal.pendingContinuation && goal.autoTurns === reservedTurn && reservedTurn > 0) {
    goal.autoTurns -= 1
    clearPendingContinuation(goal)
    advanceSettlementGeneration(goal)
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
  clearPendingContinuation(goal)
  goal.lastAccountedAt = null
  goal.stopReason = "auto-continuation failed"
  goal.lastStatus = `Auto-continuation failed: ${summarize(detail)}`
  goal.updatedAt = at
  advanceSettlementGeneration(goal)
  pushHistory(goal, "error", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function commitGoalContinuation(state: GoalState, sessionID: string, at = nowSeconds()): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal) return null
  if (goal.pendingContinuation) advanceSettlementGeneration(goal)
  clearPendingContinuation(goal)
  goal.updatedAt = at
  return snapshotGoal(goal, at)
}

export function pauseGoalContinuationRecovery(state: GoalState, sessionID: string, detail: string, at = nowSeconds()): GoalSnapshot | null {
  const goal = state.goals[sessionID]
  if (!goal || goal.status !== "active" || !goal.pendingContinuation) return goal ? snapshotGoal(goal, at) : null
  accountTime(goal, at)
  goal.status = "paused"
  clearPendingContinuation(goal)
  goal.lastAccountedAt = null
  goal.stopReason = "auto-continuation recovery required"
  goal.blocker = "OpenCode history could not establish whether the reserved continuation was admitted."
  goal.lastStatus = `Auto-continuation recovery paused: ${summarize(detail)} Review the session transcript, then explicitly resume the goal to continue.`
  goal.updatedAt = at
  advanceSettlementGeneration(goal)
  pushHistory(goal, "warning", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function configureGoalVerification(state: GoalState, sessionID: string, input: { acceptanceCriteria?: string[]; tokenBudget?: number | null; maxAutoTurns?: number | null; maxDurationSeconds?: number | null; verifier?: Partial<GoalVerifierConfig>; planReference?: string | null; runGroupReference?: string | null }, at = nowSeconds()): GoalSnapshot {
  const goal = state.goals[sessionID]
  if (!goal) throw new Error("This session has no goal")
  if (input.acceptanceCriteria) goal.acceptanceCriteria = input.acceptanceCriteria.map((criterion) => requiredText(criterion, "Acceptance criterion")).slice(0, 100)
  if (input.tokenBudget !== undefined) goal.tokenBudget = positiveOrNull(input.tokenBudget)
  if (input.maxAutoTurns !== undefined) goal.maxAutoTurns = positiveOrNull(input.maxAutoTurns)
  if (input.maxDurationSeconds !== undefined) goal.maxDurationSeconds = positiveOrNull(input.maxDurationSeconds)
  if (input.verifier) goal.verifier = {
    enabled: input.verifier.enabled ?? goal.verifier.enabled,
    model: input.verifier.model === undefined ? goal.verifier.model : nullableText(input.verifier.model, 1_024),
    agent: input.verifier.agent === undefined ? goal.verifier.agent : nullableText(input.verifier.agent, 1_024),
    timeoutMilliseconds: Math.min(300_000, Math.max(1_000, integer(input.verifier.timeoutMilliseconds, goal.verifier.timeoutMilliseconds))),
    repeatedBlockThreshold: Math.min(10, Math.max(1, integer(input.verifier.repeatedBlockThreshold, goal.verifier.repeatedBlockThreshold))),
  }
  if (input.planReference !== undefined) goal.planReference = nullableText(input.planReference, 8_192)
  if (input.runGroupReference !== undefined) goal.runGroupReference = nullableText(input.runGroupReference, 1_024)
  applyLimits(goal)
  goal.latestVerdict = null
  goal.consecutiveBlockedVerdicts = 0
  advanceSettlementGeneration(goal)
  goal.updatedAt = at
  pushHistory(goal, "updated", "Goal verification configuration updated.", at)
  return snapshotGoal(goal, at)
}

export function recordGoalVerdict(
  state: GoalState,
  sessionID: string,
  verdict: Omit<GoalVerdictRecord, "verifiedAt">,
  evidenceReferences: string[] = [],
  at = nowSeconds(),
  expectedSettlementGeneration?: number,
): GoalSnapshot {
  const goal = state.goals[sessionID]
  if (!goal) throw new Error("This session has no goal")
  if (expectedSettlementGeneration !== undefined && goal.settlementGeneration !== expectedSettlementGeneration) {
    throw new Error("Verifier verdict is stale because the goal changed")
  }
  const recordValue: GoalVerdictRecord = {
    verdict: verdict.verdict,
    reason: requiredText(verdict.reason, "Verifier reason"),
    missingCriteria: verdict.missingCriteria.map((criterion) => requiredText(criterion, "Missing criterion")).slice(0, 100),
    confidence: verdict.confidence,
    verifiedAt: at,
  }
  goal.latestVerdict = recordValue
  goal.evidenceReferences = [...new Set([...goal.evidenceReferences, ...evidenceReferences.filter((value) => typeof value === "string" && value.length <= 1_024)])].slice(-500)
  goal.consecutiveBlockedVerdicts = verdict.verdict === "blocked" ? goal.consecutiveBlockedVerdicts + 1 : 0
  // A continue verdict keeps the goal active. The scheduler records a future
  // prompt reservation separately; preserve one only if it was already
  // durably counted before this verdict was applied.
  if (verdict.verdict !== "continue") clearPendingContinuation(goal)
  advanceSettlementGeneration(goal)
  goal.lastStatus = `Verifier: ${verdict.verdict} — ${summarize(verdict.reason)}`
  if (verdict.verdict === "blocked" && goal.consecutiveBlockedVerdicts >= goal.verifier.repeatedBlockThreshold) {
    goal.status = "unmet"
    goal.blocker = recordValue.reason
    goal.stopReason = "verified blocked"
    goal.closedAt = at
    clearPendingContinuation(goal)
  } else if (verdict.verdict === "complete") {
    goal.status = "complete"
    goal.completionEvidence = recordValue.reason
    goal.closedAt = at
    clearPendingContinuation(goal)
  } else if (verdict.verdict === "needs-user") {
    goal.status = "paused"
    goal.blocker = recordValue.reason
    clearPendingContinuation(goal)
  }
  goal.updatedAt = at
  pushHistory(goal, verdict.verdict === "blocked" ? "warning" : "updated", goal.lastStatus, at)
  return snapshotGoal(goal, at)
}

export function goalHistoryReport(goal: GoalSnapshot | null): string {
  if (!goal) return "No goal history is available for this session."
  if (!goal.history.length) return "No goal history recorded yet."
  return goal.history.map((entry) => `- [${new Date(entry.timestamp * 1_000).toISOString()}] ${entry.type}: ${entry.detail}`).join("\n")
}
