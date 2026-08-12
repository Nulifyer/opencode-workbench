import type {
  DelegationProgress,
  MessageBundle,
  RunGroup,
  RunPhase,
  WorktreeJournalEntry,
  WorktreePhase,
} from "@opencode-workbench/shared"

export type JobGroup = "needs-input" | "running" | "failed" | "completed"
export type JobSource = "delegation" | "run" | "worktree"

export interface JobActivitySummary {
  messageID: string
  role: "user" | "assistant"
  tool?: string
  toolStatus?: string
}

/** A read-only, transport-friendly projection. It intentionally contains no execution controls. */
export interface JobSummary {
  id: string
  source: JobSource
  group: JobGroup
  title: string
  status: string
  updatedAt: number
  sessionID?: string
  parentSessionID?: string
  runGroupID?: string
  runID?: string
  worktreeID?: string
  model?: string
  agent?: string
  variant?: string
  directory?: string
  branch?: string
  messageCount?: number
  recentActivity?: JobActivitySummary[]
  error?: string
  retained?: boolean
  discarded?: boolean
}

export interface JobProjectionInput {
  selectedSessionID?: string
  delegations?: readonly DelegationProgress[]
  runGroups?: readonly RunGroup[]
  worktrees?: readonly WorktreeJournalEntry[]
  /** Session input is authoritative; callers derive this set from OpenCode questions and permissions. */
  needsInputSessionIDs?: readonly string[]
}

export interface JobProjectionOptions {
  capacity?: number
  recentActivityLimit?: number
}

const GROUP_PRIORITY: Readonly<Record<JobGroup, number>> = {
  "needs-input": 0,
  running: 1,
  failed: 2,
  completed: 3,
}
const DEFAULT_CAPACITY = 500
const MAX_CAPACITY = 2_000
const DEFAULT_ACTIVITY_LIMIT = 20
const MAX_ACTIVITY_LIMIT = 100
const MAX_TEXT = 2_000

function boundedText(value: unknown, fallback = ""): string {
  return (typeof value === "string" ? value : fallback).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(
    0,
    MAX_TEXT,
  )
}

function lastMessageTime(messages: readonly MessageBundle[]): number {
  return messages.reduce(
    (latest, message) => Math.max(latest, message.info.time?.completed ?? message.info.time?.created ?? 0),
    0,
  )
}

function activity(messages: readonly MessageBundle[], limit: number): JobActivitySummary[] {
  return messages.slice(-limit).map((message) => {
    const toolPart = [...message.parts].reverse().find((part) => part.type === "tool" && typeof part.tool === "string")
    return {
      messageID: boundedText(message.info.id),
      role: message.info.role,
      tool: toolPart?.tool ? boundedText(toolPart.tool) : undefined,
      toolStatus: typeof toolPart?.state?.status === "string" ? boundedText(toolPart.state.status) : undefined,
    }
  })
}

function delegationGroup(value: DelegationProgress, needsInput: ReadonlySet<string>): JobGroup {
  if (needsInput.has(value.sessionID)) return "needs-input"
  if (value.status.type === "error") return "failed"
  if (value.status.type === "busy" || value.status.type === "retry") return "running"
  return "completed"
}

function runGroup(phase: RunPhase): JobGroup {
  if (phase === "needs-input") return "needs-input"
  if (phase === "pending" || phase === "preparing" || phase === "admitting" || phase === "working") return "running"
  if (phase === "failed") return "failed"
  return "completed"
}

function worktreeGroup(phase: WorktreePhase): JobGroup {
  if (phase === "cleanup-pending" || phase === "retained-dirty") return "needs-input"
  if (
    phase === "requested" || phase === "creating" || phase === "setup-running" || phase === "session-creating" ||
    phase === "prompt-admitting"
  ) return "running"
  if (phase === "failed") return "failed"
  return "completed"
}

function errorMessage(value: { message?: unknown } | undefined): string | undefined {
  const message = boundedText(value?.message)
  return message || undefined
}

function compareJobs(left: JobSummary, right: JobSummary): number {
  return GROUP_PRIORITY[left.group] - GROUP_PRIORITY[right.group] ||
    right.updatedAt - left.updatedAt ||
    left.id.localeCompare(right.id)
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(maximum, Math.floor(value))
    : fallback
}

/** Projects OpenCode-owned delegations and run state into one bounded Jobs feed. */
export class JobProjectionService {
  private readonly capacity: number
  private readonly recentActivityLimit: number

  constructor(options: JobProjectionOptions = {}) {
    this.capacity = boundedOption(options.capacity, DEFAULT_CAPACITY, MAX_CAPACITY)
    this.recentActivityLimit = boundedOption(options.recentActivityLimit, DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT)
  }

  project(input: JobProjectionInput): JobSummary[] {
    const needsInput = new Set(input.needsInputSessionIDs ?? [])
    const delegations = new Map<string, DelegationProgress>()
    for (const candidate of input.delegations ?? []) {
      if (!candidate.sessionID || candidate.sessionID === "pending") continue
      const previous = delegations.get(candidate.sessionID)
      if (!previous || candidate.revision >= previous.revision) delegations.set(candidate.sessionID, candidate)
    }

    const jobs: JobSummary[] = []
    const consumedSessions = new Set<string>()
    const referencedWorktrees = new Set<string>()

    for (const group of input.runGroups ?? []) {
      for (const run of group.runs) {
        if (run.worktreeID) referencedWorktrees.add(run.worktreeID)
        const sessionID = run.session.sessionID !== "pending" ? run.session.sessionID : undefined
        const delegation = sessionID ? delegations.get(sessionID) : undefined
        const projectedGroup = runGroup(run.phase)
        if (sessionID && delegation) consumedSessions.add(sessionID)
        jobs.push({
          id: `run:${boundedText(group.id)}:${boundedText(run.id)}`,
          source: "run",
          group: projectedGroup === "running" && sessionID && needsInput.has(sessionID)
            ? "needs-input"
            : projectedGroup,
          title: boundedText(group.title, `Run ${run.id}`),
          status: run.phase,
          updatedAt: run.completedAt ??
            Math.max(run.startedAt ?? group.createdAt, delegation ? lastMessageTime(delegation.messages) : 0),
          sessionID,
          runGroupID: boundedText(group.id),
          runID: boundedText(run.id),
          worktreeID: run.worktreeID ? boundedText(run.worktreeID) : undefined,
          model: boundedText(run.model) || undefined,
          agent: boundedText(run.agent) || undefined,
          variant: boundedText(run.variant) || undefined,
          directory: sessionID ? boundedText(run.session.directory) : undefined,
          messageCount: delegation?.messages.length,
          recentActivity: delegation ? activity(delegation.messages, this.recentActivityLimit) : undefined,
          error: errorMessage(run.error),
          retained: run.retained,
          discarded: run.discarded,
        })
      }
    }

    for (const worktree of input.worktrees ?? []) {
      if (referencedWorktrees.has(worktree.id)) continue
      const delegation = worktree.sessionID ? delegations.get(worktree.sessionID) : undefined
      if (worktree.sessionID && delegation) consumedSessions.add(worktree.sessionID)
      jobs.push({
        id: `worktree:${boundedText(worktree.id)}`,
        source: "worktree",
        group: delegation ? delegationGroup(delegation, needsInput) : worktreeGroup(worktree.phase),
        title: delegation
          ? boundedText(delegation.title, "Delegated session")
          : boundedText(worktree.branch, "Isolated worktree"),
        status: delegation?.status.type ?? worktree.phase,
        updatedAt: Math.max(worktree.updatedAt, delegation ? lastMessageTime(delegation.messages) : 0),
        sessionID: worktree.sessionID ? boundedText(worktree.sessionID) : undefined,
        worktreeID: boundedText(worktree.id),
        directory: boundedText(worktree.path) || undefined,
        branch: boundedText(worktree.branch) || undefined,
        messageCount: delegation?.messages.length,
        recentActivity: delegation ? activity(delegation.messages, this.recentActivityLimit) : undefined,
        error: delegation?.status.type === "error"
          ? boundedText(delegation.status.message) || "OpenCode session failed"
          : errorMessage(worktree.error),
      })
    }

    for (const delegation of delegations.values()) {
      if (consumedSessions.has(delegation.sessionID)) continue
      jobs.push({
        id: `delegation:${boundedText(delegation.sessionID)}`,
        source: "delegation",
        group: delegationGroup(delegation, needsInput),
        title: boundedText(delegation.title, "Delegated session"),
        status: delegation.status.type,
        updatedAt: lastMessageTime(delegation.messages),
        sessionID: boundedText(delegation.sessionID),
        parentSessionID: input.selectedSessionID ? boundedText(input.selectedSessionID) : undefined,
        messageCount: delegation.messages.length,
        recentActivity: activity(delegation.messages, this.recentActivityLimit),
        error: delegation.status.type === "error"
          ? boundedText(delegation.status.message) || "OpenCode session failed"
          : undefined,
      })
    }

    return jobs.sort(compareJobs).slice(0, this.capacity).map((job) => ({
      ...job,
      recentActivity: job.recentActivity?.map((entry) => ({ ...entry })),
    }))
  }
}
