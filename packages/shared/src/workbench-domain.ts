import type { SessionLocator } from "./lifecycle.ts"
import type { StructuredError } from "./protocol-v2.ts"

export type ContextKind =
  | "selection"
  | "unsaved-buffer"
  | "file"
  | "diagnostics"
  | "terminal"
  | "notebook"
  | "debug"
  | "mcp-resource"
  | "url"
  | "attachment"

export interface ContextReceiptItem {
  id: string
  kind: ContextKind
  label: string
  uri?: string
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number }
  revision?: string
  contentHash?: string
  bytes?: number
  estimatedTokens?: number
  truncated?: boolean
}

export interface ContextReceipt {
  id: string
  sessionID: string
  promptID: string
  admittedAt: number
  items: ContextReceiptItem[]
  estimatedTokens?: number
  truncation: "none" | "explicit" | "unknown"
}

export type AttentionKind =
  | "permission"
  | "question"
  | "blocked-goal"
  | "prompt-failure"
  | "disconnected-session"
  | "worktree-failure"
  | "run-failure"
  | "native-action"

export interface AttentionItem {
  id: string
  kind: AttentionKind
  sessionID?: string
  title: string
  detail?: string
  createdAt: number
  target: { surface: "conversation" | "goal" | "runs" | "health"; itemID?: string }
}

export type WorktreeOwner = "native-agent-host" | "workbench"
export type WorktreePhase =
  | "requested"
  | "creating"
  | "ready"
  | "setup-running"
  | "session-creating"
  | "session-ready"
  | "prompt-admitting"
  | "prompt-admitted"
  | "failed"
  | "cleanup-pending"
  | "retained-dirty"
  | "removed"

export interface WorktreeJournalEntry {
  id: string
  mutationID: string
  owner: WorktreeOwner
  repository: string
  repositoryID: string
  path: string
  branch: string
  baseRef: string
  phase: WorktreePhase
  sessionID?: string
  promptID?: string
  createdAt: number
  updatedAt: number
  error?: StructuredError
}

export type RunPhase = "pending" | "preparing" | "admitting" | "working" | "needs-input" | "completed" | "failed" | "cancelled"

export const MULTI_RUN_MAX_CANDIDATES = 100
export const MULTI_RUN_MAX_CONCURRENCY = 20
export const MULTI_RUN_DEFAULT_CONCURRENCY = 5

export interface RunReference {
  id: string
  model: string
  agent?: string
  variant?: string
  session: SessionLocator
  worktreeID?: string
  phase: RunPhase
  error?: StructuredError
  startedAt?: number
  completedAt?: number
  retained?: boolean
  discarded?: boolean
}

export interface RunGroup {
  id: string
  mutationID?: string
  ownerSessionID?: string
  title: string
  repository: string
  baseRef: string
  promptReceiptID: string
  isolation: "shared" | "worktree"
  createdAt: number
  runs: RunReference[]
}

export interface RunComparisonRow {
  runID: string
  status: RunPhase
  model: string
  agent?: string
  variant?: string
  elapsedMilliseconds?: number
  changedFiles: number
  additions: number
  deletions: number
  taskOutcomes: "not-recorded" | "passed" | "failed" | "mixed"
  diagnostics: "not-recorded" | "clean" | "has-errors"
  verifierState?: string
  tokens?: number
  cost?: number
  blocker?: string
  complete: boolean
  limitation?: string
}

export type DiffScope = "turn" | "session" | "staged" | "unstaged" | "branch" | "pull-request"

export interface DiffLineRange {
  start: number
  end: number
}

export interface DiffFileSummary {
  path: string
  previousPath?: string
  additions: number
  deletions: number
  binary?: boolean
  hunks?: Array<{ header: string; oldRange: DiffLineRange; newRange: DiffLineRange }>
}

export interface DiffSnapshot {
  id: string
  scope: DiffScope
  repository: string
  baseRef?: string
  headRef?: string
  unifiedDiffHash: string
  files: DiffFileSummary[]
  generatedAt: number
  complete: boolean
  truncationReason?: string
}

export interface DiffAnchor {
  file: string
  side: "base" | "modified"
  startLine: number
  endLine: number
  hunkHeader?: string
}

export interface WalkthroughStop {
  id: string
  title: string
  explanation: string
  importance: "key-change" | "normal" | "context"
  anchors: DiffAnchor[]
}

export interface WalkthroughDocument {
  id: string
  diffHash: string
  model: string
  promptVersion: string
  language: string
  generatedAt: number
  stops: WalkthroughStop[]
  coverage: "complete" | "partial"
  uncoveredFiles?: string[]
}

export interface ReviewFinding {
  id: string
  title: string
  detail: string
  category: "correctness" | "security" | "performance" | "maintainability" | "tests" | "regression"
  severity: "critical" | "high" | "medium" | "low"
  anchors: DiffAnchor[]
}

export interface ReviewDocument {
  id: string
  diffHash: string
  model: string
  promptVersion: string
  generatedAt: number
  findings: ReviewFinding[]
}

export type EvidenceKind = "task" | "terminal" | "test" | "diagnostics" | "diff" | "todo" | "criterion"

export interface EvidenceReference {
  id: string
  kind: EvidenceKind
  label: string
  status: "passed" | "failed" | "warning" | "unknown"
  observedAt: number
  sourceID?: string
  sessionID?: string
  runGroupID?: string
  runID?: string
  repository?: string
  summary: string
}

export interface GoalVerifierConfiguration {
  model?: string
  agent?: string
  timeoutMilliseconds: number
  repeatedBlockThreshold: number
  enabled: boolean
}

export interface GoalVerdict {
  verdict: "continue" | "complete" | "blocked" | "needs-user"
  reason: string
  missingCriteria: string[]
  confidence: "low" | "medium" | "high"
}

export interface PlanReference {
  id: string
  uri: string
  revision: string
  approvedAt?: number
}

export const TASK_ARTIFACT_SCHEMA_VERSION = 1 as const

export type TaskArtifactKind = "plan" | "review" | "goal-verification" | "run-comparison" | "context-capture"
export type TaskArtifactLifecycle = "active" | "archived"

export interface TaskArtifactProducer {
  sessionID: string
  messageID?: string
  model?: string
}

export interface TaskArtifactBase<K extends TaskArtifactKind, P> {
  schemaVersion: typeof TASK_ARTIFACT_SCHEMA_VERSION
  id: string
  kind: K
  /** Canonical OpenCode session that owns the task artifact. */
  sessionID: string
  lifecycle: TaskArtifactLifecycle
  /** Optimistic application revision. The first durable revision is 1. */
  revision: number
  createdAt: number
  updatedAt: number
  /** OpenCode session/message that produced an AI-authored artifact. */
  producer?: TaskArtifactProducer
  payload: P
}

export type PlanArtifactPhase = "generating" | "ready" | "approved" | "handed-off" | "failed" | "unavailable"
export type PlanHandoffMode = "implementation" | "isolated" | "multi-run" | "goal"

export interface PlanArtifactHandoff {
  mode: PlanHandoffMode
  createdAt: number
  sessionIDs?: string[]
  runGroupID?: string
  worktreeID?: string
}

/**
 * A plan artifact intentionally contains no objective or Markdown body. The
 * canonical content remains in OpenCode and/or at the user-visible URI.
 */
export interface PlanArtifactPayload {
  phase: PlanArtifactPhase
  uri: string
  /** SHA-256 revision of the user-visible plan document. */
  revision: string
  approvedAt?: number
  relatedSessionIDs?: string[]
  handoffs?: PlanArtifactHandoff[]
}

export type ReviewFindingDispositionState = "open" | "fixed" | "dismissed" | "accepted-risk"

export interface ReviewFindingDisposition {
  findingID: string
  state: ReviewFindingDispositionState
  updatedAt: number
  note?: string
}

export interface ReviewArtifactPayload {
  document: ReviewDocument
  repository: string
  baseRef?: string
  scope: DiffScope
  diffHash: string
  stale: boolean
  dispositions: ReviewFindingDisposition[]
}

export interface GoalVerificationAttemptRecord {
  attempt: number
  startedAt: number
  completedAt: number
  outcome: "completed" | "invalid-output" | "failed"
  sessionID?: string
  model?: string
  tokens?: number
  cost?: number
}

export interface GoalVerificationArtifactPayload {
  settlementGeneration: number
  verdict?: GoalVerdict
  attempts: GoalVerificationAttemptRecord[]
  evidenceIDs: string[]
  applied: boolean
  stale: boolean
  appliedAt?: number
}

export interface RunComparisonArtifactPayload {
  groupID: string
  rows: RunComparisonRow[]
}

export interface ContextCaptureSourceMetadata {
  id: string
  kind: ContextKind
  label: string
  uri?: string
  range?: ContextReceiptItem["range"]
  revision?: string
  contentHash?: string
  estimatedTokens?: number
  truncated?: boolean
}

/** Metadata-only capture receipt. Prompt text and attachment/clipboard bytes are never stored. */
export interface ContextCaptureArtifactPayload {
  promptID: string
  receiptID: string
  admittedAt: number
  truncation: ContextReceipt["truncation"]
  estimatedTokens?: number
  sources: ContextCaptureSourceMetadata[]
}

export type PlanTaskArtifact = TaskArtifactBase<"plan", PlanArtifactPayload>
export type ReviewTaskArtifact = TaskArtifactBase<"review", ReviewArtifactPayload>
export type GoalVerificationTaskArtifact = TaskArtifactBase<"goal-verification", GoalVerificationArtifactPayload>
export type RunComparisonTaskArtifact = TaskArtifactBase<"run-comparison", RunComparisonArtifactPayload>
export type ContextCaptureTaskArtifact = TaskArtifactBase<"context-capture", ContextCaptureArtifactPayload>

export type TaskArtifact =
  | PlanTaskArtifact
  | ReviewTaskArtifact
  | GoalVerificationTaskArtifact
  | RunComparisonTaskArtifact
  | ContextCaptureTaskArtifact

export interface TaskArtifactSummary {
  schemaVersion: typeof TASK_ARTIFACT_SCHEMA_VERSION
  id: string
  kind: TaskArtifactKind
  sessionID: string
  lifecycle: TaskArtifactLifecycle
  revision: number
  createdAt: number
  updatedAt: number
  state: string
  itemCount?: number
  stale?: boolean
}

const CONTEXT_KINDS = new Set<ContextKind>(["selection", "unsaved-buffer", "file", "diagnostics", "terminal", "notebook", "debug", "mcp-resource", "url", "attachment"])
const METADATA_AUTHORIZATION = /\b((?:proxy-)?authorization\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/gi
const METADATA_COOKIE = /\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi
const METADATA_SECRET = /\b((?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|authorization|cookie|password|secret|token|credential|signature|sig|sas)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const METADATA_URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi
const METADATA_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi
const METADATA_KNOWN_TOKEN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g
const METADATA_CONTROL = /[\u0000-\u001f\u007f]+/g
const DURABLE_URI_PROTOCOLS = new Set(["file:", "http:", "https:", "vscode-remote:", "untitled:"])

function bounded(value: string, limit: number, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > limit) throw new Error(`${label} must contain 1-${limit} characters`)
  return normalized
}

function boundedOpaque(value: string, limit: number, label: string): string {
  const normalized = bounded(value, limit, label)
  if (sanitizeDurableMetadataText(normalized, limit, label) !== normalized) throw new Error(`${label} contains credential-shaped metadata`)
  return normalized
}

/** Redacts credential-shaped text before it enters any durable Workbench metadata. */
export function sanitizeDurableMetadataText(value: string, limit: number, label: string): string {
  const sanitized = bounded(value, limit, label)
    .replace(METADATA_PRIVATE_KEY, "[redacted-private-key]")
    .replace(METADATA_AUTHORIZATION, "$1[redacted]")
    .replace(METADATA_COOKIE, "$1[redacted]")
    .replace(METADATA_SECRET, "$1[redacted]")
    .replace(METADATA_URL_CREDENTIAL, "$1[redacted]@")
    .replace(METADATA_KNOWN_TOKEN, "[redacted-token]")
    .replace(METADATA_CONTROL, " ")
    .trim()
    .slice(0, limit)
  return sanitized || "[redacted]"
}

/** Keeps only credential-free, non-navigational URI metadata (never query/fragment/userinfo). */
export function sanitizeDurableMetadataUri(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = bounded(value, 4_096, "Context item URI")
  try {
    const parsed = new URL(normalized)
    if (!DURABLE_URI_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) return undefined
    parsed.search = ""
    parsed.hash = ""
    const safe = parsed.toString()
    return sanitizeDurableMetadataText(safe, 4_096, "Context item URI") === safe ? safe : undefined
  } catch {
    return undefined
  }
}

export function sanitizeContextReceipt(receipt: ContextReceipt): ContextReceipt {
  if (!Number.isSafeInteger(receipt.admittedAt) || receipt.admittedAt < 0 || receipt.items.length > 100 || !["none", "explicit", "unknown"].includes(receipt.truncation)) throw new Error("Invalid context receipt")
  if (receipt.estimatedTokens !== undefined && (!Number.isSafeInteger(receipt.estimatedTokens) || receipt.estimatedTokens < 0)) throw new Error("Invalid context token estimate")
  const ids = new Set<string>()
  let tokens = 0
  const items = receipt.items.map((item) => {
    const id = boundedOpaque(item.id, 1_024, "Context item ID")
    if (ids.has(id)) throw new Error("Duplicate context item ID")
    ids.add(id)
    if (!CONTEXT_KINDS.has(item.kind)) throw new Error("Invalid context item kind")
    if (item.uri !== undefined && item.uri.length > 4_096) throw new Error("Context item URI exceeds 4,096 characters")
    if (item.revision !== undefined && item.revision.length > 256) throw new Error("Context item revision exceeds 256 characters")
    if (item.contentHash !== undefined && item.contentHash.length > 256) throw new Error("Context item hash exceeds 256 characters")
    if (item.range) {
      const { startLine, startColumn, endLine, endColumn } = item.range
      if (![startLine, startColumn, endLine, endColumn].every((value) => Number.isSafeInteger(value) && value >= 1) || endLine < startLine || (endLine === startLine && endColumn < startColumn)) throw new Error("Invalid context item range")
    }
    if (item.truncated !== undefined && typeof item.truncated !== "boolean") throw new Error("Invalid context truncation marker")
    const sanitized: ContextReceiptItem = {
      id,
      kind: item.kind,
      label: sanitizeDurableMetadataText(item.label, 1_024, "Context label"),
      uri: sanitizeDurableMetadataUri(item.uri),
      range: item.range,
      revision: item.revision === undefined ? undefined : sanitizeDurableMetadataText(item.revision, 256, "Context item revision"),
      contentHash: item.contentHash === undefined ? undefined : boundedOpaque(item.contentHash, 256, "Context item hash"),
      bytes: item.bytes,
      estimatedTokens: item.estimatedTokens,
      truncated: item.truncated,
    }
    for (const value of [sanitized.bytes, sanitized.estimatedTokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid context item size")
    }
    tokens += sanitized.estimatedTokens ?? 0
    return sanitized
  })
  if (!Number.isSafeInteger(tokens)) throw new Error("Context token estimate exceeds the safe integer limit")
  return {
    id: boundedOpaque(receipt.id, 1_024, "Receipt ID"),
    sessionID: boundedOpaque(receipt.sessionID, 1_024, "Session ID"),
    promptID: boundedOpaque(receipt.promptID, 1_024, "Prompt ID"),
    admittedAt: receipt.admittedAt,
    items,
    estimatedTokens: receipt.estimatedTokens ?? (tokens || undefined),
    truncation: receipt.truncation,
  }
}

function validateAnchors(stops: WalkthroughStop[], snapshot: DiffSnapshot): Set<string> {
  const files = new Map(snapshot.files.map((file) => [file.path, file]))
  const anchoredFiles = new Set<string>()
  for (const stop of stops) {
    if (!stop.anchors.length) throw new Error(`Walkthrough stop ${stop.id} has no diff anchor`)
    for (const anchor of stop.anchors) {
      const file = files.get(anchor.file)
      if (!file) throw new Error(`Walkthrough anchor references unknown file: ${anchor.file}`)
      if (!Number.isSafeInteger(anchor.startLine) || !Number.isSafeInteger(anchor.endLine) || anchor.startLine < 1 || anchor.endLine < anchor.startLine) {
        throw new Error(`Walkthrough anchor has an invalid line range: ${anchor.file}`)
      }
      if (!anchor.hunkHeader) throw new Error(`Walkthrough anchor must identify an exact hunk: ${anchor.file}`)
      const hunk = file.hunks?.find((candidate) => candidate.header === anchor.hunkHeader)
      if (!hunk) throw new Error(`Walkthrough anchor references unknown hunk: ${anchor.file}`)
      const side = anchor.side === "base" ? hunk.oldRange : hunk.newRange
      if (side.end < side.start || anchor.startLine < side.start || anchor.endLine > side.end) {
        throw new Error(`Walkthrough anchor is outside its exact hunk range: ${anchor.file}`)
      }
      anchoredFiles.add(anchor.file)
    }
  }
  return anchoredFiles
}

export function validateWalkthrough(document: WalkthroughDocument, snapshot: DiffSnapshot): void {
  if (!snapshot.complete) throw new Error("Walkthrough generation requires a complete diff snapshot")
  if (document.diffHash !== snapshot.unifiedDiffHash) throw new Error("Walkthrough is stale for this diff")
  const anchoredFiles = validateAnchors(document.stops, snapshot)
  const knownFiles = new Set(snapshot.files.map((file) => file.path))
  const uncoveredFiles = new Set(document.uncoveredFiles ?? [])
  for (const file of uncoveredFiles) if (!knownFiles.has(file)) throw new Error(`Walkthrough coverage references unknown file: ${file}`)
  const missingFiles = snapshot.files.map((file) => file.path).filter((file) => !anchoredFiles.has(file))
  if (document.coverage === "complete") {
    if (uncoveredFiles.size || missingFiles.length) throw new Error(`Walkthrough claims complete coverage but omits: ${missingFiles.join(", ") || [...uncoveredFiles].join(", ")}`)
  } else {
    if (!uncoveredFiles.size) throw new Error("Partial walkthrough coverage must identify uncovered files")
    for (const file of missingFiles) if (!uncoveredFiles.has(file)) throw new Error(`Partial walkthrough does not disclose uncovered file: ${file}`)
    for (const file of uncoveredFiles) if (anchoredFiles.has(file)) throw new Error(`Walkthrough file cannot be both anchored and uncovered: ${file}`)
  }
}

export function validateReview(document: ReviewDocument, snapshot: DiffSnapshot): void {
  if (!snapshot.complete) throw new Error("Review generation requires a complete diff snapshot")
  if (document.diffHash !== snapshot.unifiedDiffHash) throw new Error("Review is stale for this diff")
  validateAnchors(document.findings.map((finding) => ({ id: finding.id, title: finding.title, explanation: finding.detail, importance: finding.severity === "critical" || finding.severity === "high" ? "key-change" : "normal", anchors: finding.anchors })), snapshot)
}

export function runGroupStatus(group: RunGroup): RunPhase {
  if (group.runs.some((run) => run.phase === "needs-input")) return "needs-input"
  if (group.runs.some((run) => ["preparing", "admitting", "working"].includes(run.phase))) return "working"
  if (group.runs.some((run) => run.phase === "pending")) return "pending"
  if (group.runs.some((run) => run.phase === "completed")) return "completed"
  if (group.runs.some((run) => run.phase === "failed")) return "failed"
  return "cancelled"
}

const TASK_ARTIFACT_KINDS = new Set<TaskArtifactKind>(["plan", "review", "goal-verification", "run-comparison", "context-capture"])
const TASK_ARTIFACT_LIFECYCLES = new Set<TaskArtifactLifecycle>(["active", "archived"])
const SHA256_REVISION = /^sha256:[a-f0-9]{64}$/
const PLAN_URI_PROTOCOLS = new Set(["file:", "untitled:", "vscode-remote:"])

function artifactRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function artifactExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`${label} contains unsupported field ${unknown}`)
}

function artifactString(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  return sanitizeDurableMetadataText(value, limit, label)
}

function artifactOpaque(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  return boundedOpaque(value, limit, label)
}

function artifactOptionalOpaque(value: unknown, limit: number, label: string): string | undefined {
  return value === undefined ? undefined : artifactOpaque(value, limit, label)
}

function artifactInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} must be a safe integer from ${minimum} to ${maximum}`)
  return Number(value)
}

function artifactOptionalInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return value === undefined ? undefined : artifactInteger(value, label, minimum, maximum)
}

function artifactCost(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) throw new Error(`${label} is invalid`)
  return value
}

function artifactHash(value: unknown, label: string): string {
  const hash = artifactOpaque(value, 71, label)
  if (!SHA256_REVISION.test(hash)) throw new Error(`${label} must be a lowercase SHA-256 revision`)
  return hash
}

function uniqueArtifactIDs(value: unknown, limit: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must contain at most ${limit} IDs`)
  const result = value.map((candidate, index) => artifactOpaque(candidate, 1_024, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate IDs`)
  return result
}

function normalizeArtifactProducer(value: unknown, label: string): TaskArtifactProducer {
  const producer = artifactRecord(value, label)
  artifactExactKeys(producer, ["sessionID", "messageID", "model"], label)
  return {
    sessionID: artifactOpaque(producer.sessionID, 1_024, `${label}.sessionID`),
    messageID: artifactOptionalOpaque(producer.messageID, 1_024, `${label}.messageID`),
    model: artifactOptionalOpaque(producer.model, 1_024, `${label}.model`),
  }
}

function normalizePlanPayload(value: unknown, ownerSessionID: string): PlanArtifactPayload {
  const payload = artifactRecord(value, "Plan artifact payload")
  artifactExactKeys(payload, ["phase", "uri", "revision", "approvedAt", "relatedSessionIDs", "handoffs"], "Plan artifact payload")
  if (!["generating", "ready", "approved", "handed-off", "failed", "unavailable"].includes(String(payload.phase))) throw new Error("Plan artifact phase is invalid")
  if (typeof payload.uri !== "string") throw new Error("Plan artifact URI must be a string")
  const uri = sanitizeDurableMetadataUri(payload.uri)
  if (!uri) throw new Error("Plan artifact URI is not durable")
  let protocol: string
  try {
    protocol = new URL(uri).protocol
  } catch {
    throw new Error("Plan artifact URI is invalid")
  }
  if (!PLAN_URI_PROTOCOLS.has(protocol)) throw new Error("Plan artifact URI must identify a VS Code document")
  const phase = payload.phase as PlanArtifactPhase
  const approvedAt = artifactOptionalInteger(payload.approvedAt, "Plan artifact approvedAt")
  const relatedSessionIDs = payload.relatedSessionIDs === undefined ? undefined : uniqueArtifactIDs(payload.relatedSessionIDs, 100, "Plan artifact relatedSessionIDs")
  if (relatedSessionIDs?.includes(ownerSessionID)) throw new Error("Plan artifact related sessions cannot repeat its owner")
  let handoffs: PlanArtifactHandoff[] | undefined
  if (payload.handoffs !== undefined) {
    if (!Array.isArray(payload.handoffs) || payload.handoffs.length > 100) throw new Error("Plan artifact handoffs must contain at most 100 records")
    handoffs = payload.handoffs.map((candidate, index) => {
      const handoff = artifactRecord(candidate, `Plan artifact handoff ${index}`)
      artifactExactKeys(handoff, ["mode", "createdAt", "sessionIDs", "runGroupID", "worktreeID"], `Plan artifact handoff ${index}`)
      if (!["implementation", "isolated", "multi-run", "goal"].includes(String(handoff.mode))) throw new Error("Plan artifact handoff mode is invalid")
      const sessionIDs = handoff.sessionIDs === undefined ? undefined : uniqueArtifactIDs(handoff.sessionIDs, 5, `Plan artifact handoff ${index} sessionIDs`)
      if (sessionIDs?.includes(ownerSessionID)) throw new Error("Plan artifact handoff sessions cannot repeat its owner")
      const runGroupID = artifactOptionalOpaque(handoff.runGroupID, 1_024, `Plan artifact handoff ${index} runGroupID`)
      const worktreeID = artifactOptionalOpaque(handoff.worktreeID, 1_024, `Plan artifact handoff ${index} worktreeID`)
      if (!sessionIDs?.length && !runGroupID && !worktreeID) throw new Error("Plan artifact handoff requires a related OpenCode session, run group, or worktree")
      for (const sessionID of sessionIDs ?? []) if (!relatedSessionIDs?.includes(sessionID)) throw new Error("Plan artifact handoff session is missing from relatedSessionIDs")
      return { mode: handoff.mode as PlanHandoffMode, createdAt: artifactInteger(handoff.createdAt, `Plan artifact handoff ${index} createdAt`), sessionIDs, runGroupID, worktreeID }
    })
  }
  if (["approved", "handed-off"].includes(phase) && approvedAt === undefined) throw new Error("Approved plan artifacts require approvedAt")
  if (!["approved", "handed-off"].includes(phase) && approvedAt !== undefined) throw new Error("Unapproved plan artifacts cannot have approvedAt")
  if (phase === "handed-off" && !handoffs?.length) throw new Error("Handed-off plan artifacts require handoff metadata")
  if (phase !== "handed-off" && handoffs?.length) throw new Error("Only handed-off plan artifacts can contain handoff metadata")
  return { phase, uri, revision: artifactHash(payload.revision, "Plan artifact revision"), approvedAt, relatedSessionIDs, handoffs }
}

function normalizeDiffAnchor(value: unknown, label: string): DiffAnchor {
  const anchor = artifactRecord(value, label)
  artifactExactKeys(anchor, ["file", "side", "startLine", "endLine", "hunkHeader"], label)
  if (!["base", "modified"].includes(String(anchor.side))) throw new Error(`${label}.side is invalid`)
  const startLine = artifactInteger(anchor.startLine, `${label}.startLine`, 1)
  const endLine = artifactInteger(anchor.endLine, `${label}.endLine`, startLine)
  return {
    file: artifactOpaque(anchor.file, 8_192, `${label}.file`),
    side: anchor.side as DiffAnchor["side"],
    startLine,
    endLine,
    hunkHeader: anchor.hunkHeader === undefined ? undefined : artifactString(anchor.hunkHeader, 2_000, `${label}.hunkHeader`),
  }
}

function normalizeReviewDocument(value: unknown): ReviewDocument {
  const document = artifactRecord(value, "Review document")
  artifactExactKeys(document, ["id", "diffHash", "model", "promptVersion", "generatedAt", "findings"], "Review document")
  if (!Array.isArray(document.findings) || document.findings.length > 100) throw new Error("Review document must contain at most 100 findings")
  const findingIDs = new Set<string>()
  const findings = document.findings.map((candidate, index): ReviewFinding => {
    const finding = artifactRecord(candidate, `Review finding ${index}`)
    artifactExactKeys(finding, ["id", "title", "detail", "category", "severity", "anchors"], `Review finding ${index}`)
    const id = artifactOpaque(finding.id, 1_024, `Review finding ${index}.id`)
    if (findingIDs.has(id)) throw new Error("Review document contains duplicate finding IDs")
    findingIDs.add(id)
    if (!["correctness", "security", "performance", "maintainability", "tests", "regression"].includes(String(finding.category))) throw new Error("Review finding category is invalid")
    if (!["critical", "high", "medium", "low"].includes(String(finding.severity))) throw new Error("Review finding severity is invalid")
    if (!Array.isArray(finding.anchors) || !finding.anchors.length || finding.anchors.length > 20) throw new Error("Review finding requires 1-20 exact anchors")
    return {
      id,
      title: artifactString(finding.title, 500, `Review finding ${index}.title`),
      detail: artifactString(finding.detail, 10_000, `Review finding ${index}.detail`),
      category: finding.category as ReviewFinding["category"],
      severity: finding.severity as ReviewFinding["severity"],
      anchors: finding.anchors.map((anchor, anchorIndex) => normalizeDiffAnchor(anchor, `Review finding ${index} anchor ${anchorIndex}`)),
    }
  })
  return {
    id: artifactOpaque(document.id, 1_024, "Review document ID"),
    diffHash: artifactHash(document.diffHash, "Review document diffHash"),
    model: artifactOpaque(document.model, 1_024, "Review document model"),
    promptVersion: artifactOpaque(document.promptVersion, 100, "Review document promptVersion"),
    generatedAt: artifactInteger(document.generatedAt, "Review document generatedAt"),
    findings,
  }
}

function normalizeReviewPayload(value: unknown): ReviewArtifactPayload {
  const payload = artifactRecord(value, "Review artifact payload")
  artifactExactKeys(payload, ["document", "repository", "baseRef", "scope", "diffHash", "stale", "dispositions"], "Review artifact payload")
  const document = normalizeReviewDocument(payload.document)
  const diffHash = artifactHash(payload.diffHash, "Review artifact diffHash")
  if (document.diffHash !== diffHash) throw new Error("Review artifact diff hash does not match its document")
  if (!["turn", "session", "staged", "unstaged", "branch", "pull-request"].includes(String(payload.scope))) throw new Error("Review artifact diff scope is invalid")
  if (typeof payload.stale !== "boolean") throw new Error("Review artifact stale flag is invalid")
  if (!Array.isArray(payload.dispositions) || payload.dispositions.length > document.findings.length) throw new Error("Review artifact dispositions are invalid")
  const findingIDs = new Set(document.findings.map((finding) => finding.id))
  const dispositionIDs = new Set<string>()
  const dispositions = payload.dispositions.map((candidate, index): ReviewFindingDisposition => {
    const disposition = artifactRecord(candidate, `Review disposition ${index}`)
    artifactExactKeys(disposition, ["findingID", "state", "updatedAt", "note"], `Review disposition ${index}`)
    const findingID = artifactOpaque(disposition.findingID, 1_024, `Review disposition ${index}.findingID`)
    if (!findingIDs.has(findingID)) throw new Error("Review disposition references an unknown finding")
    if (dispositionIDs.has(findingID)) throw new Error("Review artifact contains duplicate dispositions")
    dispositionIDs.add(findingID)
    if (!["open", "fixed", "dismissed", "accepted-risk"].includes(String(disposition.state))) throw new Error("Review disposition state is invalid")
    return {
      findingID,
      state: disposition.state as ReviewFindingDispositionState,
      updatedAt: artifactInteger(disposition.updatedAt, `Review disposition ${index}.updatedAt`),
      note: disposition.note === undefined ? undefined : artifactString(disposition.note, 2_000, `Review disposition ${index}.note`),
    }
  })
  return {
    document,
    repository: artifactOpaque(payload.repository, 8_192, "Review artifact repository"),
    baseRef: artifactOptionalOpaque(payload.baseRef, 1_024, "Review artifact baseRef"),
    scope: payload.scope as DiffScope,
    diffHash,
    stale: payload.stale,
    dispositions,
  }
}

function normalizeGoalVerdict(value: unknown): GoalVerdict {
  const verdict = artifactRecord(value, "Goal verification verdict")
  artifactExactKeys(verdict, ["verdict", "reason", "missingCriteria", "confidence"], "Goal verification verdict")
  if (!["continue", "complete", "blocked", "needs-user"].includes(String(verdict.verdict))) throw new Error("Goal verification verdict is invalid")
  if (!["low", "medium", "high"].includes(String(verdict.confidence))) throw new Error("Goal verification confidence is invalid")
  if (!Array.isArray(verdict.missingCriteria) || verdict.missingCriteria.length > 100) throw new Error("Goal verification has too many missing criteria")
  return {
    verdict: verdict.verdict as GoalVerdict["verdict"],
    reason: artifactString(verdict.reason, 4_000, "Goal verification reason"),
    missingCriteria: verdict.missingCriteria.map((criterion, index) => artifactString(criterion, 2_000, `Goal verification missing criterion ${index}`)),
    confidence: verdict.confidence as GoalVerdict["confidence"],
  }
}

function normalizeGoalVerificationPayload(value: unknown): GoalVerificationArtifactPayload {
  const payload = artifactRecord(value, "Goal verification artifact payload")
  artifactExactKeys(payload, ["settlementGeneration", "verdict", "attempts", "evidenceIDs", "applied", "stale", "appliedAt"], "Goal verification artifact payload")
  if (!Array.isArray(payload.attempts) || payload.attempts.length > 10) throw new Error("Goal verification must contain at most 10 attempts")
  const attemptNumbers = new Set<number>()
  const attempts = payload.attempts.map((candidate, index): GoalVerificationAttemptRecord => {
    const attempt = artifactRecord(candidate, `Goal verification attempt ${index}`)
    artifactExactKeys(attempt, ["attempt", "startedAt", "completedAt", "outcome", "sessionID", "model", "tokens", "cost"], `Goal verification attempt ${index}`)
    const number = artifactInteger(attempt.attempt, `Goal verification attempt ${index}.attempt`, 1, 10)
    if (attemptNumbers.has(number)) throw new Error("Goal verification contains duplicate attempt numbers")
    attemptNumbers.add(number)
    const startedAt = artifactInteger(attempt.startedAt, `Goal verification attempt ${index}.startedAt`)
    const completedAt = artifactInteger(attempt.completedAt, `Goal verification attempt ${index}.completedAt`, startedAt)
    if (!["completed", "invalid-output", "failed"].includes(String(attempt.outcome))) throw new Error("Goal verification attempt outcome is invalid")
    return {
      attempt: number,
      startedAt,
      completedAt,
      outcome: attempt.outcome as GoalVerificationAttemptRecord["outcome"],
      sessionID: artifactOptionalOpaque(attempt.sessionID, 1_024, `Goal verification attempt ${index}.sessionID`),
      model: artifactOptionalOpaque(attempt.model, 1_024, `Goal verification attempt ${index}.model`),
      tokens: artifactOptionalInteger(attempt.tokens, `Goal verification attempt ${index}.tokens`),
      cost: artifactCost(attempt.cost, `Goal verification attempt ${index}.cost`),
    }
  }).sort((left, right) => left.attempt - right.attempt)
  if (typeof payload.applied !== "boolean" || typeof payload.stale !== "boolean") throw new Error("Goal verification state flags are invalid")
  const verdict = payload.verdict === undefined ? undefined : normalizeGoalVerdict(payload.verdict)
  const appliedAt = artifactOptionalInteger(payload.appliedAt, "Goal verification appliedAt")
  if (payload.applied && (!verdict || appliedAt === undefined)) throw new Error("Applied goal verification requires a verdict and appliedAt")
  if (!payload.applied && appliedAt !== undefined) throw new Error("Advisory goal verification cannot have appliedAt")
  return {
    settlementGeneration: artifactInteger(payload.settlementGeneration, "Goal verification settlementGeneration"),
    verdict,
    attempts,
    evidenceIDs: uniqueArtifactIDs(payload.evidenceIDs, 500, "Goal verification evidenceIDs"),
    applied: payload.applied,
    stale: payload.stale,
    appliedAt,
  }
}

function normalizeRunComparisonRow(value: unknown, index: number): RunComparisonRow {
  const row = artifactRecord(value, `Run comparison row ${index}`)
  artifactExactKeys(row, ["runID", "status", "model", "agent", "variant", "elapsedMilliseconds", "changedFiles", "additions", "deletions", "taskOutcomes", "diagnostics", "verifierState", "tokens", "cost", "blocker", "complete", "limitation"], `Run comparison row ${index}`)
  if (!["pending", "preparing", "admitting", "working", "needs-input", "completed", "failed", "cancelled"].includes(String(row.status))) throw new Error("Run comparison status is invalid")
  if (!["not-recorded", "passed", "failed", "mixed"].includes(String(row.taskOutcomes))) throw new Error("Run comparison task outcome is invalid")
  if (!["not-recorded", "clean", "has-errors"].includes(String(row.diagnostics))) throw new Error("Run comparison diagnostics state is invalid")
  if (typeof row.complete !== "boolean") throw new Error("Run comparison completeness is invalid")
  return {
    runID: artifactOpaque(row.runID, 1_024, `Run comparison row ${index}.runID`),
    status: row.status as RunPhase,
    model: artifactOpaque(row.model, 1_024, `Run comparison row ${index}.model`),
    agent: artifactOptionalOpaque(row.agent, 1_024, `Run comparison row ${index}.agent`),
    variant: artifactOptionalOpaque(row.variant, 1_024, `Run comparison row ${index}.variant`),
    elapsedMilliseconds: artifactOptionalInteger(row.elapsedMilliseconds, `Run comparison row ${index}.elapsedMilliseconds`),
    changedFiles: artifactInteger(row.changedFiles, `Run comparison row ${index}.changedFiles`),
    additions: artifactInteger(row.additions, `Run comparison row ${index}.additions`),
    deletions: artifactInteger(row.deletions, `Run comparison row ${index}.deletions`),
    taskOutcomes: row.taskOutcomes as RunComparisonRow["taskOutcomes"],
    diagnostics: row.diagnostics as RunComparisonRow["diagnostics"],
    verifierState: row.verifierState === undefined ? undefined : artifactString(row.verifierState, 2_000, `Run comparison row ${index}.verifierState`),
    tokens: artifactOptionalInteger(row.tokens, `Run comparison row ${index}.tokens`),
    cost: artifactCost(row.cost, `Run comparison row ${index}.cost`),
    blocker: row.blocker === undefined ? undefined : artifactString(row.blocker, 4_000, `Run comparison row ${index}.blocker`),
    complete: row.complete,
    limitation: row.limitation === undefined ? undefined : artifactString(row.limitation, 4_000, `Run comparison row ${index}.limitation`),
  }
}

function normalizeRunComparisonPayload(value: unknown): RunComparisonArtifactPayload {
  const payload = artifactRecord(value, "Run comparison artifact payload")
  artifactExactKeys(payload, ["groupID", "rows"], "Run comparison artifact payload")
  if (!Array.isArray(payload.rows) || payload.rows.length > MULTI_RUN_MAX_CANDIDATES) throw new Error(`Run comparison must contain at most ${MULTI_RUN_MAX_CANDIDATES} rows`)
  const rows = payload.rows.map(normalizeRunComparisonRow)
  if (new Set(rows.map((row) => row.runID)).size !== rows.length) throw new Error("Run comparison contains duplicate run IDs")
  return { groupID: artifactOpaque(payload.groupID, 1_024, "Run comparison groupID"), rows }
}

function normalizeContextRange(value: unknown, label: string): ContextCaptureSourceMetadata["range"] {
  if (value === undefined) return undefined
  const range = artifactRecord(value, label)
  artifactExactKeys(range, ["startLine", "startColumn", "endLine", "endColumn"], label)
  const startLine = artifactInteger(range.startLine, `${label}.startLine`, 1)
  const startColumn = artifactInteger(range.startColumn, `${label}.startColumn`, 1)
  const endLine = artifactInteger(range.endLine, `${label}.endLine`, startLine)
  const endColumn = artifactInteger(range.endColumn, `${label}.endColumn`, 1)
  if (endLine === startLine && endColumn < startColumn) throw new Error(`${label} is reversed`)
  return { startLine, startColumn, endLine, endColumn }
}

function normalizeContextCapturePayload(value: unknown): ContextCaptureArtifactPayload {
  const payload = artifactRecord(value, "Context capture artifact payload")
  artifactExactKeys(payload, ["promptID", "receiptID", "admittedAt", "truncation", "estimatedTokens", "sources"], "Context capture artifact payload")
  const promptID = artifactOpaque(payload.promptID, 1_016, "Context capture promptID")
  const receiptID = artifactOpaque(payload.receiptID, 1_024, "Context capture receiptID")
  if (receiptID !== `context:${promptID}`) throw new Error("Context capture receiptID does not match its promptID")
  if (!["none", "explicit", "unknown"].includes(String(payload.truncation))) throw new Error("Context capture truncation state is invalid")
  if (!Array.isArray(payload.sources) || payload.sources.length > 100) throw new Error("Context capture must contain at most 100 source records")
  const sourceIDs = new Set<string>()
  const sources = payload.sources.map((candidate, index): ContextCaptureSourceMetadata => {
    const source = artifactRecord(candidate, `Context capture source ${index}`)
    artifactExactKeys(source, ["id", "kind", "label", "uri", "range", "revision", "contentHash", "estimatedTokens", "truncated"], `Context capture source ${index}`)
    const id = artifactOpaque(source.id, 1_024, `Context capture source ${index}.id`)
    if (sourceIDs.has(id)) throw new Error("Context capture contains duplicate source IDs")
    sourceIDs.add(id)
    if (!CONTEXT_KINDS.has(source.kind as ContextKind)) throw new Error("Context capture source kind is invalid")
    if (source.truncated !== undefined && typeof source.truncated !== "boolean") throw new Error("Context capture source truncation marker is invalid")
    const uri = source.uri === undefined ? undefined : (() => {
      if (typeof source.uri !== "string") throw new Error("Context capture source URI must be a string")
      return sanitizeDurableMetadataUri(source.uri)
    })()
    return {
      id,
      kind: source.kind as ContextKind,
      label: artifactString(source.label, 1_024, `Context capture source ${index}.label`),
      uri,
      range: normalizeContextRange(source.range, `Context capture source ${index}.range`),
      revision: source.revision === undefined ? undefined : artifactString(source.revision, 256, `Context capture source ${index}.revision`),
      contentHash: source.contentHash === undefined ? undefined : artifactHash(source.contentHash, `Context capture source ${index}.contentHash`),
      estimatedTokens: artifactOptionalInteger(source.estimatedTokens, `Context capture source ${index}.estimatedTokens`),
      truncated: source.truncated as boolean | undefined,
    }
  })
  return {
    promptID,
    receiptID,
    admittedAt: artifactInteger(payload.admittedAt, "Context capture admittedAt"),
    truncation: payload.truncation as ContextReceipt["truncation"],
    estimatedTokens: artifactOptionalInteger(payload.estimatedTokens, "Context capture estimatedTokens"),
    sources,
  }
}

/** Strictly validates, sanitizes, and deep-clones one durable task artifact. */
export function normalizeTaskArtifact(value: unknown): TaskArtifact {
  const artifact = artifactRecord(value, "Task artifact")
  artifactExactKeys(artifact, ["schemaVersion", "id", "kind", "sessionID", "lifecycle", "revision", "createdAt", "updatedAt", "producer", "payload"], "Task artifact")
  if (artifact.schemaVersion !== TASK_ARTIFACT_SCHEMA_VERSION) throw new Error("Task artifact schema version is unsupported")
  if (!TASK_ARTIFACT_KINDS.has(artifact.kind as TaskArtifactKind)) throw new Error("Task artifact kind is invalid")
  if (!TASK_ARTIFACT_LIFECYCLES.has(artifact.lifecycle as TaskArtifactLifecycle)) throw new Error("Task artifact lifecycle is invalid")
  const id = artifactOpaque(artifact.id, 1_024, "Task artifact ID")
  const sessionID = artifactOpaque(artifact.sessionID, 1_024, "Task artifact sessionID")
  const revision = artifactInteger(artifact.revision, "Task artifact revision", 1)
  const createdAt = artifactInteger(artifact.createdAt, "Task artifact createdAt")
  const updatedAt = artifactInteger(artifact.updatedAt, "Task artifact updatedAt", createdAt)
  const producer = artifact.producer === undefined ? undefined : normalizeArtifactProducer(artifact.producer, "Task artifact producer")
  const common = { schemaVersion: TASK_ARTIFACT_SCHEMA_VERSION, id, sessionID, lifecycle: artifact.lifecycle as TaskArtifactLifecycle, revision, createdAt, updatedAt }

  if (artifact.kind === "plan") {
    if (!producer || producer.sessionID !== sessionID) throw new Error("Plan artifacts require their owning OpenCode session as producer")
    return { ...common, kind: "plan", producer, payload: normalizePlanPayload(artifact.payload, sessionID) }
  }
  if (artifact.kind === "review") {
    if (!producer) throw new Error("Review artifacts require OpenCode producer provenance")
    return { ...common, kind: "review", producer, payload: normalizeReviewPayload(artifact.payload) }
  }
  if (artifact.kind === "goal-verification") {
    const payload = normalizeGoalVerificationPayload(artifact.payload)
    if (payload.verdict && !producer) throw new Error("Goal verification verdicts require OpenCode producer provenance")
    if (producer && !payload.attempts.some((attempt) => attempt.sessionID === producer.sessionID)) throw new Error("Goal verification producer must identify one of its OpenCode attempts")
    return { ...common, kind: "goal-verification", producer, payload }
  }
  if (artifact.kind === "run-comparison") {
    if (producer) throw new Error("Deterministic run comparisons cannot claim an AI producer")
    return { ...common, kind: "run-comparison", payload: normalizeRunComparisonPayload(artifact.payload) }
  }
  if (producer) throw new Error("Deterministic context captures cannot claim an AI producer")
  return { ...common, kind: "context-capture", payload: normalizeContextCapturePayload(artifact.payload) }
}

/** Builds the metadata-only row projected into artifact lists. */
export function taskArtifactSummary(value: TaskArtifact): TaskArtifactSummary {
  const artifact = normalizeTaskArtifact(value)
  const common = {
    schemaVersion: TASK_ARTIFACT_SCHEMA_VERSION,
    id: artifact.id,
    kind: artifact.kind,
    sessionID: artifact.sessionID,
    lifecycle: artifact.lifecycle,
    revision: artifact.revision,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }
  if (artifact.kind === "plan") return { ...common, state: artifact.payload.phase, itemCount: artifact.payload.handoffs?.length }
  if (artifact.kind === "review") return { ...common, state: artifact.payload.stale ? "stale" : "ready", itemCount: artifact.payload.document.findings.length, stale: artifact.payload.stale }
  if (artifact.kind === "goal-verification") {
    const state = artifact.payload.stale ? "stale" : artifact.payload.applied ? "applied" : artifact.payload.verdict?.verdict ?? "pending"
    return { ...common, state, itemCount: artifact.payload.evidenceIDs.length, stale: artifact.payload.stale }
  }
  if (artifact.kind === "run-comparison") return { ...common, state: artifact.payload.rows.every((row) => row.complete) ? "complete" : "incomplete", itemCount: artifact.payload.rows.length }
  return { ...common, state: artifact.payload.truncation === "none" ? "complete" : "limited", itemCount: artifact.payload.sources.length }
}
