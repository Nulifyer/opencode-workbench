import type {
  ChatSnapshot,
  ChatSnapshotProjection,
  ChatSnapshotProjectionOmissions,
  EvidenceReference,
  RunComparisonSnapshot,
  RunGroup,
  TaskArtifactSummary,
  WalkthroughDocument,
  WorktreeJournalEntry,
} from "@opencode-workbench/shared"
import { encodedBytes } from "@opencode-workbench/shared"

/**
 * Protocol v2 permits 32 MiB messages. Keeping the transport snapshot at most
 * 24 MiB leaves deterministic headroom for the event envelope, editor
 * context, and future protocol fields without changing any durable service.
 */
export const WEBVIEW_SNAPSHOT_BYTE_LIMIT = 24 * 1024 * 1024
const ADMISSION_HEADROOM_BYTES = 64 * 1024
const MINIMUM_PROJECTION_LIMIT = 1024 * 1024
const PROJECTION_MESSAGE = "Workbench limited this view to stay within the webview transport budget. Some history or catalog entries are temporarily hidden; the underlying sessions and durable records were not deleted."

type OmissionKey = keyof ChatSnapshotProjectionOmissions
type MutableOmissions = Record<OmissionKey, number>
type SessionSnapshot = NonNullable<ChatSnapshot["session"]>

function omissionTotals(snapshot: ChatSnapshot): MutableOmissions {
  const session = snapshot.session
  return {
    sessions: snapshot.sessions.length,
    lineage: snapshot.lineage?.length ?? 0,
    messages: session?.messages.length ?? 0,
    delegations: session?.delegations?.length ?? 0,
    queuedPrompts: session?.queue?.length ?? 0,
    permissions: session?.permissions?.length ?? 0,
    questions: session?.questions?.length ?? 0,
    todos: session?.todos?.length ?? 0,
    changes: session?.changes?.length ?? 0,
    contextReceipts: session?.contextReceipts?.length ?? 0,
    catalogItems: snapshot.agents.length + (snapshot.mentionAgents?.length ?? 0) + (snapshot.providers?.length ?? 0) +
      snapshot.models.length + (snapshot.resources?.length ?? 0) + (snapshot.commands?.length ?? 0),
    runtimeServices: (snapshot.runtime?.lsp.length ?? 0) + (snapshot.runtime?.formatters.length ?? 0) + (snapshot.runtime?.mcp.length ?? 0),
    ptys: snapshot.ptys?.length ?? 0,
    attentionItems: snapshot.attentionItems?.length ?? 0,
    runGroups: snapshot.runGroups?.length ?? 0,
    worktrees: snapshot.worktrees?.length ?? 0,
    walkthroughs: snapshot.walkthroughs?.length ?? 0,
    walkthroughStops: snapshot.walkthroughs?.reduce((total, document) => total + document.stops.length, 0) ?? 0,
    taskArtifacts: snapshot.artifacts?.length ?? 0,
    reviewFindings: snapshot.reviewFindings?.length ?? 0,
    evidence: snapshot.evidence?.length ?? 0,
    runComparisons: snapshot.runComparisons?.length ?? 0,
  }
}

function projectedHistory(session: SessionSnapshot, visibleMessages: number): SessionSnapshot["history"] {
  if (!session.history) return undefined
  const omitted = visibleMessages < session.messages.length
  return {
    ...session.history,
    visibleMessages,
    hasOlder: session.history.hasOlder || omitted,
    limitedBy: omitted ? "characters" : session.history.limitedBy,
  }
}

function minimalSnapshot(
  snapshot: ChatSnapshot,
  projection: ChatSnapshotProjection,
  omissions: MutableOmissions,
): ChatSnapshot {
  const source = snapshot.session
  const selectedSession = source ? snapshot.sessions.find((session) => session.id === source.id) : undefined
  const selectedLineage = source ? snapshot.lineage?.find((node) => node.sessionID === source.id) : undefined
  const selectedAgent = source?.agent ? snapshot.agents.find((agent) => agent.name === source.agent) : undefined
  const selectedModel = source?.model ? snapshot.models.find((model) => `${model.providerID}/${model.id}` === source.model) : undefined
  if (selectedSession) omissions.sessions -= 1
  if (selectedLineage) omissions.lineage -= 1
  if (selectedAgent) omissions.catalogItems -= 1
  if (selectedModel) omissions.catalogItems -= 1

  const session: SessionSnapshot | undefined = source
    ? {
      id: source.id,
      parentID: source.parentID,
      directory: source.directory,
      title: source.title,
      draft: source.draft,
      status: source.status,
      loaded: source.loaded,
      loadState: source.loadState,
      messages: [],
      messageRevisions: {},
      agent: source.agent,
      model: source.model,
      variant: source.variant,
      queue: source.queue === undefined ? undefined : [],
      permissions: source.permissions === undefined ? undefined : [],
      questions: source.questions === undefined ? undefined : [],
      todos: source.todos === undefined ? undefined : [],
      changes: source.changes === undefined ? undefined : [],
      context: source.context,
      metrics: source.metrics,
      goal: source.goal,
      goalHistory: source.goalHistory,
      delegations: source.delegations === undefined ? undefined : [],
      contextReceipts: source.contextReceipts === undefined ? undefined : [],
      history: projectedHistory(source, 0),
      archived: source.archived,
      shared: source.shared,
      shareUrl: source.shareUrl,
      revertMessageID: source.revertMessageID,
    }
    : undefined

  return {
    connected: snapshot.connected,
    connectionState: snapshot.connectionState,
    connectionError: snapshot.connectionError,
    sessions: selectedSession ? [selectedSession] : [],
    lineage: snapshot.lineage === undefined ? undefined : selectedLineage ? [selectedLineage] : [],
    session,
    agents: selectedAgent ? [selectedAgent] : [],
    mentionAgents: snapshot.mentionAgents === undefined ? undefined : [],
    providers: snapshot.providers === undefined ? undefined : [],
    models: selectedModel ? [selectedModel] : [],
    resources: snapshot.resources === undefined ? undefined : [],
    catalog: snapshot.catalog,
    commands: snapshot.commands === undefined ? undefined : [],
    autoApproval: snapshot.autoApproval,
    runtime: snapshot.runtime
      ? { path: snapshot.runtime.path, vcs: snapshot.runtime.vcs, lsp: [], formatters: [], mcp: [], updatedAt: snapshot.runtime.updatedAt }
      : undefined,
    ptys: snapshot.ptys === undefined ? undefined : [],
    attentionItems: snapshot.attentionItems === undefined ? undefined : [],
    composer: snapshot.composer,
    runGroups: snapshot.runGroups === undefined ? undefined : [],
    worktrees: snapshot.worktrees === undefined ? undefined : [],
    walkthroughs: snapshot.walkthroughs === undefined ? undefined : [],
    artifacts: snapshot.artifacts === undefined ? undefined : [],
    reviewFindings: snapshot.reviewFindings === undefined ? undefined : [],
    evidence: snapshot.evidence === undefined ? undefined : [],
    runComparisons: snapshot.runComparisons === undefined ? undefined : [],
    health: snapshot.health,
    trace: snapshot.trace,
    projection,
  }
}

function descendingIndexes<T>(values: readonly T[], compare: (left: T, right: T) => number): number[] {
  return values.map((_, index) => index).sort((left, right) => compare(values[left]!, values[right]!) || left - right)
}

function runGroupRank(group: RunGroup): number {
  if (group.runs.some((run) => run.phase === "needs-input")) return 0
  if (group.runs.some((run) => run.phase === "failed" && !run.discarded)) return 1
  if (group.runs.some((run) => ["pending", "preparing", "admitting", "working"].includes(run.phase))) return 2
  return 3
}

function worktreeRank(entry: WorktreeJournalEntry, referenced: ReadonlySet<string>): number {
  if (referenced.has(entry.id)) return 0
  if (["failed", "cleanup-pending", "retained-dirty"].includes(entry.phase)) return 1
  return entry.phase === "removed" ? 3 : 2
}

function taskArtifactRank(artifact: TaskArtifactSummary): number {
  if (artifact.stale || ["failed", "unavailable", "blocked", "needs-user", "incomplete", "limited"].includes(artifact.state)) return 0
  return artifact.lifecycle === "active" ? 1 : 2
}

function evidenceRank(evidence: EvidenceReference): number {
  if (evidence.status === "failed") return 0
  if (evidence.status === "warning") return 1
  if (evidence.status === "unknown") return 2
  return 3
}

function exactOmissions(omissions: MutableOmissions): ChatSnapshotProjectionOmissions {
  return Object.fromEntries(Object.entries(omissions).filter(([, count]) => count > 0)) as ChatSnapshotProjectionOmissions
}

function finishProjection(snapshot: ChatSnapshot): number {
  const projection = snapshot.projection!
  let size = encodedBytes(snapshot)
  for (let iteration = 0; iteration < 4; iteration += 1) {
    projection.encodedBytes = size
    const next = encodedBytes(snapshot)
    if (next === size) return next
    size = next
  }
  projection.encodedBytes = size
  return encodedBytes(snapshot)
}

/**
 * Builds a transport-only snapshot projection. Admission is deterministic and
 * biased toward the selected session, pending input, the newest transcript
 * tail, task artifacts, deterministic evidence, actionable runs/worktrees,
 * recent receipts, and recent walkthroughs.
 * No source object or durable service is mutated.
 */
export function projectChatSnapshotForWebview(
  snapshot: ChatSnapshot,
  limitBytes = WEBVIEW_SNAPSHOT_BYTE_LIMIT,
): ChatSnapshot {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < MINIMUM_PROJECTION_LIMIT || limitBytes > 32 * 1024 * 1024) {
    throw new Error(`Webview snapshot limit must be between ${MINIMUM_PROJECTION_LIMIT} and ${32 * 1024 * 1024} bytes`)
  }

  const totals = omissionTotals(snapshot)
  const omissions = { ...totals }
  const projection: ChatSnapshotProjection = {
    truncated: true,
    limitBytes,
    encodedBytes: limitBytes,
    omitted: exactOmissions(omissions),
    message: PROJECTION_MESSAGE,
  }
  const candidate = minimalSnapshot(snapshot, projection, omissions)
  const admissionLimit = limitBytes - ADMISSION_HEADROOM_BYTES
  let used = encodedBytes(candidate)
  if (used > admissionLimit) {
    projection.omitted = exactOmissions(omissions)
    const size = finishProjection(candidate)
    if (size <= limitBytes && Object.keys(projection.omitted).length) return candidate
    throw new Error("The selected session metadata alone exceeds the webview snapshot transport limit")
  }

  const admitArray = <T>(
    source: readonly T[],
    destination: T[],
    order: readonly number[],
    omission: OmissionKey,
  ): void => {
    const retained = new Set(destination)
    let retainedCount = destination.length
    for (const index of order) {
      const value = source[index]
      if (value === undefined || retained.has(value)) continue
      const cost = encodedBytes(value) + (retainedCount ? 1 : 0)
      if (used + cost > admissionLimit) continue
      retained.add(value)
      retainedCount += 1
      omissions[omission] -= 1
      used += cost
    }
    destination.splice(0, destination.length, ...source.filter((value) => retained.has(value)))
  }

  const sourceSession = snapshot.session
  const projectedSession = candidate.session
  if (sourceSession && projectedSession) {
    if (sourceSession.queue && projectedSession.queue) {
      const order = sourceSession.queue.map((_, index) => index).sort((left, right) => {
        const leftCurrent = sourceSession.queue![left]!.id === sourceSession.inFlightPromptID ? 0 : 1
        const rightCurrent = sourceSession.queue![right]!.id === sourceSession.inFlightPromptID ? 0 : 1
        return leftCurrent - rightCurrent || left - right
      })
      admitArray(sourceSession.queue, projectedSession.queue, order, "queuedPrompts")
      if (sourceSession.inFlightPromptID && projectedSession.queue.some((prompt) => prompt.id === sourceSession.inFlightPromptID)) {
        projectedSession.inFlightPromptID = sourceSession.inFlightPromptID
      }
    }
    if (sourceSession.permissions && projectedSession.permissions) {
      admitArray(sourceSession.permissions, projectedSession.permissions, sourceSession.permissions.map((_, index) => index), "permissions")
    }
    if (sourceSession.questions && projectedSession.questions) {
      admitArray(sourceSession.questions, projectedSession.questions, sourceSession.questions.map((_, index) => index), "questions")
    }

    const retainedMessages = new Set<number>()
    let messageCount = 0
    let revisionCount = 0
    for (let index = sourceSession.messages.length - 1; index >= 0; index -= 1) {
      const message = sourceSession.messages[index]!
      const revision = sourceSession.messageRevisions[message.info.id] ?? 0
      const revisionCost = encodedBytes(message.info.id) + 1 + encodedBytes(revision) + (revisionCount ? 1 : 0)
      const cost = encodedBytes(message) + (messageCount ? 1 : 0) + revisionCost
      if (used + cost > admissionLimit) break
      retainedMessages.add(index)
      messageCount += 1
      revisionCount += 1
      omissions.messages -= 1
      used += cost
    }
    projectedSession.messages = sourceSession.messages.filter((_, index) => retainedMessages.has(index))
    projectedSession.messageRevisions = Object.fromEntries(projectedSession.messages.map((message) => [message.info.id, sourceSession.messageRevisions[message.info.id] ?? 0]))
    projectedSession.history = omissions.messages ? projectedHistory(sourceSession, projectedSession.messages.length) : sourceSession.history
  }

  const artifactOrder = snapshot.artifacts
    ? descendingIndexes(snapshot.artifacts, (left, right) => taskArtifactRank(left) - taskArtifactRank(right) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    : []
  if (snapshot.artifacts && candidate.artifacts) admitArray(snapshot.artifacts, candidate.artifacts, artifactOrder.slice(0, 1), "taskArtifacts")
  const reviewSeverity = { critical: 0, high: 1, medium: 2, low: 3 } as const
  const reviewFindingOrder = snapshot.reviewFindings
    ? descendingIndexes(snapshot.reviewFindings, (left, right) => Number(left.disposition !== "open") - Number(right.disposition !== "open") ||
      reviewSeverity[left.severity] - reviewSeverity[right.severity] || Number(right.stale) - Number(left.stale) ||
      right.artifactUpdatedAt - left.artifactUpdatedAt || left.findingID.localeCompare(right.findingID))
    : []
  if (snapshot.reviewFindings && candidate.reviewFindings) admitArray(snapshot.reviewFindings, candidate.reviewFindings, reviewFindingOrder.slice(0, 1), "reviewFindings")
  const comparisonOrder = snapshot.runComparisons
    ? descendingIndexes(snapshot.runComparisons, (left: RunComparisonSnapshot, right: RunComparisonSnapshot) => right.updatedAt - left.updatedAt || left.artifactID.localeCompare(right.artifactID))
    : []
  if (snapshot.runComparisons && candidate.runComparisons) admitArray(snapshot.runComparisons, candidate.runComparisons, comparisonOrder.slice(0, 1), "runComparisons")
  const evidenceOrder = snapshot.evidence
    ? descendingIndexes(snapshot.evidence, (left, right) => evidenceRank(left) - evidenceRank(right) || right.observedAt - left.observedAt || left.id.localeCompare(right.id))
    : []
  if (snapshot.evidence && candidate.evidence) admitArray(snapshot.evidence, candidate.evidence, evidenceOrder.slice(0, 1), "evidence")

  const runGroupOrder = snapshot.runGroups
    ? descendingIndexes(snapshot.runGroups, (left, right) => runGroupRank(left) - runGroupRank(right) || right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    : []
  if (snapshot.runGroups && candidate.runGroups) admitArray(snapshot.runGroups, candidate.runGroups, runGroupOrder.slice(0, 1), "runGroups")
  const firstReferencedWorktreeIDs = new Set(candidate.runGroups?.flatMap((group) => group.runs.flatMap((run) => run.worktreeID ? [run.worktreeID] : [])) ?? [])
  const firstWorktreeOrder = snapshot.worktrees
    ? descendingIndexes(snapshot.worktrees, (left, right) => worktreeRank(left, firstReferencedWorktreeIDs) - worktreeRank(right, firstReferencedWorktreeIDs) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    : []
  if (snapshot.worktrees && candidate.worktrees) admitArray(snapshot.worktrees, candidate.worktrees, firstWorktreeOrder.slice(0, 1), "worktrees")
  const ptyOrder = snapshot.ptys
    ? descendingIndexes(snapshot.ptys, (left, right) => Number(right.status === "running") - Number(left.status === "running") || left.id.localeCompare(right.id))
    : []
  if (snapshot.ptys && candidate.ptys) admitArray(snapshot.ptys, candidate.ptys, ptyOrder.slice(0, 1), "ptys")
  const selectedLineageRoot = snapshot.lineage?.find((node) => node.sessionID === snapshot.session?.id)?.rootID
  const lineageOrder = snapshot.lineage
    ? descendingIndexes(snapshot.lineage, (left, right) => {
      const leftSelected = selectedLineageRoot && left.rootID === selectedLineageRoot ? 0 : 1
      const rightSelected = selectedLineageRoot && right.rootID === selectedLineageRoot ? 0 : 1
      const leftAttention = Boolean(left.attention) || ["busy", "retry", "error"].includes(left.status.type) ? 0 : 1
      const rightAttention = Boolean(right.attention) || ["busy", "retry", "error"].includes(right.status.type) ? 0 : 1
      return leftSelected - rightSelected || leftAttention - rightAttention || left.depth - right.depth || right.updatedAt - left.updatedAt || left.sessionID.localeCompare(right.sessionID)
    })
    : []
  if (snapshot.lineage && candidate.lineage) admitArray(snapshot.lineage, candidate.lineage, lineageOrder.slice(0, 1), "lineage")
  const receiptOrder = sourceSession?.contextReceipts
    ? descendingIndexes(sourceSession.contextReceipts, (left, right) => right.admittedAt - left.admittedAt || left.id.localeCompare(right.id))
    : []
  if (sourceSession?.contextReceipts && projectedSession?.contextReceipts) {
    admitArray(sourceSession.contextReceipts, projectedSession.contextReceipts, receiptOrder.slice(0, 1), "contextReceipts")
  }

  let admitWalkthroughs: ((order: readonly number[]) => void) | undefined
  let walkthroughOrder: number[] = []
  if (snapshot.walkthroughs && candidate.walkthroughs) {
    const destination = candidate.walkthroughs
    const retained = new Map<number, WalkthroughDocument>()
    walkthroughOrder = descendingIndexes(snapshot.walkthroughs, (left, right) => right.generatedAt - left.generatedAt || left.id.localeCompare(right.id))
    admitWalkthroughs = (order): void => {
      for (const index of order) {
        if (retained.has(index)) continue
        const document = snapshot.walkthroughs![index]!
        const projected: WalkthroughDocument = { ...document, stops: [] }
        const documentCost = encodedBytes(projected) + (retained.size ? 1 : 0)
        if (used + documentCost > admissionLimit) continue
        let documentBytes = documentCost
        for (const stop of document.stops) {
          const stopCost = encodedBytes(stop) + (projected.stops.length ? 1 : 0)
          if (used + documentBytes + stopCost > admissionLimit) break
          projected.stops.push(stop)
          documentBytes += stopCost
        }
        if (document.stops.length && !projected.stops.length) continue
        if (projected.stops.length < document.stops.length) projected.coverage = "partial"
        retained.set(index, projected)
        omissions.walkthroughs -= 1
        omissions.walkthroughStops -= projected.stops.length
        used += documentBytes
      }
      destination.splice(0, destination.length, ...snapshot.walkthroughs!.flatMap((_, index) => retained.has(index) ? [retained.get(index)!] : []))
    }
    admitWalkthroughs(walkthroughOrder.slice(0, 1))
  }

  // After every durable surface gets a chance to retain its most important
  // record, use the remaining budget in importance/newness order.
  if (snapshot.artifacts && candidate.artifacts) admitArray(snapshot.artifacts, candidate.artifacts, artifactOrder, "taskArtifacts")
  if (snapshot.reviewFindings && candidate.reviewFindings) admitArray(snapshot.reviewFindings, candidate.reviewFindings, reviewFindingOrder, "reviewFindings")
  if (snapshot.runComparisons && candidate.runComparisons) admitArray(snapshot.runComparisons, candidate.runComparisons, comparisonOrder, "runComparisons")
  if (snapshot.evidence && candidate.evidence) admitArray(snapshot.evidence, candidate.evidence, evidenceOrder, "evidence")
  if (snapshot.runGroups && candidate.runGroups) admitArray(snapshot.runGroups, candidate.runGroups, runGroupOrder, "runGroups")
  const retainedWorktreeIDs = new Set(candidate.runGroups?.flatMap((group) => group.runs.flatMap((run) => run.worktreeID ? [run.worktreeID] : [])) ?? [])
  if (snapshot.worktrees && candidate.worktrees) {
    const order = descendingIndexes(snapshot.worktrees, (left, right) => worktreeRank(left, retainedWorktreeIDs) - worktreeRank(right, retainedWorktreeIDs) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    admitArray(snapshot.worktrees, candidate.worktrees, order, "worktrees")
  }
  if (sourceSession?.contextReceipts && projectedSession?.contextReceipts) {
    admitArray(sourceSession.contextReceipts, projectedSession.contextReceipts, receiptOrder, "contextReceipts")
  }
  admitWalkthroughs?.(walkthroughOrder)

  if (sourceSession && projectedSession) {
    if (sourceSession.delegations && projectedSession.delegations) {
      const order = descendingIndexes(sourceSession.delegations, (left, right) => {
        const leftActive = ["busy", "retry"].includes(left.status.type) ? 0 : left.status.type === "error" ? 1 : 2
        const rightActive = ["busy", "retry"].includes(right.status.type) ? 0 : right.status.type === "error" ? 1 : 2
        return leftActive - rightActive || right.revision - left.revision || left.partID.localeCompare(right.partID)
      })
      admitArray(sourceSession.delegations, projectedSession.delegations, order, "delegations")
    }
    if (sourceSession.todos && projectedSession.todos) {
      const order = sourceSession.todos.map((_, index) => index).sort((left, right) => {
        const leftDone = sourceSession.todos![left]!.status === "completed" ? 1 : 0
        const rightDone = sourceSession.todos![right]!.status === "completed" ? 1 : 0
        return leftDone - rightDone || left - right
      })
      admitArray(sourceSession.todos, projectedSession.todos, order, "todos")
    }
    if (sourceSession.changes && projectedSession.changes) {
      admitArray(sourceSession.changes, projectedSession.changes, sourceSession.changes.map((_, index) => index), "changes")
    }
  }

  const sessionOrder = descendingIndexes(snapshot.sessions, (left, right) => {
    const leftAttention = Boolean(left.attention) || ["busy", "retry", "error"].includes(left.status.type) ? 0 : 1
    const rightAttention = Boolean(right.attention) || ["busy", "retry", "error"].includes(right.status.type) ? 0 : 1
    return leftAttention - rightAttention || (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.id.localeCompare(right.id)
  })
  admitArray(snapshot.sessions, candidate.sessions, sessionOrder, "sessions")
  if (snapshot.lineage && candidate.lineage) admitArray(snapshot.lineage, candidate.lineage, lineageOrder, "lineage")
  if (snapshot.attentionItems && candidate.attentionItems) {
    admitArray(snapshot.attentionItems, candidate.attentionItems, snapshot.attentionItems.map((_, index) => index), "attentionItems")
  }
  if (snapshot.ptys && candidate.ptys) admitArray(snapshot.ptys, candidate.ptys, ptyOrder, "ptys")

  admitArray(snapshot.agents, candidate.agents, snapshot.agents.map((_, index) => index), "catalogItems")
  if (snapshot.mentionAgents && candidate.mentionAgents) admitArray(snapshot.mentionAgents, candidate.mentionAgents, snapshot.mentionAgents.map((_, index) => index), "catalogItems")
  if (snapshot.providers && candidate.providers) admitArray(snapshot.providers, candidate.providers, snapshot.providers.map((_, index) => index), "catalogItems")
  admitArray(snapshot.models, candidate.models, snapshot.models.map((_, index) => index), "catalogItems")
  if (snapshot.resources && candidate.resources) admitArray(snapshot.resources, candidate.resources, snapshot.resources.map((_, index) => index), "catalogItems")
  if (snapshot.commands && candidate.commands) admitArray(snapshot.commands, candidate.commands, snapshot.commands.map((_, index) => index), "catalogItems")

  if (snapshot.runtime && candidate.runtime) {
    for (const key of ["lsp", "formatters", "mcp"] as const) {
      const services = snapshot.runtime[key]
      const order = descendingIndexes(services, (left, right) => {
        const leftImportant = left.error || left.enabled === false ? 0 : 1
        const rightImportant = right.error || right.enabled === false ? 0 : 1
        return leftImportant - rightImportant || left.id.localeCompare(right.id)
      })
      admitArray(services, candidate.runtime[key], order, "runtimeServices")
    }
  }

  const remaining = exactOmissions(omissions)
  if (!Object.keys(remaining).length) {
    if (encodedBytes(snapshot) <= limitBytes) return snapshot
    throw new Error("Webview snapshot byte accounting did not produce a bounded projection")
  }
  projection.omitted = remaining
  const size = finishProjection(candidate)
  if (size > limitBytes) throw new Error("Projected webview snapshot exceeds its transport limit")
  return candidate
}
