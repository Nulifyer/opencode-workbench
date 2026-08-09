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
