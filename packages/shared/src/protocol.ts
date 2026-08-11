import type {
  AgentOption,
  ContextSummary,
  ContextAttachmentSummary,
  CommandOption,
  DelegationProgress,
  FileChange,
  GoalMetricSummary,
  GoalSummary,
  EditorContextSummary,
  InlineAttachment,
  MessageBundle,
  ModelOption,
  OpenCodePty,
  PastedTextBlock,
  PermissionRequest,
  ProviderOption,
  QueuedPrompt,
  QuestionRequest,
  RuntimeStatus,
  ResourceOption,
  SessionMetrics,
  SessionStatus,
  TodoItem,
} from "./opencode.ts"
import { sanitizeDurableMetadataText } from "./workbench-domain.ts"
import type { AttentionItem, ContextReceipt, EvidenceReference, RunComparisonRow, RunGroup, TaskArtifactSummary, WalkthroughDocument, WorktreeJournalEntry } from "./workbench-domain.ts"
import type { ConnectionState } from "./session-state.ts"
import {
  PERMISSION_AGGREGATE_CHARACTER_LIMIT,
  PERMISSION_METADATA_CHARACTER_LIMIT,
  PROMPT_ATTACHMENT_COUNT_LIMIT,
  PROMPT_ATTACHMENT_CHARACTER_LIMIT,
  PROMPT_QUEUE_CHARACTER_LIMIT,
  PROMPT_QUEUE_COUNT_LIMIT,
  PROMPT_TEXT_CHARACTER_LIMIT,
  isOpenCodeMessageID,
  permissionRequestCharacters,
} from "./opencode.ts"

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "setDraft"; sessionID: string; draft: string }
  | { type: "setComposerPayload"; sessionID: string; revision: number; mutationID: string; attachments: InlineAttachment[]; pastedText: PastedTextBlock[] }
  | { type: "send"; sessionID: string; promptID?: string; composerRevision?: number; delivery?: "queue" | "steer" | "replace"; text: string; agent?: string; model?: string; variant?: string; attachments?: InlineAttachment[]; pastedText?: PastedTextBlock[]; contextIDs?: string[] }
  | { type: "sendMultiModel"; sessionID: string; composerRevision?: number; text: string; models: string[]; concurrency: number; agent?: string; variant?: string; attachments?: InlineAttachment[]; pastedText?: PastedTextBlock[]; contextIDs?: string[] }
  | { type: "abort"; sessionID: string }
  | { type: "createSession"; draft?: string; submit?: boolean }
  | { type: "planTask" }
  | { type: "loadOlderHistory"; sessionID: string; beforeMessageID: string }
  | { type: "selectSession"; sessionID: string }
  | { type: "setPreference"; sessionID: string; agent?: string; model?: string; variant?: string }
  | { type: "removeQueued"; sessionID: string; promptID: string }
  | { type: "editQueued"; sessionID: string; promptID: string }
  | { type: "reorderQueue"; sessionID: string; promptIDs: string[] }
  | { type: "sendQueuedNow"; sessionID: string; promptID: string }
  | { type: "respondPermission"; sessionID: string; requestID: string; protocol: "legacy" | "current" | "v2"; response: "once" | "exact" | "scope" | "reject"; scope?: string; feedback?: string }
  | { type: "respondQuestion"; sessionID: string; requestID: string; answers: string[][] }
  | { type: "rejectQuestion"; sessionID: string; requestID: string }
  | { type: "openFile"; sessionID: string; file: string; line?: number; column?: number; endLine?: number; endColumn?: number }
  | { type: "openPatch"; sessionID: string; file: string }
  | { type: "sessionAction"; sessionID: string; action: "rename" | "delete" | "fork" | "undo" | "redo" | "retry" | "compact" | "share" | "unshare" | "export" | "copyLast" | "copyTranscript"; messageID?: string }
  | { type: "sessionPresentation"; sessionID: string; action: "pin" | "unpin" | "archive" }
  | { type: "ptyAction"; id: string; action: "cancel" }
  | { type: "jobAction"; sessionID: string; action: "open" | "background" }
  | { type: "setAutoApproval"; sessionID: string; enabled: boolean }
  | { type: "goalAction"; sessionID: string; action: "edit" | "configure" | "verify" | "pause" | "resume" | "cancel" }
  | { type: "configureGoal"; sessionID: string; expectedSettlementGeneration?: number; configuration: GoalConfigurationInput }
  | { type: "artifactAction"; sessionID: string; artifactID: string; action: "open" | "approve" | "handoff" | "archive" | "delete" | "open-finding" | "set-finding-disposition" | "regenerate"; expectedRevision?: number; findingID?: string; disposition?: "open" | "fixed" | "dismissed" | "accepted-risk" }
  | { type: "requestRecoveryPreview"; sessionID: string; messageID?: string }
  | { type: "applyRecovery"; sessionID: string; mode: "revert" | "fork" | "redo"; messageID?: string }
  | { type: "healthAction"; action: "refresh" | "reconnect" | "logs" | "trace" | "copy" }
  | { type: "evidenceAction"; action: "capture" }
  | { type: "workbenchAction"; sessionID: string; action: "refresh-session" | "review" | "walkthrough" | "compare-models" }
  | { type: "contextReceiptAction"; sessionID: string; receiptID: string; itemID: string; action: "open-source" }
  | { type: "browserContextAction"; sessionID: string; action: "capture"; task?: string; sources?: Array<"selection" | "console" | "element" | "terminal-task" | "diagnostics" | "debug" | "url" | "screenshot">; approvedUrl?: string }
  | { type: "runAction"; groupID: string; action: "refresh" | "compare" | "fuse" }
  | { type: "runAction"; groupID: string; action: "export-comparison"; comparisonArtifactID: string; comparisonRevision: number }
  | { type: "runAction"; groupID: string; runID: string; action: "open" | "cancel" | "retry" | "diff" | "review" | "keep" | "discard" }
  | { type: "walkthroughAction"; documentID: string; stopID: string }
  | { type: "openInEditor"; tab?: WorkbenchInspectorTab }
  | { type: "openInSidebar" }
  | { type: "navigateBack" }
  | { type: "markAttentionRead" }
  | { type: "refresh" }
  | { type: "openLogs" }
  | { type: "openHelp" }
  | { type: "openFolder" }
  | { type: "reloadWindow" }
  | { type: "openLink"; url: string }
  | { type: "copyText"; text: string }
  | { type: "pickFiles"; sessionID: string }
  | { type: "attachCurrentEditor"; sessionID: string }
  | { type: "resolveDroppedUris"; sessionID: string; uris: string[] }
  | { type: "searchFiles"; sessionID: string; requestID: number; query: string }
  | { type: "removeContextAttachment"; sessionID: string; attachmentID: string }
  | { type: "openContextAttachment"; sessionID: string; attachmentID: string }
  | { type: "attachWorkspacePath"; sessionID: string; path: string }
  | { type: "attachResource"; sessionID: string; uri: string }
  | { type: "openPlan"; sessionID: string }
  | { type: "mcpAction"; sessionID: string; name: string; action: "connect" | "disconnect" | "authenticate" | "removeAuth" }

export type WorkbenchInspectorTab = "activity" | "changes" | "context" | "plan" | "goal" | "jobs" | "runs" | "lineage" | "walkthrough" | "review" | "evidence" | "health"

export interface GoalConfigurationInput {
  objective: string
  acceptanceCriteria: string[]
  tokenBudget: number | null
  maxAutoTurns: number | null
  maxDurationSeconds: number | null
  verifier: { enabled: boolean; model: string | null; agent: string | null; timeoutMilliseconds: number; repeatedBlockThreshold: number }
}

export interface WorkbenchHealthSummary {
  workbenchVersion: string
  vscodeVersion: string
  openCodeVersion?: string
  serverMode: "managed" | "external"
  serverState: "starting" | "connected" | "reconnecting" | "failed" | "disconnected"
  pluginState: "available" | "unavailable" | "unknown"
  capabilities: string[]
  eventStream: { state: string; lastEventAt?: number; lastReconciliationAt?: number; reconnectCount: number }
  requestQueueDepth: number
  protocol: { version: number; epoch?: string }
}

export interface WorkbenchTraceSummary {
  type: string
  timestamp: number
  sessionID?: string
  transition?: string
  durationMilliseconds?: number
}

export interface RecoveryPreview {
  sessionID: string
  messageID: string
  userText: string
  removedMessageIDs: string[]
  removedTurns: number
  changedFiles: Array<{ file: string; additions: number; deletions: number }>
  limitations: string[]
  canRevert: boolean
  canFork: boolean
  canRedo: boolean
}

/** Bounded objective-matrix projection derived from a run-comparison artifact. */
export interface RunComparisonSnapshot {
  artifactID: string
  revision: number
  groupID: string
  rows: RunComparisonRow[]
  updatedAt: number
  stale?: boolean
}

/**
 * Bounded OpenCode-native session ancestry. The ordinary `sessions` array
 * remains a root-only rail projection; this collection is the source for
 * Lineage and descendant Jobs without turning Workbench into a session store.
 */
export interface SessionLineageNode {
  sessionID: string
  parentID?: string
  rootID: string
  depth: number
  relation: "root" | "child" | "run" | "fusion" | "recovery"
  title: string
  status: SessionStatus
  updatedAt: number
  directory?: string
  model?: string
  agent?: string
  tokens?: number
  cost?: number
  attention?: number
  questionCount?: number
  permissionCount?: number
  archived?: boolean
  shared?: boolean
  branch?: string
  worktree?: string
  runGroupID?: string
  runID?: string
  worktreeID?: string
}

/** Bounded finding detail for the selected session's active review artifacts. */
export interface ReviewFindingSnapshot {
  sessionID: string
  artifactID: string
  artifactRevision: number
  artifactUpdatedAt: number
  stale: boolean
  diffHash: string
  findingID: string
  title: string
  detail: string
  category: "correctness" | "security" | "performance" | "maintainability" | "tests" | "regression"
  severity: "critical" | "high" | "medium" | "low"
  anchors: Array<{ file: string; side: "base" | "modified"; startLine: number; endLine: number; hunkHeader?: string }>
  disposition: "open" | "fixed" | "dismissed" | "accepted-risk"
}

export interface ChatSnapshot {
  connected: boolean
  connectionState: ConnectionState
  connectionError?: string
  sessions: Array<{
    id: string
    title: string
    status: SessionStatus
    unread: number
    directory?: string
    parentID?: string
    updatedAt?: number
    attention?: number
    questionCount?: number
    permissionCount?: number
    queued?: number
    todo?: { completed: number; total: number }
    changeCount?: number
    pinned?: boolean
    archived?: boolean
    shared?: boolean
    shareUrl?: string
    model?: string
    agent?: string
    tokens?: number
    branch?: string
    worktree?: string
    cost?: number
    summary?: { additions: number; deletions: number; files: number }
    rootID?: string
    depth?: number
  }>
  /** All bounded visible OpenCode roots and descendants for Lineage and Jobs. */
  lineage?: SessionLineageNode[]
  session?: {
    id: string
    parentID?: string
    directory?: string
    title: string
    draft: string
    status: SessionStatus
    loaded: boolean
    loadState: "idle" | "loading" | "ready" | "error"
    messages: MessageBundle[]
    messageRevisions: Record<string, number>
    agent?: string
    model?: string
    variant?: string
    queue?: QueuedPrompt[]
    inFlightPromptID?: string
    permissions?: PermissionRequest[]
    questions?: QuestionRequest[]
    todos?: TodoItem[]
    changes?: FileChange[]
    context?: ContextSummary
    metrics?: SessionMetrics
    goal?: GoalSummary
    goalHistory?: GoalMetricSummary[]
    delegations?: DelegationProgress[]
    contextReceipts?: ContextReceipt[]
    history?: TranscriptHistoryState
    archived?: boolean
    shared?: boolean
    shareUrl?: string
    revertMessageID?: string
  }
  agents: AgentOption[]
  mentionAgents?: AgentOption[]
  providers?: ProviderOption[]
  models: ModelOption[]
  resources?: ResourceOption[]
  catalog?: { status: "ready" | "stale" | "error"; updatedAt?: number; error?: string }
  commands?: CommandOption[]
  autoApproval?: boolean
  runtime?: RuntimeStatus
  /** Bounded metadata from OpenCode's native PTY control plane. */
  ptys?: OpenCodePty[]
  attentionItems?: AttentionItem[]
  composer?: { enterBehavior: "send" | "newline" }
  runGroups?: RunGroup[]
  worktrees?: WorktreeJournalEntry[]
  walkthroughs?: WalkthroughDocument[]
  /** Metadata-only durable artifacts scoped to the selected OpenCode session. */
  artifacts?: TaskArtifactSummary[]
  /** Bounded finding detail scoped to active reviews for the selected session. */
  reviewFindings?: ReviewFindingSnapshot[]
  /** Bounded deterministic evidence scoped to the selected OpenCode session. */
  evidence?: EvidenceReference[]
  /** Objective rows only; never a full task-artifact payload. */
  runComparisons?: RunComparisonSnapshot[]
  health?: WorkbenchHealthSummary
  trace?: WorkbenchTraceSummary[]
  /**
   * Present only when the extension host had to project an otherwise valid
   * snapshot below the webview transport limit. The authoritative session and
   * durable metadata stores are not changed by this projection.
   */
  projection?: ChatSnapshotProjection
}

export interface ChatSnapshotProjectionOmissions {
  sessions?: number
  lineage?: number
  messages?: number
  delegations?: number
  queuedPrompts?: number
  permissions?: number
  questions?: number
  todos?: number
  changes?: number
  contextReceipts?: number
  catalogItems?: number
  runtimeServices?: number
  ptys?: number
  attentionItems?: number
  runGroups?: number
  worktrees?: number
  walkthroughs?: number
  walkthroughStops?: number
  taskArtifacts?: number
  reviewFindings?: number
  evidence?: number
  runComparisons?: number
}

export interface ChatSnapshotProjection {
  truncated: true
  limitBytes: number
  encodedBytes: number
  omitted: ChatSnapshotProjectionOmissions
  message: string
}

export interface TranscriptHistoryState {
  /** Messages retained by the controller after OpenCode history paging and safety limits. */
  totalMessages: number
  /** Messages currently projected into this webview transcript. */
  visibleMessages: number
  hasOlder: boolean
  limitedBy?: "messages" | "parts" | "characters"
  /** Upstream history may have been clipped by a client safety bound; older server history may exist. */
  sourceMayBeTruncated?: boolean
}

export interface TranscriptHistoryPage {
  sessionID: string
  messages: MessageBundle[]
  messageRevisions: Record<string, number>
  hasOlder: boolean
  totalMessages: number
  sourceMayBeTruncated?: boolean
}

export interface MessagePatch {
  sessionID: string
  messageID: string
  message?: MessageBundle
  revision: number
  active: boolean
  append: boolean
  afterMessageID?: string
}

export type HostToWebviewMessage =
  | { type: "snapshot"; snapshot: ChatSnapshot }
  | { type: "messagePatches"; patches: MessagePatch[] }
  | { type: "historyPage"; page: TranscriptHistoryPage }
  | { type: "error"; message: string }
  | { type: "insertText"; sessionID: string; text: string }
  | { type: "fileSuggestions"; sessionID: string; requestID: number; files: string[] }
  | { type: "editorContextChanged"; context?: EditorContextSummary }
  | { type: "contextAttachmentsChanged"; sessionID: string; attachments: ContextAttachmentSummary[] }
  | { type: "composerPayloadChanged"; sessionID: string; revision: number; attachments: InlineAttachment[]; pastedText: PastedTextBlock[]; conflict?: boolean; mutationID?: string }
  | { type: "draftChanged"; sessionID: string; draft: string; revision: number }
  | { type: "sessionRemoved"; sessionID: string }
  | { type: "navigateWorkbench"; tab: WorkbenchInspectorTab; itemID?: string; focus?: boolean }
  | { type: "workbenchControl"; target: "sessions" | "jobs" | "attention"; action: "show" | "toggle" }
  | { type: "recoveryPreview"; preview: RecoveryPreview }

type UnknownRecord = Record<string, unknown>

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function boundedString(value: unknown, limit = 1_024): value is string {
  return typeof value === "string" && value.length <= limit
}

function boundedOptionalString(value: unknown, limit = 1_024): value is string | undefined {
  return optionalString(value) && (value === undefined || value.length <= limit)
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function validID(value: unknown): value is string {
  return boundedString(value) && value.length > 0
}

function validPromptID(value: unknown): value is string {
  return isOpenCodeMessageID(value)
}

const inlineMimes = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp", "application/pdf"])
const WORKBENCH_INSPECTOR_TABS = new Set<string>(["activity", "changes", "context", "plan", "goal", "jobs", "runs", "lineage", "walkthrough", "review", "evidence", "health"] satisfies WorkbenchInspectorTab[])

function validGoalLimit(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000_000_000)
}

function validGoalConfiguration(value: unknown): value is GoalConfigurationInput {
  if (!record(value) || !exactKeys(value, ["objective", "acceptanceCriteria", "tokenBudget", "maxAutoTurns", "maxDurationSeconds", "verifier"]) ||
    !boundedString(value.objective, 4_000) || !value.objective.trim() ||
    !Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length < 1 || value.acceptanceCriteria.length > 100 ||
    !value.acceptanceCriteria.every((criterion) => boundedString(criterion, 2_000) && criterion.trim().length > 0) ||
    !validGoalLimit(value.tokenBudget) || !validGoalLimit(value.maxAutoTurns) ||
    !validGoalLimit(value.maxDurationSeconds) || !record(value.verifier) ||
    !exactKeys(value.verifier, ["enabled", "model", "agent", "timeoutMilliseconds", "repeatedBlockThreshold"])) return false
  return typeof value.verifier.enabled === "boolean" && (value.verifier.model === null || boundedString(value.verifier.model)) &&
    (value.verifier.agent === null || boundedString(value.verifier.agent)) && Number.isSafeInteger(value.verifier.timeoutMilliseconds) &&
    Number(value.verifier.timeoutMilliseconds) >= 1_000 && Number(value.verifier.timeoutMilliseconds) <= 300_000 &&
    Number.isSafeInteger(value.verifier.repeatedBlockThreshold) && Number(value.verifier.repeatedBlockThreshold) >= 1 && Number(value.verifier.repeatedBlockThreshold) <= 10
}

function validInlineAttachments(value: unknown, optional = true): value is InlineAttachment[] | undefined {
  if (value === undefined) return optional
  if (!Array.isArray(value) || value.length > 10) return false
  const ids = new Set<string>()
  const labels = new Set<string>()
  let characters = 0
  return value.every((attachment) => {
    if (!record(attachment) || !exactKeys(attachment, ["id", "label", "name", "mime", "data", "size", "width", "height"]) || !validID(attachment.id) || ids.has(attachment.id) ||
      !boundedString(attachment.label, 100) || !/^\[(?:Image|PDF) \d+\]$/.test(attachment.label) || labels.has(attachment.label) || !boundedString(attachment.name, 255) || !attachment.name ||
      typeof attachment.mime !== "string" || !inlineMimes.has(attachment.mime) || typeof attachment.data !== "string" ||
      attachment.data.length > (attachment.mime === "application/pdf" ? 14_000_000 : 5_242_880) || attachment.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data) || !Number.isSafeInteger(attachment.size) || Number(attachment.size) < 0 ||
      Number(attachment.size) > (attachment.mime === "application/pdf" ? 10_000_000 : 3_900_000) ||
      ![attachment.width, attachment.height].every((dimension) => dimension === undefined || (Number.isSafeInteger(dimension) && Number(dimension) > 0 && Number(dimension) <= 100_000))) return false
    ids.add(attachment.id)
    labels.add(attachment.label)
    characters += attachment.id.length + attachment.label.length + attachment.name.length + attachment.mime.length + attachment.data.length
    return characters <= PROMPT_ATTACHMENT_CHARACTER_LIMIT
  })
}

function validPastedText(value: unknown): value is PastedTextBlock[] {
  if (!Array.isArray(value) || value.length > 20) return false
  const ids = new Set<string>()
  const labels = new Set<string>()
  let characters = 0
  return value.every((block) => {
    if (!record(block) || !exactKeys(block, ["id", "label", "text", "lineCount"]) || !validID(block.id) || ids.has(block.id) ||
      !boundedString(block.label, 100) || !/^\[Pasted text \d+ · ~\d+ lines\]$/.test(block.label) || labels.has(block.label) ||
      !boundedString(block.text, PROMPT_TEXT_CHARACTER_LIMIT) || !Number.isSafeInteger(block.lineCount) || Number(block.lineCount) < 1 || Number(block.lineCount) > PROMPT_TEXT_CHARACTER_LIMIT) return false
    ids.add(block.id)
    labels.add(block.label)
    characters += block.id.length + block.label.length + block.text.length
    return characters <= PROMPT_TEXT_CHARACTER_LIMIT
  })
}

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  switch (value.type) {
    case "abort":
      return boundedString(value.sessionID) && value.sessionID.length > 0
        ? { type: "abort", sessionID: value.sessionID }
        : undefined
    case "createSession":
      return exactKeys(value, ["type", "draft", "submit"]) && boundedOptionalString(value.draft, PROMPT_TEXT_CHARACTER_LIMIT) &&
          (value.submit === undefined || typeof value.submit === "boolean") && (!value.submit || Boolean(value.draft?.trim()))
        ? { type: "createSession", draft: value.draft, submit: value.submit }
        : undefined
    case "planTask":
      return exactKeys(value, ["type"]) ? { type: "planTask" } : undefined
    case "loadOlderHistory":
      return exactKeys(value, ["type", "sessionID", "beforeMessageID"]) && validID(value.sessionID) && validID(value.beforeMessageID)
        ? { type: "loadOlderHistory", sessionID: value.sessionID, beforeMessageID: value.beforeMessageID }
        : undefined
    case "ready":
      return { type: "ready" }
    case "openInEditor":
      return exactKeys(value, ["type", "tab"]) && (value.tab === undefined || WORKBENCH_INSPECTOR_TABS.has(String(value.tab)))
        ? { type: "openInEditor", tab: value.tab as WorkbenchInspectorTab | undefined }
        : undefined
    case "openInSidebar":
      return exactKeys(value, ["type"]) ? { type: "openInSidebar" } : undefined
    case "navigateBack":
      return exactKeys(value, ["type"]) ? { type: "navigateBack" } : undefined
    case "markAttentionRead":
      return exactKeys(value, ["type"]) ? { type: "markAttentionRead" } : undefined
    case "refresh":
      return exactKeys(value, ["type"]) ? { type: "refresh" } : undefined
    case "openLogs":
      return exactKeys(value, ["type"]) ? { type: "openLogs" } : undefined
    case "openHelp":
      return exactKeys(value, ["type"]) ? { type: "openHelp" } : undefined
    case "openFolder":
      return exactKeys(value, ["type"]) ? { type: "openFolder" } : undefined
    case "reloadWindow":
      return exactKeys(value, ["type"]) ? { type: "reloadWindow" } : undefined
    case "setDraft":
      return boundedString(value.sessionID) && value.sessionID.length > 0 && typeof value.draft === "string" && value.draft.length <= PROMPT_TEXT_CHARACTER_LIMIT
        ? { type: "setDraft", sessionID: value.sessionID, draft: value.draft }
        : undefined
    case "setComposerPayload":
      return exactKeys(value, ["type", "sessionID", "revision", "mutationID", "attachments", "pastedText"]) && validID(value.sessionID) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 &&
          typeof value.mutationID === "string" && /^cmp_[a-f0-9]{32}$/.test(value.mutationID) && validInlineAttachments(value.attachments, false) && validPastedText(value.pastedText) &&
          (Array.isArray(value.attachments) ? value.attachments.length : 0) + (Array.isArray(value.pastedText) ? value.pastedText.length : 0) <= PROMPT_ATTACHMENT_COUNT_LIMIT
        ? value as unknown as WebviewToHostMessage
        : undefined
    case "send":
      return exactKeys(value, ["type", "sessionID", "promptID", "composerRevision", "delivery", "text", "agent", "model", "variant", "attachments", "pastedText", "contextIDs"]) && boundedString(value.sessionID) && value.sessionID.length > 0 &&
          (value.promptID === undefined || validPromptID(value.promptID)) &&
          (value.composerRevision === undefined || (Number.isSafeInteger(value.composerRevision) && Number(value.composerRevision) >= 0)) &&
          (value.delivery === undefined || value.delivery === "queue" || value.delivery === "steer" || value.delivery === "replace") &&
          typeof value.text === "string" && value.text.length <= PROMPT_TEXT_CHARACTER_LIMIT && (value.text.trim().length > 0 || (Array.isArray(value.attachments) && value.attachments.length > 0) || (Array.isArray(value.pastedText) && value.pastedText.length > 0) || (Array.isArray(value.contextIDs) && value.contextIDs.length > 0)) &&
          boundedOptionalString(value.agent) && boundedOptionalString(value.model) && boundedOptionalString(value.variant) && validInlineAttachments(value.attachments) && (value.pastedText === undefined || validPastedText(value.pastedText)) &&
          (value.attachments?.length ?? 0) + (value.pastedText?.length ?? 0) <= PROMPT_ATTACHMENT_COUNT_LIMIT &&
          (value.contextIDs === undefined || (Array.isArray(value.contextIDs) && value.contextIDs.length <= 20 && value.contextIDs.every(validID) && new Set(value.contextIDs).size === value.contextIDs.length))
        ? { type: "send", sessionID: value.sessionID, promptID: value.promptID, composerRevision: value.composerRevision as number | undefined, delivery: value.delivery as "queue" | "steer" | "replace" | undefined, text: value.text, agent: value.agent, model: value.model, variant: value.variant, attachments: value.attachments, pastedText: value.pastedText as PastedTextBlock[] | undefined, contextIDs: value.contextIDs as string[] | undefined }
        : undefined
    case "sendMultiModel":
      return exactKeys(value, ["type", "sessionID", "composerRevision", "text", "models", "concurrency", "agent", "variant", "attachments", "pastedText", "contextIDs"]) && boundedString(value.sessionID) && value.sessionID.length > 0 &&
          (value.composerRevision === undefined || (Number.isSafeInteger(value.composerRevision) && Number(value.composerRevision) >= 0)) &&
          typeof value.text === "string" && value.text.length <= PROMPT_TEXT_CHARACTER_LIMIT && value.text.trim().length > 0 &&
          Array.isArray(value.models) && value.models.length >= 2 && value.models.length <= 100 && value.models.every(validID) && new Set(value.models).size === value.models.length &&
          Number.isSafeInteger(value.concurrency) && Number(value.concurrency) >= 1 && Number(value.concurrency) <= 20 && Number(value.concurrency) <= value.models.length &&
          boundedOptionalString(value.agent) && boundedOptionalString(value.variant) && validInlineAttachments(value.attachments) && (value.pastedText === undefined || validPastedText(value.pastedText)) &&
          (value.attachments?.length ?? 0) + (value.pastedText?.length ?? 0) <= PROMPT_ATTACHMENT_COUNT_LIMIT &&
          (value.contextIDs === undefined || (Array.isArray(value.contextIDs) && value.contextIDs.length <= 20 && value.contextIDs.every(validID) && new Set(value.contextIDs).size === value.contextIDs.length))
        ? { type: "sendMultiModel", sessionID: value.sessionID, composerRevision: value.composerRevision as number | undefined, text: value.text, models: value.models as string[], concurrency: Number(value.concurrency), agent: value.agent, variant: value.variant, attachments: value.attachments, pastedText: value.pastedText as PastedTextBlock[] | undefined, contextIDs: value.contextIDs as string[] | undefined }
        : undefined
    case "pickFiles":
    case "attachCurrentEditor":
      return exactKeys(value, ["type", "sessionID"]) && validID(value.sessionID) ? { type: value.type, sessionID: value.sessionID } : undefined
    case "resolveDroppedUris":
      return exactKeys(value, ["type", "sessionID", "uris"]) && validID(value.sessionID) && Array.isArray(value.uris) && value.uris.length <= 10 && value.uris.every((uri) => boundedString(uri, 8_192))
        ? { type: "resolveDroppedUris", sessionID: value.sessionID, uris: value.uris }
        : undefined
    case "searchFiles":
      return exactKeys(value, ["type", "sessionID", "requestID", "query"]) && validID(value.sessionID) && Number.isSafeInteger(value.requestID) && Number(value.requestID) >= 0 &&
          boundedString(value.query, 100) && /^[A-Za-z0-9._~/-]*$/.test(value.query)
        ? { type: "searchFiles", sessionID: value.sessionID, requestID: Number(value.requestID), query: value.query }
        : undefined
    case "removeContextAttachment":
      return exactKeys(value, ["type", "sessionID", "attachmentID"]) && validID(value.sessionID) && validID(value.attachmentID)
        ? { type: "removeContextAttachment", sessionID: value.sessionID, attachmentID: value.attachmentID }
        : undefined
    case "openContextAttachment":
      return exactKeys(value, ["type", "sessionID", "attachmentID"]) && validID(value.sessionID) && validID(value.attachmentID)
        ? { type: "openContextAttachment", sessionID: value.sessionID, attachmentID: value.attachmentID }
        : undefined
    case "attachWorkspacePath":
      return exactKeys(value, ["type", "sessionID", "path"]) && validID(value.sessionID) && boundedString(value.path, 8_192) && value.path.length > 0
        ? { type: "attachWorkspacePath", sessionID: value.sessionID, path: value.path }
        : undefined
    case "attachResource":
      return exactKeys(value, ["type", "sessionID", "uri"]) && validID(value.sessionID) && boundedString(value.uri, 8_192) && value.uri.length > 0
        ? { type: "attachResource", sessionID: value.sessionID, uri: value.uri }
        : undefined
    case "openPlan":
      return exactKeys(value, ["type", "sessionID"]) && validID(value.sessionID) ? { type: "openPlan", sessionID: value.sessionID } : undefined
    case "mcpAction":
      return exactKeys(value, ["type", "sessionID", "name", "action"]) && validID(value.sessionID) && boundedString(value.name, 1_024) && value.name.length > 0 &&
          ["connect", "disconnect", "authenticate", "removeAuth"].includes(String(value.action))
        ? value as unknown as WebviewToHostMessage
        : undefined
    case "setPreference":
      return boundedString(value.sessionID) && value.sessionID.length > 0 && boundedOptionalString(value.agent) && boundedOptionalString(value.model) && boundedOptionalString(value.variant)
        ? { type: "setPreference", sessionID: value.sessionID, agent: value.agent, model: value.model, variant: value.variant }
        : undefined
    case "removeQueued":
    case "editQueued":
    case "sendQueuedNow":
      return exactKeys(value, ["type", "sessionID", "promptID"]) && validID(value.sessionID) && validID(value.promptID)
        ? { type: value.type, sessionID: value.sessionID, promptID: value.promptID }
        : undefined
    case "reorderQueue":
      return exactKeys(value, ["type", "sessionID", "promptIDs"]) && validID(value.sessionID) &&
          Array.isArray(value.promptIDs) && value.promptIDs.length <= 100 &&
          value.promptIDs.every(validID) && new Set(value.promptIDs).size === value.promptIDs.length
        ? { type: "reorderQueue", sessionID: value.sessionID, promptIDs: value.promptIDs }
        : undefined
    case "respondPermission":
      return exactKeys(value, ["type", "sessionID", "requestID", "protocol", "response", "scope", "feedback"]) && validID(value.sessionID) && validID(value.requestID) &&
          ["legacy", "current", "v2"].includes(String(value.protocol)) &&
          (value.response === "once" || value.response === "exact" || value.response === "scope" || value.response === "reject") && boundedOptionalString(value.scope, 2_000) && boundedOptionalString(value.feedback, 20_000) &&
          (value.response === "scope" ? typeof value.scope === "string" && value.scope.length > 0 : value.scope === undefined) && (value.feedback === undefined || value.response === "reject")
        ? { type: "respondPermission", sessionID: value.sessionID, requestID: value.requestID, protocol: value.protocol as "legacy" | "current" | "v2", response: value.response, scope: value.scope, feedback: value.feedback }
        : undefined
    case "respondQuestion":
      return exactKeys(value, ["type", "sessionID", "requestID", "answers"]) && validID(value.sessionID) && validID(value.requestID) &&
          Array.isArray(value.answers) && value.answers.length <= 20 && value.answers.every((answer) =>
            Array.isArray(answer) && answer.length <= 20 && answer.every((item) => boundedString(item, 20_000))
          )
        ? { type: "respondQuestion", sessionID: value.sessionID, requestID: value.requestID, answers: value.answers }
        : undefined
    case "rejectQuestion":
      return exactKeys(value, ["type", "sessionID", "requestID"]) && validID(value.sessionID) && validID(value.requestID)
        ? { type: "rejectQuestion", sessionID: value.sessionID, requestID: value.requestID }
        : undefined
    case "openFile":
      return exactKeys(value, ["type", "sessionID", "file", "line", "column", "endLine", "endColumn"]) && validID(value.sessionID) && boundedString(value.file, 8_192) && value.file.length > 0 &&
          (value.line === undefined || (Number.isSafeInteger(value.line) && Number(value.line) >= 1 && Number(value.line) <= 1_000_000_000)) &&
          (value.column === undefined || (Number.isSafeInteger(value.column) && Number(value.column) >= 1 && Number(value.column) <= 1_000_000_000)) &&
          (value.endLine === undefined || (Number.isSafeInteger(value.endLine) && Number(value.endLine) >= Number(value.line ?? 1) && Number(value.endLine) <= 1_000_000_000)) &&
          (value.endColumn === undefined || (value.endLine !== undefined && Number.isSafeInteger(value.endColumn) && Number(value.endColumn) >= 1 && Number(value.endColumn) <= 1_000_000_000))
        ? { type: "openFile", sessionID: value.sessionID, file: value.file, line: value.line as number | undefined, column: value.column as number | undefined, endLine: value.endLine as number | undefined, endColumn: value.endColumn as number | undefined }
        : undefined
    case "openPatch":
      return exactKeys(value, ["type", "sessionID", "file"]) && validID(value.sessionID) && boundedString(value.file, 8_192) && value.file.length > 0
        ? { type: "openPatch", sessionID: value.sessionID, file: value.file }
        : undefined
    case "sessionAction":
      return exactKeys(value, ["type", "sessionID", "action", "messageID"]) && validID(value.sessionID) && boundedOptionalString(value.messageID) &&
          (value.messageID === undefined || value.action === "fork" || value.action === "retry") && ["rename", "delete", "fork", "undo", "redo", "retry", "compact", "share", "unshare", "export", "copyLast", "copyTranscript"].includes(String(value.action))
        ? { type: "sessionAction", sessionID: value.sessionID, action: value.action as Extract<WebviewToHostMessage, { type: "sessionAction" }>["action"], messageID: value.messageID }
        : undefined
    case "sessionPresentation":
      return exactKeys(value, ["type", "sessionID", "action"]) && validID(value.sessionID) && ["pin", "unpin", "archive"].includes(String(value.action))
        ? { type: "sessionPresentation", sessionID: value.sessionID, action: value.action as "pin" | "unpin" | "archive" }
        : undefined
    case "ptyAction":
      return exactKeys(value, ["type", "id", "action"]) && validID(value.id) &&
          !/[\u0000-\u001f\u007f]/.test(value.id) && value.action === "cancel"
        ? { type: "ptyAction", id: value.id, action: "cancel" }
        : undefined
    case "jobAction":
      return exactKeys(value, ["type", "sessionID", "action"]) && validID(value.sessionID) && ["open", "background"].includes(String(value.action))
        ? { type: "jobAction", sessionID: value.sessionID, action: value.action as "open" | "background" }
        : undefined
    case "setAutoApproval":
      return exactKeys(value, ["type", "sessionID", "enabled"]) && validID(value.sessionID) && typeof value.enabled === "boolean"
        ? { type: "setAutoApproval", sessionID: value.sessionID, enabled: value.enabled }
        : undefined
    case "goalAction":
      return exactKeys(value, ["type", "sessionID", "action"]) && validID(value.sessionID) &&
          ["edit", "configure", "verify", "pause", "resume", "cancel"].includes(String(value.action))
        ? { type: "goalAction", sessionID: value.sessionID, action: value.action as Extract<WebviewToHostMessage, { type: "goalAction" }>["action"] }
        : undefined
    case "configureGoal":
      return exactKeys(value, ["type", "sessionID", "expectedSettlementGeneration", "configuration"]) && validID(value.sessionID) &&
          (value.expectedSettlementGeneration === undefined || (Number.isSafeInteger(value.expectedSettlementGeneration) && Number(value.expectedSettlementGeneration) >= 0)) && validGoalConfiguration(value.configuration)
        ? { type: "configureGoal", sessionID: value.sessionID, expectedSettlementGeneration: value.expectedSettlementGeneration as number | undefined, configuration: value.configuration }
        : undefined
    case "artifactAction":
      return exactKeys(value, ["type", "sessionID", "artifactID", "action", "expectedRevision", "findingID", "disposition"]) && validID(value.sessionID) && validID(value.artifactID) &&
          ["open", "approve", "handoff", "archive", "delete", "open-finding", "set-finding-disposition", "regenerate"].includes(String(value.action)) &&
          (value.expectedRevision === undefined || (Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 1)) && boundedOptionalString(value.findingID) &&
          (value.disposition === undefined || ["open", "fixed", "dismissed", "accepted-risk"].includes(String(value.disposition))) &&
          (value.action === "open-finding" ? value.findingID !== undefined : true) &&
          (value.action === "set-finding-disposition" ? value.findingID !== undefined && value.disposition !== undefined && value.expectedRevision !== undefined : true)
        ? value as unknown as WebviewToHostMessage
        : undefined
    case "requestRecoveryPreview":
      return exactKeys(value, ["type", "sessionID", "messageID"]) && validID(value.sessionID) && boundedOptionalString(value.messageID)
        ? { type: "requestRecoveryPreview", sessionID: value.sessionID, messageID: value.messageID }
        : undefined
    case "applyRecovery":
      return exactKeys(value, ["type", "sessionID", "mode", "messageID"]) && validID(value.sessionID) && ["revert", "fork", "redo"].includes(String(value.mode)) && boundedOptionalString(value.messageID) &&
          (value.mode === "redo" || value.messageID !== undefined)
        ? { type: "applyRecovery", sessionID: value.sessionID, mode: value.mode as "revert" | "fork" | "redo", messageID: value.messageID }
        : undefined
    case "healthAction":
      return exactKeys(value, ["type", "action"]) && ["refresh", "reconnect", "logs", "trace", "copy"].includes(String(value.action))
        ? { type: "healthAction", action: value.action as "refresh" | "reconnect" | "logs" | "trace" | "copy" }
        : undefined
    case "evidenceAction":
      return exactKeys(value, ["type", "action"]) && value.action === "capture" ? { type: "evidenceAction", action: "capture" } : undefined
    case "workbenchAction":
      return exactKeys(value, ["type", "sessionID", "action"]) && validID(value.sessionID) &&
          ["refresh-session", "review", "walkthrough", "compare-models"].includes(String(value.action))
        ? { type: "workbenchAction", sessionID: value.sessionID, action: value.action as "refresh-session" | "review" | "walkthrough" | "compare-models" }
        : undefined
    case "contextReceiptAction":
      return exactKeys(value, ["type", "sessionID", "receiptID", "itemID", "action"]) && value.action === "open-source" &&
          validID(value.sessionID) && validID(value.receiptID) && validID(value.itemID) &&
          !/[\u0000-\u001f\u007f]/.test(value.sessionID) && !/[\u0000-\u001f\u007f]/.test(value.receiptID) && !/[\u0000-\u001f\u007f]/.test(value.itemID)
        ? { type: "contextReceiptAction", sessionID: value.sessionID, receiptID: value.receiptID, itemID: value.itemID, action: "open-source" }
        : undefined
    case "browserContextAction":
      if (!exactKeys(value, ["type", "sessionID", "action", "task", "sources", "approvedUrl"]) || !validID(value.sessionID) || /[\u0000-\u001f\u007f]/.test(value.sessionID) || value.action !== "capture") return undefined
      if (value.task === undefined && value.sources === undefined && value.approvedUrl === undefined) return { type: "browserContextAction", sessionID: value.sessionID, action: "capture" }
      if (!boundedString(value.task, 20_000) || !value.task.trim() || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 8) return undefined
      {
        const allowed = new Set(["selection", "console", "element", "terminal-task", "diagnostics", "debug", "url", "screenshot"])
        if (!value.sources.every((source) => typeof source === "string" && allowed.has(source)) || new Set(value.sources).size !== value.sources.length) return undefined
        if (value.sources.filter((source) => ["console", "element", "terminal-task"].includes(String(source))).length > 1) return undefined
        if ((value.sources.includes("url") && (!boundedString(value.approvedUrl, 8_192) || !value.approvedUrl.trim())) || (!value.sources.includes("url") && value.approvedUrl !== undefined)) return undefined
        return { type: "browserContextAction", sessionID: value.sessionID, action: "capture", task: value.task, sources: value.sources as Array<"selection" | "console" | "element" | "terminal-task" | "diagnostics" | "debug" | "url" | "screenshot">, approvedUrl: typeof value.approvedUrl === "string" ? value.approvedUrl : undefined }
      }
    case "runAction": {
      if (!validID(value.groupID)) return undefined
      if (["refresh", "compare", "fuse"].includes(String(value.action))) {
        return exactKeys(value, ["type", "groupID", "action"])
          ? { type: "runAction", groupID: value.groupID, action: value.action as "refresh" | "compare" | "fuse" }
          : undefined
      }
      if (value.action === "export-comparison") {
        return exactKeys(value, ["type", "groupID", "action", "comparisonArtifactID", "comparisonRevision"]) && validID(value.comparisonArtifactID) &&
            Number.isSafeInteger(value.comparisonRevision) && Number(value.comparisonRevision) > 0
          ? { type: "runAction", groupID: value.groupID, action: "export-comparison", comparisonArtifactID: value.comparisonArtifactID, comparisonRevision: Number(value.comparisonRevision) }
          : undefined
      }
      return exactKeys(value, ["type", "groupID", "runID", "action"]) && validID(value.runID) &&
          ["open", "cancel", "retry", "diff", "review", "keep", "discard"].includes(String(value.action))
        ? { type: "runAction", groupID: value.groupID, runID: value.runID, action: value.action as "open" | "cancel" | "retry" | "diff" | "review" | "keep" | "discard" }
        : undefined
    }
    case "walkthroughAction":
      return exactKeys(value, ["type", "documentID", "stopID"]) && validID(value.documentID) && validID(value.stopID)
        ? { type: "walkthroughAction", documentID: value.documentID, stopID: value.stopID }
        : undefined
    case "selectSession":
      return typeof value.sessionID === "string" && value.sessionID.length > 0 && value.sessionID.length <= 1_024
        ? { type: "selectSession", sessionID: value.sessionID }
        : undefined
    case "openLink":
      return typeof value.url === "string" && value.url.length <= 8_192 ? { type: "openLink", url: value.url } : undefined
    case "copyText":
      return exactKeys(value, ["type", "text"]) && boundedString(value.text, 500_000) ? { type: "copyText", text: value.text } : undefined
    default:
      return undefined
  }
}

function validStatus(value: unknown): value is SessionStatus {
  if (!record(value) || !["idle", "busy", "retry", "error"].includes(String(value.type))) return false
  return boundedOptionalString(value.message, 20_000) &&
    (value.attempt === undefined || typeof value.attempt === "number") &&
    (value.next === undefined || typeof value.next === "number")
}

function validAgent(value: unknown): boolean {
  return record(value) && validID(value.name) && boundedOptionalString(value.description, 20_000) &&
    (value.model === undefined || (record(value.model) && exactKeys(value.model, ["providerID", "modelID"]) &&
      validID(value.model.providerID) && validID(value.model.modelID))) && boundedOptionalString(value.variant) &&
    (value.mode === undefined || ["primary", "subagent", "all"].includes(String(value.mode)))
}

function validModalities(value: unknown): boolean {
  return record(value) && exactKeys(value, ["text", "audio", "image", "video", "pdf"]) &&
    [value.text, value.audio, value.image, value.video, value.pdf].every((item) => item === undefined || typeof item === "boolean")
}

function validCapabilities(value: unknown): boolean {
  return record(value) && exactKeys(value, ["temperature", "reasoning", "attachment", "toolcall", "input", "output", "interleaved"]) &&
    [value.temperature, value.reasoning, value.attachment, value.toolcall].every((item) => item === undefined || typeof item === "boolean") &&
    (value.input === undefined || validModalities(value.input)) && (value.output === undefined || validModalities(value.output)) &&
    (value.interleaved === undefined || typeof value.interleaved === "boolean" ||
      (record(value.interleaved) && exactKeys(value.interleaved, ["field"]) && boundedOptionalString(value.interleaved.field, 100)))
}

function validModel(value: unknown): boolean {
  return record(value) && validID(value.id) && boundedString(value.name, 2_000) && validID(value.providerID) &&
    (value.contextLimit === undefined || (Number.isSafeInteger(value.contextLimit) && Number(value.contextLimit) > 0)) &&
    (value.inputLimit === undefined || (Number.isSafeInteger(value.inputLimit) && Number(value.inputLimit) > 0)) &&
    (value.outputLimit === undefined || (Number.isSafeInteger(value.outputLimit) && Number(value.outputLimit) > 0)) &&
    boundedOptionalString(value.status, 100) && boundedOptionalString(value.releaseDate, 100) &&
    (value.capabilities === undefined || validCapabilities(value.capabilities)) &&
    (value.variants === undefined || (Array.isArray(value.variants) && value.variants.length <= 100 && value.variants.every((variant) => validID(variant))))
}

function validProvider(value: unknown): boolean {
  return record(value) && exactKeys(value, ["id", "name", "source"]) && validID(value.id) && boundedString(value.name, 2_000) &&
    (value.source === undefined || ["env", "config", "custom", "api"].includes(String(value.source)))
}

function validResource(value: unknown): boolean {
  return record(value) && exactKeys(value, ["name", "uri", "description", "mimeType", "client"]) && boundedString(value.name, 2_000) && validID(value.uri) &&
    boundedOptionalString(value.description, 20_000) && boundedOptionalString(value.mimeType, 100) && boundedString(value.client, 2_000)
}

function validCommand(value: unknown): boolean {
  return record(value) && exactKeys(value, ["name", "description", "source", "hints"]) && validID(value.name) &&
    boundedOptionalString(value.description, 20_000) && (value.source === undefined || ["command", "mcp", "skill"].includes(String(value.source))) &&
    (value.hints === undefined || (Array.isArray(value.hints) && value.hints.length <= 100 && value.hints.every((hint) => boundedString(hint, 2_000))))
}

function validCatalog(value: unknown[], validator: (entry: unknown) => boolean): boolean {
  if (!value.every(validator)) return false
  return value.reduce<number>((characters, entry) => {
     const item = entry as { id?: string; name?: string; providerID?: string; description?: string; uri?: string; client?: string; status?: string; releaseDate?: string; variants?: string[] }
     return characters + (item.id?.length ?? 0) + (item.name?.length ?? 0) +
       (item.providerID?.length ?? 0) + (item.description?.length ?? 0) + (item.uri?.length ?? 0) + (item.client?.length ?? 0) +
       (item.status?.length ?? 0) + (item.releaseDate?.length ?? 0) + (item.variants?.reduce((total, variant) => total + variant.length, 0) ?? 0)
  }, 0) <= 2_000_000
}

function validSessionOption(value: unknown): boolean {
  return record(value) && boundedString(value.id) && boundedString(value.title, 2_000) &&
    validStatus(value.status) && Number.isSafeInteger(value.unread) && Number(value.unread) >= 0 && Number(value.unread) <= 1_000_000 &&
    boundedOptionalString(value.directory, 8_192) && boundedOptionalString(value.parentID) &&
    (value.updatedAt === undefined || (Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= 0)) &&
    [value.attention, value.questionCount, value.permissionCount, value.queued, value.changeCount].every((count) => count === undefined || (Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000_000)) &&
    (value.todo === undefined || (record(value.todo) && Number.isSafeInteger(value.todo.completed) && Number(value.todo.completed) >= 0 &&
      Number.isSafeInteger(value.todo.total) && Number(value.todo.total) >= Number(value.todo.completed) && Number(value.todo.total) <= 10_000)) &&
    [value.pinned, value.archived, value.shared].every((flag) => flag === undefined || typeof flag === "boolean") &&
    boundedOptionalString(value.shareUrl, 8_192) && boundedOptionalString(value.model) && boundedOptionalString(value.agent) &&
    (value.tokens === undefined || (Number.isSafeInteger(value.tokens) && Number(value.tokens) >= 0)) && boundedOptionalString(value.branch, 2_000) && boundedOptionalString(value.worktree, 8_192) &&
    (value.cost === undefined || (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0)) &&
    (value.summary === undefined || (record(value.summary) && exactKeys(value.summary, ["additions", "deletions", "files"]) && [value.summary.additions, value.summary.deletions, value.summary.files]
      .every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) <= 1_000_000_000))) &&
    boundedOptionalString(value.rootID) && (value.depth === undefined || (Number.isSafeInteger(value.depth) && Number(value.depth) >= 0 && Number(value.depth) <= 100))
}

function validSessionOptions(value: unknown[]): boolean {
  if (value.length > 5_000 || !value.every(validSessionOption)) return false
  return value.reduce<number>((characters, session) => {
    const option = session as { id: string; title: string; directory?: string; parentID?: string; status: { message?: string } }
    return characters + option.id.length + option.title.length + (option.directory?.length ?? 0) + (option.parentID?.length ?? 0) +
      (option.status.message?.length ?? 0)
  }, 0) <= 2_000_000
}

function validLineage(value: unknown): value is SessionLineageNode[] {
  if (!Array.isArray(value) || value.length > 5_000) return false
  const ids = new Set<string>()
  let characters = 0
  return value.every((node) => {
    if (!record(node) || !exactKeys(node, [
      "sessionID", "parentID", "rootID", "depth", "relation", "title", "status", "updatedAt", "directory", "model", "agent", "tokens", "cost",
      "attention", "questionCount", "permissionCount", "archived", "shared", "branch", "worktree", "runGroupID", "runID", "worktreeID",
    ]) || !validID(node.sessionID) || ids.has(node.sessionID) || !boundedOptionalString(node.parentID) || !validID(node.rootID) ||
      !Number.isSafeInteger(node.depth) || Number(node.depth) < 0 || Number(node.depth) > 100 ||
      !["root", "child", "run", "fusion", "recovery"].includes(String(node.relation)) || !boundedString(node.title, 2_000) || !validStatus(node.status) ||
      !Number.isSafeInteger(node.updatedAt) || Number(node.updatedAt) < 0 || !boundedOptionalString(node.directory, 8_192) ||
      !boundedOptionalString(node.model) || !boundedOptionalString(node.agent) ||
      (node.tokens !== undefined && (!Number.isSafeInteger(node.tokens) || Number(node.tokens) < 0)) ||
      (node.cost !== undefined && (typeof node.cost !== "number" || !Number.isFinite(node.cost) || node.cost < 0)) ||
      ![node.attention, node.questionCount, node.permissionCount].every((count) => count === undefined || (Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000_000)) ||
      ![node.archived, node.shared].every((flag) => flag === undefined || typeof flag === "boolean") ||
      !boundedOptionalString(node.branch, 2_000) || !boundedOptionalString(node.worktree, 8_192) || !boundedOptionalString(node.runGroupID) ||
      !boundedOptionalString(node.runID) || !boundedOptionalString(node.worktreeID)) return false
    ids.add(node.sessionID)
    const status: unknown = node.status
    const statusMessage = record(status) && typeof status.message === "string" ? status.message : ""
    characters += node.sessionID.length + (node.parentID?.length ?? 0) + node.rootID.length + node.title.length +
      statusMessage.length +
      (node.directory?.length ?? 0) + (node.model?.length ?? 0) + (node.agent?.length ?? 0) +
      (node.branch?.length ?? 0) + (node.worktree?.length ?? 0) + (node.runGroupID?.length ?? 0) + (node.runID?.length ?? 0) + (node.worktreeID?.length ?? 0)
    return characters <= 2_000_000
  })
}

function validReviewFindingSnapshots(value: unknown, sessionID: string): value is ReviewFindingSnapshot[] {
  if (!Array.isArray(value) || value.length > 200) return false
  const ids = new Set<string>()
  let characters = 0
  return value.every((entry) => {
    if (!record(entry) || !exactKeys(entry, [
      "sessionID", "artifactID", "artifactRevision", "artifactUpdatedAt", "stale", "diffHash", "findingID", "title", "detail", "category", "severity", "anchors", "disposition",
    ]) || entry.sessionID !== sessionID || !validID(entry.artifactID) || !Number.isSafeInteger(entry.artifactRevision) || Number(entry.artifactRevision) < 1 ||
      !Number.isSafeInteger(entry.artifactUpdatedAt) || Number(entry.artifactUpdatedAt) < 0 || typeof entry.stale !== "boolean" ||
      typeof entry.diffHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.diffHash) || !validID(entry.findingID) ||
      !boundedString(entry.title, 500) || !boundedString(entry.detail, 10_000) ||
      !["correctness", "security", "performance", "maintainability", "tests", "regression"].includes(String(entry.category)) ||
      !["critical", "high", "medium", "low"].includes(String(entry.severity)) ||
      !["open", "fixed", "dismissed", "accepted-risk"].includes(String(entry.disposition)) || !Array.isArray(entry.anchors) ||
      entry.anchors.length < 1 || entry.anchors.length > 20) return false
    const key = `${entry.artifactID}\0${entry.findingID}`
    if (ids.has(key)) return false
    ids.add(key)
    characters += entry.sessionID.length + entry.artifactID.length + entry.diffHash.length + entry.findingID.length + entry.title.length + entry.detail.length
    for (const anchor of entry.anchors) {
      if (!record(anchor) || !exactKeys(anchor, ["file", "side", "startLine", "endLine", "hunkHeader"]) || !boundedString(anchor.file, 8_192) || !anchor.file ||
        !["base", "modified"].includes(String(anchor.side)) || !Number.isSafeInteger(anchor.startLine) || Number(anchor.startLine) < 1 ||
        !Number.isSafeInteger(anchor.endLine) || Number(anchor.endLine) < Number(anchor.startLine) || !boundedOptionalString(anchor.hunkHeader, 2_000)) return false
      characters += anchor.file.length + (anchor.hunkHeader?.length ?? 0)
    }
    return characters <= 2_000_000
  })
}

function validMessage(value: unknown): boolean {
  if (!record(value) || !record(value.info) || !Array.isArray(value.parts) || value.parts.length > 2_000) return false
  const info = value.info
  if (!boundedString(info.id) || !boundedString(info.sessionID) || (info.role !== "user" && info.role !== "assistant")) return false
  return value.parts.every((part) =>
    record(part) &&
    boundedString(part.id) &&
    boundedString(part.sessionID) &&
    boundedString(part.messageID) &&
    boundedString(part.type, 100) &&
    boundedOptionalString(part.text, 500_000) &&
    boundedOptionalString(part.mime, 100) &&
    boundedOptionalString(part.filename, 255) &&
    (part.synthetic === undefined || typeof part.synthetic === "boolean") &&
    (part.metadata === undefined || validJson(part.metadata)) &&
    boundedOptionalString(part.tool, 1_024) &&
    (part.state === undefined || (record(part.state) &&
      boundedOptionalString(part.state.status, 100) &&
      boundedOptionalString(part.state.title, 2_000) &&
      boundedOptionalString(part.state.output, 500_000) &&
      boundedOptionalString(part.state.error, 500_000) &&
      (part.state.input === undefined || validJson(part.state.input)) &&
      (part.state.metadata === undefined || validJson(part.state.metadata)))),
  )
}

function validMessages(value: unknown[]): boolean {
  if (value.length > 5_000 || !value.every(validMessage)) return false
  let parts = 0
  let characters = 0
  for (const message of value) {
    const bundle = message as { parts: Array<{ text?: string; mime?: string; filename?: string; metadata?: unknown; state?: { title?: string; output?: string; error?: string; input?: unknown; metadata?: unknown } }> }
    parts += bundle.parts.length
    for (const part of bundle.parts) {
      characters += (part.text?.length ?? 0) + (part.state?.title?.length ?? 0) +
        (part.mime?.length ?? 0) + (part.filename?.length ?? 0) +
        (part.metadata === undefined ? 0 : jsonCharacters(part.metadata)) +
        (part.state?.output?.length ?? 0) + (part.state?.error?.length ?? 0) +
        (part.state?.input === undefined ? 0 : jsonCharacters(part.state.input)) +
        (part.state?.metadata === undefined ? 0 : jsonCharacters(part.state.metadata))
    }
    if (parts > 40_000 || characters > 8_000_000) return false
  }
  return true
}

function jsonCharacters(value: unknown, depth = 0): number {
  if (depth > 8 || value === null || typeof value === "boolean" || typeof value === "number") return 0
  if (typeof value === "string") return value.length
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + jsonCharacters(entry, depth + 1), 0)
  }
  if (record(value)) {
    return Object.entries(value).reduce((total, [key, entry]) => total + key.length + jsonCharacters(entry, depth + 1), 0)
  }
  return 0
}

function validDelegations(value: unknown): value is DelegationProgress[] {
  if (!Array.isArray(value) || value.length > 20) return false
  let characters = 0
  let parts = 0
  return value.every((delegation) => {
    if (!record(delegation) || !exactKeys(delegation, ["partID", "sessionID", "title", "status", "messages", "revision"]) ||
      !validID(delegation.partID) || !validID(delegation.sessionID) || !boundedString(delegation.title, 2_000) ||
      !validStatus(delegation.status) || !Array.isArray(delegation.messages) || !validMessages(delegation.messages) ||
      !Number.isSafeInteger(delegation.revision) || Number(delegation.revision) < 0) return false
    for (const message of delegation.messages as MessageBundle[]) {
      parts += message.parts.length
      for (const part of message.parts) {
        characters += (part.text?.length ?? 0) + (part.state?.title?.length ?? 0) +
        (part.state?.output?.length ?? 0) + (part.state?.error?.length ?? 0)
      }
    }
    return parts <= 10_000 && characters <= 2_000_000
  })
}

function validMessageRevisions(value: unknown, messages: unknown[]): boolean {
  if (!record(value)) return false
  const entries = Object.entries(value)
  const messageIDs = new Set(messages.flatMap((message) => record(message) && record(message.info) && typeof message.info.id === "string" ? [message.info.id] : []))
  if (entries.length > messages.length) return false
  return entries.every(([messageID, revision]) => messageIDs.has(messageID) && messageID.length <= 1_024 && Number.isInteger(revision) && Number(revision) >= 0)
}

function validTranscriptHistory(value: unknown): value is TranscriptHistoryState {
  if (!record(value) || !exactKeys(value, ["totalMessages", "visibleMessages", "hasOlder", "limitedBy", "sourceMayBeTruncated"])) return false
  return Number.isSafeInteger(value.totalMessages) && Number(value.totalMessages) >= 0 && Number(value.totalMessages) <= 1_000_000 &&
    Number.isSafeInteger(value.visibleMessages) && Number(value.visibleMessages) >= 0 && Number(value.visibleMessages) <= Number(value.totalMessages) &&
    typeof value.hasOlder === "boolean" && (value.limitedBy === undefined || ["messages", "parts", "characters"].includes(String(value.limitedBy))) &&
    (value.sourceMayBeTruncated === undefined || typeof value.sourceMayBeTruncated === "boolean")
}

function validTranscriptHistoryPage(value: unknown): value is TranscriptHistoryPage {
  if (!record(value) || !exactKeys(value, ["sessionID", "messages", "messageRevisions", "hasOlder", "totalMessages", "sourceMayBeTruncated"]) ||
    !validID(value.sessionID) || !Array.isArray(value.messages) || value.messages.length > 1_000 || !validMessages(value.messages) ||
    !validMessageRevisions(value.messageRevisions, value.messages) || typeof value.hasOlder !== "boolean" ||
    !Number.isSafeInteger(value.totalMessages) || Number(value.totalMessages) < value.messages.length || Number(value.totalMessages) > 1_000_000 ||
    (value.sourceMayBeTruncated !== undefined && typeof value.sourceMayBeTruncated !== "boolean")) return false
  return value.messages.every((message) => (message as MessageBundle).info.sessionID === value.sessionID)
}

function validJson(
  value: unknown,
  depth = 0,
  budget = { nodes: 0, characters: 0 },
  characterLimit = PERMISSION_METADATA_CHARACTER_LIMIT,
): boolean {
  budget.nodes += 1
  if (budget.nodes > 1_000 || depth > 8) return false
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string") {
    budget.characters += value.length
    return budget.characters <= characterLimit
  }
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((entry) => validJson(entry, depth + 1, budget, characterLimit))
  }
  if (!record(value) || Object.keys(value).length > 100) return false
  return Object.entries(value).every(([key, entry]) => {
    budget.characters += key.length
    return key.length <= 1_024 && budget.characters <= characterLimit && validJson(entry, depth + 1, budget, characterLimit)
  })
}

function validQueue(value: unknown): value is QueuedPrompt[] {
  if (!Array.isArray(value) || value.length > PROMPT_QUEUE_COUNT_LIMIT) {
    return false
  }
  const ids = new Set<string>()
  let characters = 0
  return value.every((prompt) => {
    if (!record(prompt) || !exactKeys(prompt, ["id", "text", "delivery", "agent", "model", "variant", "attachments", "createdAt"]) || !validID(prompt.id) || ids.has(prompt.id) ||
      !boundedString(prompt.text, PROMPT_TEXT_CHARACTER_LIMIT) || (!prompt.text.trim() && (!Array.isArray(prompt.attachments) || prompt.attachments.length === 0)) || !boundedOptionalString(prompt.agent) ||
      !boundedOptionalString(prompt.model) || !boundedOptionalString(prompt.variant) ||
      (prompt.delivery !== undefined && !["follow-up", "steer", "replace"].includes(String(prompt.delivery))) ||
      !Number.isSafeInteger(prompt.createdAt) || Number(prompt.createdAt) < 0) return false
    if (prompt.attachments !== undefined && (!Array.isArray(prompt.attachments) || prompt.attachments.length > 20 || prompt.attachments.some((attachment) =>
      !record(attachment) || !exactKeys(attachment, ["name", "mime"]) || !boundedString(attachment.name, 255) || !boundedString(attachment.mime, 100)))) return false
    ids.add(prompt.id)
    characters += prompt.id.length + prompt.text.length + (prompt.agent?.length ?? 0) + (prompt.model?.length ?? 0) + (prompt.variant?.length ?? 0)
    return characters <= PROMPT_QUEUE_CHARACTER_LIMIT
  })
}

function validContextReceipts(value: unknown): value is ContextReceipt[] {
  if (!Array.isArray(value) || value.length > 2_000) return false
  return value.every((receipt) => record(receipt) && boundedString(receipt.id) && boundedString(receipt.sessionID) && boundedString(receipt.promptID) &&
    Number.isSafeInteger(receipt.admittedAt) && Number(receipt.admittedAt) >= 0 && ["none", "explicit", "unknown"].includes(String(receipt.truncation)) &&
    (receipt.estimatedTokens === undefined || (Number.isSafeInteger(receipt.estimatedTokens) && Number(receipt.estimatedTokens) >= 0)) &&
    Array.isArray(receipt.items) && receipt.items.length <= 100 && receipt.items.every((item) => record(item) && boundedString(item.id) && boundedString(item.kind, 64) && boundedString(item.label) &&
      (item.uri === undefined || boundedString(item.uri, 4_096)) && (item.revision === undefined || boundedString(item.revision, 256)) &&
      (item.contentHash === undefined || boundedString(item.contentHash, 256)) && (item.bytes === undefined || (Number.isSafeInteger(item.bytes) && Number(item.bytes) >= 0)) &&
      (item.estimatedTokens === undefined || (Number.isSafeInteger(item.estimatedTokens) && Number(item.estimatedTokens) >= 0)) && (item.truncated === undefined || typeof item.truncated === "boolean")))
}

function validAttentionItems(value: unknown): value is AttentionItem[] {
  if (!Array.isArray(value) || value.length > 500) return false
  return value.every((item) => record(item) && boundedString(item.id) && boundedString(item.kind, 64) && boundedOptionalString(item.sessionID) &&
    boundedString(item.title, 1_024) && boundedOptionalString(item.detail, 2_000) && Number.isSafeInteger(item.createdAt) && Number(item.createdAt) >= 0 &&
    record(item.target) && ["conversation", "goal", "runs", "health"].includes(String(item.target.surface)) && boundedOptionalString(item.target.itemID))
}

const TASK_ARTIFACT_STATES: Readonly<Record<TaskArtifactSummary["kind"], ReadonlySet<string>>> = {
  plan: new Set(["generating", "ready", "approved", "handed-off", "failed", "unavailable"]),
  review: new Set(["ready", "stale"]),
  "goal-verification": new Set(["pending", "continue", "complete", "blocked", "needs-user", "applied", "stale"]),
  "run-comparison": new Set(["complete", "incomplete"]),
  "context-capture": new Set(["complete", "limited"]),
}
const TASK_ARTIFACT_ITEM_LIMITS: Readonly<Record<TaskArtifactSummary["kind"], number>> = { plan: 100, review: 100, "goal-verification": 500, "run-comparison": 5, "context-capture": 100 }
const EVIDENCE_KINDS = new Set<EvidenceReference["kind"]>(["task", "terminal", "test", "diagnostics", "diff", "todo", "criterion"])
const EVIDENCE_STATUSES = new Set<EvidenceReference["status"]>(["passed", "failed", "warning", "unknown"])

function validDurableMetadataString(value: unknown, limit: number, label: string): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) return false
  try {
    return sanitizeDurableMetadataText(value, limit, label) === value
  } catch {
    return false
  }
}

function validTaskArtifactSummaries(value: unknown, selectedSessionID: string): value is TaskArtifactSummary[] {
  if (!Array.isArray(value) || value.length > 500) return false
  const ids = new Set<string>()
  let characters = 0
  return value.every((summary) => {
    if (!record(summary) || !exactKeys(summary, ["schemaVersion", "id", "kind", "sessionID", "lifecycle", "revision", "createdAt", "updatedAt", "state", "itemCount", "stale"]) ||
      summary.schemaVersion !== 1 || !validDurableMetadataString(summary.id, 1_024, "Task artifact ID") || ids.has(summary.id) ||
      !validDurableMetadataString(summary.sessionID, 1_024, "Task artifact session ID") || summary.sessionID !== selectedSessionID ||
      !Object.hasOwn(TASK_ARTIFACT_STATES, String(summary.kind)) || !["active", "archived"].includes(String(summary.lifecycle)) ||
      !Number.isSafeInteger(summary.revision) || Number(summary.revision) < 1 || !Number.isSafeInteger(summary.createdAt) || Number(summary.createdAt) < 0 ||
      !Number.isSafeInteger(summary.updatedAt) || Number(summary.updatedAt) < Number(summary.createdAt)) return false
    const kind = summary.kind as TaskArtifactSummary["kind"]
    if (!TASK_ARTIFACT_STATES[kind].has(String(summary.state)) || (summary.itemCount !== undefined && (!Number.isSafeInteger(summary.itemCount) ||
      Number(summary.itemCount) < 0 || Number(summary.itemCount) > TASK_ARTIFACT_ITEM_LIMITS[kind])) ||
      (summary.stale !== undefined && typeof summary.stale !== "boolean") || (!["review", "goal-verification"].includes(kind) && summary.stale !== undefined) ||
      ((summary.state === "stale") !== (summary.stale === true))) return false
    ids.add(summary.id)
    characters += summary.id.length + summary.sessionID.length +
      String(summary.state).length
    return characters <= 1_100_000
  })
}

function validEvidenceReferences(value: unknown, selectedSessionID: string): value is EvidenceReference[] {
  if (!Array.isArray(value) || value.length > 2_000) return false
  const ids = new Set<string>()
  let characters = 0
  return value.every((evidence) => {
    if (!record(evidence) || !exactKeys(evidence, ["id", "kind", "label", "status", "observedAt", "sourceID", "sessionID", "runGroupID", "runID", "repository", "summary"]) ||
      !validDurableMetadataString(evidence.id, 1_024, "Evidence ID") || ids.has(evidence.id) || !EVIDENCE_KINDS.has(evidence.kind as EvidenceReference["kind"]) ||
      !validDurableMetadataString(evidence.label, 1_024, "Evidence label") || !EVIDENCE_STATUSES.has(evidence.status as EvidenceReference["status"]) ||
      !Number.isSafeInteger(evidence.observedAt) || Number(evidence.observedAt) < 0 || !validDurableMetadataString(evidence.sessionID, 1_024, "Evidence session ID") ||
      evidence.sessionID !== selectedSessionID || !validDurableMetadataString(evidence.summary, 4_000, "Evidence summary")) return false
    for (const [candidate, limit, label] of [[evidence.sourceID, 1_024, "Evidence source ID"], [evidence.runGroupID, 1_024, "Evidence run-group ID"], [evidence.runID, 1_024, "Evidence run ID"], [evidence.repository, 8_192, "Evidence repository"]] as const) {
      if (candidate !== undefined && !validDurableMetadataString(candidate, limit, label)) return false
    }
    ids.add(evidence.id)
    characters += evidence.id.length + evidence.label.length +
      evidence.sessionID.length + evidence.summary.length +
      (typeof evidence.sourceID === "string" ? evidence.sourceID.length : 0) +
      (typeof evidence.runGroupID === "string"
        ? evidence.runGroupID.length
        : 0) +
      (typeof evidence.runID === "string" ? evidence.runID.length : 0) +
      (typeof evidence.repository === "string"
        ? evidence.repository.length
        : 0)
    return characters <= 32_000_000
  })
}

function validRunComparisonRow(value: unknown): value is RunComparisonRow {
  if (!record(value) || !exactKeys(value, ["runID", "status", "model", "agent", "variant", "elapsedMilliseconds", "changedFiles", "additions", "deletions", "taskOutcomes", "diagnostics", "verifierState", "tokens", "cost", "blocker", "complete", "limitation"]) ||
    !validDurableMetadataString(value.runID, 1_024, "Run comparison run ID") || !["pending", "preparing", "admitting", "working", "needs-input", "completed", "failed", "cancelled"].includes(String(value.status)) ||
    !validDurableMetadataString(value.model, 1_024, "Run comparison model") || !["not-recorded", "passed", "failed", "mixed"].includes(String(value.taskOutcomes)) ||
    !["not-recorded", "clean", "has-errors"].includes(String(value.diagnostics)) || typeof value.complete !== "boolean") return false
  for (const [candidate, limit, label] of [[value.agent, 1_024, "Run comparison agent"], [value.variant, 1_024, "Run comparison variant"], [value.verifierState, 2_000, "Run comparison verifier state"], [value.blocker, 4_000, "Run comparison blocker"], [value.limitation, 4_000, "Run comparison limitation"]] as const) {
    if (candidate !== undefined && !validDurableMetadataString(candidate, limit, label)) return false
  }
  for (const candidate of [value.elapsedMilliseconds, value.tokens]) {
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || Number(candidate) < 0)) return false
  }
  for (const candidate of [value.changedFiles, value.additions, value.deletions]) {
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) return false
  }
  return value.cost === undefined || (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 && value.cost <= 1_000_000_000_000)
}

function validRunComparisonSnapshots(value: unknown): value is RunComparisonSnapshot[] {
  if (!Array.isArray(value) || value.length > 20) return false
  const artifactIDs = new Set<string>()
  return value.every((comparison) => {
    if (!record(comparison) || !exactKeys(comparison, ["artifactID", "revision", "groupID", "rows", "updatedAt", "stale"]) ||
      !validDurableMetadataString(comparison.artifactID, 1_024, "Run comparison artifact ID") || artifactIDs.has(comparison.artifactID) ||
      !Number.isSafeInteger(comparison.revision) || Number(comparison.revision) < 1 || !validDurableMetadataString(comparison.groupID, 1_024, "Run comparison group ID") ||
      !Number.isSafeInteger(comparison.updatedAt) || Number(comparison.updatedAt) < 0 || !Array.isArray(comparison.rows) || comparison.rows.length > 100 ||
      !comparison.rows.every(validRunComparisonRow) || (comparison.stale !== undefined && typeof comparison.stale !== "boolean")) return false
    const runIDs = comparison.rows.map((row) => row.runID)
    if (new Set(runIDs).size !== runIDs.length) return false
    artifactIDs.add(comparison.artifactID)
    return true
  })
}

function validRunGroups(value: unknown): value is RunGroup[] {
  if (!Array.isArray(value) || value.length > 500) return false
  return value.every((group) => record(group) && boundedString(group.id) && boundedOptionalString(group.ownerSessionID) && boundedString(group.title, 500) && boundedString(group.repository, 8_192) && boundedString(group.baseRef) && boundedString(group.promptReceiptID) &&
    ["shared", "worktree"].includes(String(group.isolation)) && Number.isSafeInteger(group.createdAt) && Number(group.createdAt) >= 0 && Array.isArray(group.runs) && group.runs.length <= 100 &&
    group.runs.every((run) => record(run) && boundedString(run.id) && boundedString(run.model) && boundedOptionalString(run.agent) && boundedOptionalString(run.variant) && (run.retained === undefined || typeof run.retained === "boolean") && (run.discarded === undefined || typeof run.discarded === "boolean") && ["pending", "preparing", "admitting", "working", "needs-input", "completed", "failed", "cancelled"].includes(String(run.phase)) && record(run.session) && boundedString(run.session.sessionID) && boundedString(run.session.directory, 8_192)))
}

function validWorktrees(value: unknown): value is WorktreeJournalEntry[] {
  const phases = ["requested", "creating", "ready", "setup-running", "session-creating", "session-ready", "prompt-admitting", "prompt-admitted", "failed", "cleanup-pending", "retained-dirty", "removed"]
  return Array.isArray(value) && value.length <= 1_000 && value.every((entry) => record(entry) &&
    exactKeys(entry, ["id", "mutationID", "owner", "repository", "repositoryID", "path", "branch", "baseRef", "phase", "sessionID", "promptID", "createdAt", "updatedAt", "error"]) &&
    validID(entry.id) && boundedString(entry.mutationID) && ["native-agent-host", "workbench"].includes(String(entry.owner)) &&
    boundedString(entry.repository, 8_192) && boundedString(entry.repositoryID) && boundedString(entry.path, 8_192) && boundedString(entry.branch, 1_024) &&
    boundedString(entry.baseRef) && phases.includes(String(entry.phase)) && boundedOptionalString(entry.sessionID) && boundedOptionalString(entry.promptID) &&
    Number.isSafeInteger(entry.createdAt) && Number(entry.createdAt) >= 0 && Number.isSafeInteger(entry.updatedAt) && Number(entry.updatedAt) >= 0 &&
    (entry.error === undefined || (record(entry.error) && exactKeys(entry.error, ["code", "message", "retryable"]) && boundedString(entry.error.code, 256) && boundedString(entry.error.message, 2_000) && typeof entry.error.retryable === "boolean")))
}

function validWalkthroughs(value: unknown): value is WalkthroughDocument[] {
  if (!Array.isArray(value) || value.length > 100) return false
  return value.every((document) => record(document) && exactKeys(document, ["id", "diffHash", "model", "promptVersion", "language", "generatedAt", "stops", "coverage", "uncoveredFiles"]) && validID(document.id) && boundedString(document.diffHash, 256) && boundedString(document.model) && boundedString(document.promptVersion, 100) && boundedString(document.language, 100) && Number.isSafeInteger(document.generatedAt) && Number(document.generatedAt) >= 0 && ["complete", "partial"].includes(String(document.coverage)) &&
    (document.uncoveredFiles === undefined || (Array.isArray(document.uncoveredFiles) && document.uncoveredFiles.length <= 500 && document.uncoveredFiles.every((file) => boundedString(file, 8_192)))) && Array.isArray(document.stops) && document.stops.length <= 500 && document.stops.every((stop) => record(stop) && exactKeys(stop, ["id", "title", "explanation", "importance", "anchors"]) && validID(stop.id) && boundedString(stop.title, 2_000) && boundedString(stop.explanation, 20_000) && ["key-change", "normal", "context"].includes(String(stop.importance)) && Array.isArray(stop.anchors) && stop.anchors.length > 0 && stop.anchors.length <= 100 && stop.anchors.every((anchor) => record(anchor) && exactKeys(anchor, ["file", "side", "startLine", "endLine", "hunkHeader"]) && boundedString(anchor.file, 8_192) && ["base", "modified"].includes(String(anchor.side)) && Number.isSafeInteger(anchor.startLine) && Number(anchor.startLine) >= 1 && Number.isSafeInteger(anchor.endLine) && Number(anchor.endLine) >= Number(anchor.startLine) && boundedOptionalString(anchor.hunkHeader, 2_000))))
}

const SNAPSHOT_OMISSION_KEYS = [
  "sessions",
  "lineage",
  "messages",
  "delegations",
  "queuedPrompts",
  "permissions",
  "questions",
  "todos",
  "changes",
  "contextReceipts",
  "catalogItems",
  "runtimeServices",
  "ptys",
  "attentionItems",
  "runGroups",
  "worktrees",
  "walkthroughs",
  "walkthroughStops",
  "taskArtifacts",
  "reviewFindings",
  "evidence",
  "runComparisons",
] as const

function validSnapshotProjection(value: unknown): value is ChatSnapshotProjection {
  if (!record(value) || !exactKeys(value, ["truncated", "limitBytes", "encodedBytes", "omitted", "message"]) || value.truncated !== true ||
    !Number.isSafeInteger(value.limitBytes) || Number(value.limitBytes) < 1 || Number(value.limitBytes) > 33_554_432 ||
    !Number.isSafeInteger(value.encodedBytes) || Number(value.encodedBytes) < 1 || Number(value.encodedBytes) > Number(value.limitBytes) ||
    !boundedString(value.message, 2_000) || !record(value.omitted) || !exactKeys(value.omitted, SNAPSHOT_OMISSION_KEYS)) return false
  const entries = Object.entries(value.omitted)
  return entries.length > 0 && entries.every(([, count]) => Number.isSafeInteger(count) && Number(count) > 0 && Number(count) <= 1_000_000)
}

function validTodos(value: unknown): value is TodoItem[] {
  if (!Array.isArray(value) || value.length > 1_000) return false
  let characters = 0
  return value.every((todo) => {
    if (!record(todo) || !exactKeys(todo, ["id", "content", "status", "priority"]) || (todo.id !== undefined && !validID(todo.id)) ||
      !boundedString(todo.content, 20_000) || !boundedString(todo.status, 100) || !boundedOptionalString(todo.priority, 100)) return false
    characters += (todo.id?.length ?? 0) + todo.content.length + todo.status.length + (todo.priority?.length ?? 0)
    return characters <= 1_000_000
  })
}

function validChanges(value: unknown): value is FileChange[] {
  if (!Array.isArray(value) || value.length > 500) return false
  let characters = 0
  return value.every((change) => {
    if (!record(change) || !exactKeys(change, ["file", "patch", "additions", "deletions", "status"]) ||
      !boundedString(change.file, 8_192) || change.file.length === 0 || !boundedOptionalString(change.patch, 500_000) ||
      !Number.isSafeInteger(change.additions) || Number(change.additions) < 0 || !Number.isSafeInteger(change.deletions) || Number(change.deletions) < 0 ||
      (change.status !== undefined && !["added", "deleted", "modified"].includes(String(change.status)))) return false
    characters += change.file.length + (change.patch?.length ?? 0)
    return characters <= 4_000_000
  })
}

function validQuestions(value: unknown): value is QuestionRequest[] {
  if (!Array.isArray(value) || value.length > 100) return false
  let characters = 0
  return value.every((request) => {
    if (!record(request) || !exactKeys(request, ["id", "sessionID", "questions", "protocol"]) || !validID(request.id) ||
      !validID(request.sessionID) || !["legacy", "v2"].includes(String(request.protocol)) || !Array.isArray(request.questions) ||
      request.questions.length === 0 || request.questions.length > 20) return false
    return request.questions.every((question) => {
      if (!record(question) || !exactKeys(question, ["question", "header", "options", "multiple", "custom"]) ||
        !boundedString(question.question, 20_000) || !boundedString(question.header, 1_000) || !Array.isArray(question.options) ||
        question.options.length > 50 || (question.multiple !== undefined && typeof question.multiple !== "boolean") ||
        (question.custom !== undefined && typeof question.custom !== "boolean")) return false
      characters += question.question.length + question.header.length
      return characters <= 1_000_000 && question.options.every((option) => {
        if (!record(option) || !exactKeys(option, ["label", "description"]) || !boundedString(option.label, 2_000) ||
          !boundedString(option.description, 20_000)) return false
        characters += option.label.length + option.description.length
        return characters <= 1_000_000
      })
    })
  })
}

function validPermissions(value: unknown): value is PermissionRequest[] {
  if (!Array.isArray(value) || value.length > 100) return false
  let characters = 0
  return value.every((request) => {
    if (!record(request) || !exactKeys(request, ["id", "sessionID", "title", "type", "pattern", "metadata", "always", "protocol", "truncated"]) ||
      !validID(request.id) || !validID(request.sessionID) || !boundedString(request.title, 8_000) ||
      !boundedOptionalString(request.type) || !["legacy", "current", "v2"].includes(String(request.protocol)) ||
      (request.pattern !== undefined && !(boundedString(request.pattern, 20_000) ||
        (Array.isArray(request.pattern) && request.pattern.length <= 100 && request.pattern.every((item) => boundedString(item, 20_000))))) ||
      (request.always !== undefined && (!Array.isArray(request.always) || request.always.length > 100 || !request.always.every((item) => boundedString(item, 20_000)))) ||
      (request.metadata !== undefined && !validJson(request.metadata)) ||
      (request.truncated !== undefined && typeof request.truncated !== "boolean")) return false
    characters += permissionRequestCharacters(request as unknown as PermissionRequest)
    return characters <= PERMISSION_AGGREGATE_CHARACTER_LIMIT
  })
}

function validContext(value: unknown): value is ContextSummary {
  if (!record(value) || !exactKeys(value, ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "contextLimit", "inputLimit", "outputLimit", "model", "usageReported", "usagePercent", "cost"])) return false
  const counts = [value.inputTokens, value.outputTokens, value.reasoningTokens, value.cacheReadTokens, value.cacheWriteTokens, value.totalTokens]
  return counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000_000_000_000) &&
    Number(value.totalTokens) === counts.slice(0, 5).reduce<number>((total, count) => total + Number(count), 0) &&
    (value.contextLimit === undefined || (Number.isSafeInteger(value.contextLimit) && Number(value.contextLimit) > 0)) &&
    (value.inputLimit === undefined || (Number.isSafeInteger(value.inputLimit) && Number(value.inputLimit) > 0)) &&
    (value.outputLimit === undefined || (Number.isSafeInteger(value.outputLimit) && Number(value.outputLimit) > 0)) && boundedOptionalString(value.model, 2_049) &&
    (value.usageReported === undefined || typeof value.usageReported === "boolean") &&
    (value.usageReported !== false || value.usagePercent === undefined) &&
    (value.usagePercent === undefined || (typeof value.usagePercent === "number" && Number.isFinite(value.usagePercent) && value.usagePercent >= 0 && value.usagePercent <= 100)) &&
    typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 && value.cost <= 1_000_000_000_000
}

function validSessionMetrics(value: unknown): value is SessionMetrics {
  if (!record(value) || !exactKeys(value, ["tokensUsed", "timeUsedSeconds", "turnsUsed", "turnsTruncated", "sampledAt"])) return false
  return (value.tokensUsed === undefined || (Number.isSafeInteger(value.tokensUsed) && Number(value.tokensUsed) >= 0)) &&
    Number.isSafeInteger(value.timeUsedSeconds) && Number(value.timeUsedSeconds) >= 0 &&
    Number.isSafeInteger(value.turnsUsed) && Number(value.turnsUsed) >= 0 &&
    (value.turnsTruncated === undefined || typeof value.turnsTruncated === "boolean") &&
    Number.isSafeInteger(value.sampledAt) && Number(value.sampledAt) >= 0
}

function validGoalMetric(value: unknown): value is GoalMetricSummary {
  if (!record(value) || !exactKeys(value, ["id", "sequence", "objective", "status", "tokensUsed", "timeUsedSeconds", "turnsUsed", "autoTurns", "createdAt", "closedAt"])) return false
  return boundedString(value.id) && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 1 &&
    boundedString(value.objective, 400) && boundedString(value.status, 100) &&
    [value.tokensUsed, value.timeUsedSeconds, value.turnsUsed, value.autoTurns, value.createdAt]
      .every((metric) => Number.isSafeInteger(metric) && Number(metric) >= 0) &&
    (value.closedAt === undefined || (Number.isSafeInteger(value.closedAt) && Number(value.closedAt) >= Number(value.createdAt)))
}

function validGoal(value: unknown): value is GoalSummary {
  if (!record(value) || !exactKeys(value, ["id", "sequence", "objective", "status", "sourceTool", "tokenBudget", "tokensUsed", "remainingTokens", "timeUsedSeconds", "maxDurationSeconds", "turnsUsed", "autoTurns", "maxAutoTurns", "lastStatus", "stopReason", "checkpoint", "completionEvidence", "blocker", "acceptanceCriteria", "verifier", "latestVerdict", "evidenceReferences", "consecutiveBlockedVerdicts", "pendingContinuation", "settlementGeneration", "planReference", "runGroupReference", "createdAt", "closedAt", "archivedGoals", "sampledAt"]) ||
    !boundedOptionalString(value.objective, 20_000) || !boundedOptionalString(value.status, 100) || !boundedString(value.sourceTool, 100)) return false
  return boundedOptionalString(value.id) && (value.sequence === undefined || (Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 1)) &&
    [value.tokenBudget, value.tokensUsed, value.remainingTokens, value.timeUsedSeconds, value.maxDurationSeconds, value.turnsUsed, value.autoTurns, value.maxAutoTurns, value.createdAt, value.closedAt, value.sampledAt]
      .every((metric) => metric === undefined || (Number.isSafeInteger(metric) && Number(metric) >= 0)) &&
    [value.lastStatus, value.stopReason, value.checkpoint, value.completionEvidence, value.blocker].every((text) => boundedOptionalString(text, 20_000)) &&
    (value.acceptanceCriteria === undefined || (Array.isArray(value.acceptanceCriteria) && value.acceptanceCriteria.length <= 100 && value.acceptanceCriteria.every((item) => boundedString(item, 2_000)))) &&
    (value.verifier === undefined || (record(value.verifier) && exactKeys(value.verifier, ["model", "agent", "timeoutMilliseconds", "repeatedBlockThreshold", "enabled"]) && boundedOptionalString(value.verifier.model) && boundedOptionalString(value.verifier.agent) && Number.isSafeInteger(value.verifier.timeoutMilliseconds) && Number(value.verifier.timeoutMilliseconds) >= 1_000 && Number(value.verifier.timeoutMilliseconds) <= 300_000 && Number.isSafeInteger(value.verifier.repeatedBlockThreshold) && Number(value.verifier.repeatedBlockThreshold) >= 1 && Number(value.verifier.repeatedBlockThreshold) <= 10 && typeof value.verifier.enabled === "boolean")) &&
    (value.evidenceReferences === undefined || (Array.isArray(value.evidenceReferences) && value.evidenceReferences.length <= 500 && value.evidenceReferences.every((item) => boundedString(item)))) &&
    (value.consecutiveBlockedVerdicts === undefined || (Number.isSafeInteger(value.consecutiveBlockedVerdicts) && Number(value.consecutiveBlockedVerdicts) >= 0)) &&
    (value.pendingContinuation === undefined || typeof value.pendingContinuation === "boolean") &&
    (value.settlementGeneration === undefined || (Number.isSafeInteger(value.settlementGeneration) && Number(value.settlementGeneration) >= 0)) &&
    boundedOptionalString(value.planReference, 8_192) && boundedOptionalString(value.runGroupReference) &&
    (value.archivedGoals === undefined || (Array.isArray(value.archivedGoals) && value.archivedGoals.length <= 100 && value.archivedGoals.every(validGoalMetric))) &&
    (value.latestVerdict === undefined || (record(value.latestVerdict) && ["continue", "complete", "blocked", "needs-user"].includes(String(value.latestVerdict.verdict)) && boundedString(value.latestVerdict.reason, 4_000) && Array.isArray(value.latestVerdict.missingCriteria) && value.latestVerdict.missingCriteria.length <= 100 && value.latestVerdict.missingCriteria.every((item) => boundedString(item, 2_000)) && ["low", "medium", "high"].includes(String(value.latestVerdict.confidence))))
}

function validRuntimeService(value: unknown): boolean {
  return record(value) && exactKeys(value, ["id", "name", "status", "root", "error", "extensions", "enabled"]) && validID(value.id) &&
    boundedOptionalString(value.name, 2_000) && boundedOptionalString(value.status, 100) && boundedOptionalString(value.root, 8_192) &&
    boundedOptionalString(value.error, 20_000) && (value.extensions === undefined || (Array.isArray(value.extensions) && value.extensions.length <= 200 &&
      value.extensions.every((extension) => boundedString(extension, 100)))) && (value.enabled === undefined || typeof value.enabled === "boolean")
}

function validRuntime(value: unknown): value is RuntimeStatus {
  if (!record(value) || !exactKeys(value, ["path", "vcs", "lsp", "formatters", "mcp", "updatedAt"]) ||
    !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0) return false
  if (value.path !== undefined && (!record(value.path) || !exactKeys(value.path, ["home", "state", "config", "worktree", "directory"]) || ![value.path.home, value.path.state, value.path.config, value.path.worktree, value.path.directory]
    .every((entry) => boundedOptionalString(entry, 8_192)))) return false
  if (value.vcs !== undefined && (!record(value.vcs) || !exactKeys(value.vcs, ["branch"]) || !boundedOptionalString(value.vcs.branch, 2_000))) return false
  return [value.lsp, value.formatters, value.mcp].every((services) =>
    Array.isArray(services) && services.length <= 500 && services.every(validRuntimeService)
  )
}

function validPtys(value: unknown): value is OpenCodePty[] {
  if (!Array.isArray(value) || value.length > 500) return false
  const ids = new Set<string>()
  let characters = 0
  return value.every((pty) => {
    if (
      !record(pty) ||
      !exactKeys(pty, [
        "id",
        "title",
        "command",
        "args",
        "cwd",
        "status",
        "pid",
        "exitCode",
      ]) ||
      !validID(pty.id) || /[\u0000-\u001f\u007f]/.test(pty.id) ||
      ids.has(pty.id) ||
      !boundedString(pty.title, 2_000) || pty.title.includes("\0") ||
      !boundedString(pty.command, 8_192) || !pty.command ||
      pty.command.includes("\0") ||
      !boundedString(pty.cwd, 8_192) || !pty.cwd || pty.cwd.includes("\0") ||
      !Array.isArray(pty.args) || pty.args.length > 256 ||
      !["running", "exited"].includes(String(pty.status)) ||
      !Number.isSafeInteger(pty.pid) || Number(pty.pid) < 0 ||
      Number(pty.pid) > 2_147_483_647 ||
      (pty.exitCode !== undefined &&
        (!Number.isSafeInteger(pty.exitCode) ||
          Number(pty.exitCode) < -2_147_483_648 ||
          Number(pty.exitCode) > 2_147_483_647))
    ) return false
    let argumentCharacters = 0
    if (
      !pty.args.every((argument) => {
        if (
          !boundedString(argument, 20_000) || argument.includes("\0")
        ) return false
        argumentCharacters += argument.length
        return argumentCharacters <= 100_000
      })
    ) return false
    ids.add(pty.id)
    characters += pty.id.length + pty.title.length + pty.command.length +
      pty.cwd.length + argumentCharacters
    return characters <= 4_000_000
  })
}

function validWorkbenchHealth(value: unknown): value is WorkbenchHealthSummary {
  if (
    !record(value) ||
    !exactKeys(value, [
      "workbenchVersion",
      "vscodeVersion",
      "openCodeVersion",
      "serverMode",
      "serverState",
      "pluginState",
      "capabilities",
      "eventStream",
      "requestQueueDepth",
      "protocol",
    ]) ||
    !boundedString(value.workbenchVersion, 100) ||
    !boundedString(value.vscodeVersion, 100) ||
    !boundedOptionalString(value.openCodeVersion, 100) ||
    !["managed", "external"].includes(String(value.serverMode)) ||
    !["starting", "connected", "reconnecting", "failed", "disconnected"]
      .includes(String(value.serverState)) ||
    !["available", "unavailable", "unknown"].includes(
      String(value.pluginState),
    ) || !Array.isArray(value.capabilities) ||
    value.capabilities.length > 200 ||
    !value.capabilities.every((entry) => boundedString(entry, 256)) ||
    !Number.isSafeInteger(value.requestQueueDepth) ||
    Number(value.requestQueueDepth) < 0 ||
    !record(value.eventStream) ||
    !exactKeys(value.eventStream, [
      "state",
      "lastEventAt",
      "lastReconciliationAt",
      "reconnectCount",
    ]) || !boundedString(value.eventStream.state, 100) ||
    !Number.isSafeInteger(value.eventStream.reconnectCount) ||
    Number(value.eventStream.reconnectCount) < 0 ||
    ![value.eventStream.lastEventAt, value.eventStream.lastReconciliationAt]
      .every((entry) =>
        entry === undefined ||
        (Number.isSafeInteger(entry) && Number(entry) >= 0)
      ) ||
    !record(value.protocol) ||
    !exactKeys(value.protocol, ["version", "epoch"]) ||
    !Number.isSafeInteger(value.protocol.version) ||
    Number(value.protocol.version) < 1 ||
    !boundedOptionalString(value.protocol.epoch, 1_024)
  ) return false
  return true
}

function validWorkbenchTrace(value: unknown): value is WorkbenchTraceSummary[] {
  return Array.isArray(value) && value.length <= 100 &&
    value.every((entry) =>
      record(entry) &&
      exactKeys(entry, [
        "type",
        "timestamp",
        "sessionID",
        "transition",
        "durationMilliseconds",
      ]) &&
      boundedString(entry.type, 256) && Number.isSafeInteger(entry.timestamp) &&
      Number(entry.timestamp) >= 0 && boundedOptionalString(entry.sessionID) &&
      boundedOptionalString(entry.transition, 256) &&
      (entry.durationMilliseconds === undefined ||
        (typeof entry.durationMilliseconds === "number" &&
          Number.isFinite(entry.durationMilliseconds) &&
          entry.durationMilliseconds >= 0))
    )
}

function validRecoveryPreview(value: unknown): value is RecoveryPreview {
  return record(value) &&
    exactKeys(value, [
      "sessionID",
      "messageID",
      "userText",
      "removedMessageIDs",
      "removedTurns",
      "changedFiles",
      "limitations",
      "canRevert",
      "canFork",
      "canRedo",
    ]) &&
    validID(value.sessionID) && validID(value.messageID) &&
    boundedString(value.userText, 20_000) &&
    Array.isArray(value.removedMessageIDs) &&
    value.removedMessageIDs.length <= 5_000 &&
    value.removedMessageIDs.every(validID) &&
    Number.isSafeInteger(value.removedTurns) &&
    Number(value.removedTurns) >= 0 && Number(value.removedTurns) <= 5_000 &&
    Array.isArray(value.changedFiles) && value.changedFiles.length <= 500 &&
    value.changedFiles.every((file) =>
      record(file) && exactKeys(file, ["file", "additions", "deletions"]) &&
      boundedString(file.file, 8_192) && Number.isSafeInteger(file.additions) &&
      Number(file.additions) >= 0 && Number.isSafeInteger(file.deletions) &&
      Number(file.deletions) >= 0
    ) &&
    Array.isArray(value.limitations) && value.limitations.length <= 20 &&
    value.limitations.every((entry) => boundedString(entry, 2_000)) &&
    typeof value.canRevert === "boolean" &&
    typeof value.canFork === "boolean" && typeof value.canRedo === "boolean" &&
    (Number(value.removedTurns) >= 1 ||
      (Number(value.removedTurns) === 0 && value.removedMessageIDs.length === 0 && value.canRedo && !value.canRevert && !value.canFork))
}

export function parseHostMessage(
  value: unknown,
): HostToWebviewMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  if (value.type === "error") {
    return typeof value.message === "string" ? { type: "error", message: value.message } : undefined
  }
  if (value.type === "insertText") {
    return exactKeys(value, ["type", "sessionID", "text"]) && validID(value.sessionID) && boundedString(value.text, 100_000)
      ? { type: "insertText", sessionID: value.sessionID, text: value.text }
      : undefined
  }
  if (value.type === "fileSuggestions") {
    return exactKeys(value, ["type", "sessionID", "requestID", "files"]) && validID(value.sessionID) && Number.isSafeInteger(value.requestID) && Number(value.requestID) >= 0 &&
        Array.isArray(value.files) && value.files.length <= 20 && value.files.every((file) => boundedString(file, 8_192))
      ? { type: "fileSuggestions", sessionID: value.sessionID, requestID: Number(value.requestID), files: value.files }
      : undefined
  }
  if (value.type === "editorContextChanged") {
    if (!exactKeys(value, ["type", "context"])) return undefined
    if (value.context === undefined) return { type: "editorContextChanged" }
    return record(value.context) && exactKeys(value.context, ["name", "detail", "dirty", "attached"]) && boundedString(value.context.name, 255) &&
        boundedOptionalString(value.context.detail, 255) && (value.context.dirty === undefined || typeof value.context.dirty === "boolean") &&
        (value.context.attached === undefined || typeof value.context.attached === "boolean")
      ? { type: "editorContextChanged", context: value.context as unknown as EditorContextSummary }
      : undefined
  }
  if (value.type === "contextAttachmentsChanged") {
    const valid = exactKeys(value, ["type", "sessionID", "attachments"]) && validID(value.sessionID) && Array.isArray(value.attachments) && value.attachments.length <= 20 &&
      value.attachments.every((attachment) => record(attachment) && exactKeys(attachment, ["id", "name", "detail", "kind"]) && validID(attachment.id) &&
        boundedString(attachment.name, 255) && boundedOptionalString(attachment.detail, 255) && ["file", "folder", "selection", "buffer", "resource", "notebook"].includes(String(attachment.kind)))
    return valid ? value as unknown as HostToWebviewMessage : undefined
  }
  if (value.type === "composerPayloadChanged") {
    return exactKeys(value, ["type", "sessionID", "revision", "attachments", "pastedText", "conflict", "mutationID"]) && validID(value.sessionID) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 &&
        (value.conflict === undefined || typeof value.conflict === "boolean") && (value.mutationID === undefined || (typeof value.mutationID === "string" && /^cmp_[a-f0-9]{32}$/.test(value.mutationID))) &&
        validInlineAttachments(value.attachments, false) && validPastedText(value.pastedText)
      ? value as unknown as HostToWebviewMessage
      : undefined
  }
  if (value.type === "draftChanged") {
    return exactKeys(value, ["type", "sessionID", "draft", "revision"]) && validID(value.sessionID) && boundedString(value.draft, PROMPT_TEXT_CHARACTER_LIMIT) &&
        Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
      ? value as unknown as HostToWebviewMessage
      : undefined
  }
  if (value.type === "sessionRemoved") {
    return exactKeys(value, ["type", "sessionID"]) && validID(value.sessionID) ? { type: "sessionRemoved", sessionID: value.sessionID } : undefined
  }
  if (value.type === "navigateWorkbench") {
    return exactKeys(value, ["type", "tab", "itemID", "focus"]) &&
        WORKBENCH_INSPECTOR_TABS.has(String(value.tab)) &&
        boundedOptionalString(value.itemID) &&
        (value.focus === undefined || typeof value.focus === "boolean")
      ? {
        type: "navigateWorkbench",
        tab: value.tab as WorkbenchInspectorTab,
        itemID: value.itemID,
        focus: value.focus,
      }
      : undefined
  }
  if (value.type === "workbenchControl") {
    return exactKeys(value, ["type", "target", "action"]) && ["sessions", "jobs", "attention"].includes(String(value.target)) &&
        ["show", "toggle"].includes(String(value.action))
      ? value as HostToWebviewMessage
      : undefined
  }
  if (value.type === "recoveryPreview") {
    return exactKeys(value, ["type", "preview"]) &&
        validRecoveryPreview(value.preview)
      ? value as unknown as HostToWebviewMessage
      : undefined
  }
  if (value.type === "messagePatches") {
    if (!exactKeys(value, ["type", "patches"]) || !Array.isArray(value.patches) || value.patches.length > 100) return undefined
    const valid = value.patches.every((patch) => record(patch) && exactKeys(patch, ["sessionID", "messageID", "message", "revision", "active", "append", "afterMessageID"]) &&
      validID(patch.sessionID) && validID(patch.messageID) && Number.isSafeInteger(patch.revision) && Number(patch.revision) >= 0 &&
      typeof patch.active === "boolean" && typeof patch.append === "boolean" && boundedOptionalString(patch.afterMessageID) && (patch.message === undefined || (validMessages([patch.message]) &&
        (patch.message as MessageBundle).info.id === patch.messageID && (patch.message as MessageBundle).info.sessionID === patch.sessionID &&
        (patch.message as MessageBundle).parts.every((part) => part.messageID === patch.messageID && part.sessionID === patch.sessionID))))
    const messages = value.patches.flatMap((patch) => record(patch) && patch.message !== undefined ? [patch.message] : [])
    if (valid && !validMessages(messages)) return undefined
    return valid ? value as HostToWebviewMessage : undefined
  }
  if (value.type === "historyPage") {
    return exactKeys(value, ["type", "page"]) && validTranscriptHistoryPage(value.page)
      ? value as HostToWebviewMessage
      : undefined
  }
  if (value.type !== "snapshot" || !record(value.snapshot)) return undefined
  const snapshot = value.snapshot
  if (
    typeof snapshot.connected !== "boolean" ||
    !["connecting", "connected", "reconnecting", "failed"].includes(
      String(snapshot.connectionState),
    ) ||
    snapshot.connected !== (snapshot.connectionState === "connected") ||
    !boundedOptionalString(snapshot.connectionError, 20_000) ||
    !Array.isArray(snapshot.sessions) ||
    !validSessionOptions(snapshot.sessions) ||
    (snapshot.lineage !== undefined && !validLineage(snapshot.lineage)) ||
    !Array.isArray(snapshot.agents) || snapshot.agents.length > 500 ||
    !validCatalog(snapshot.agents, validAgent) ||
    (snapshot.mentionAgents !== undefined &&
      (!Array.isArray(snapshot.mentionAgents) ||
        snapshot.mentionAgents.length > 500 ||
        !validCatalog(snapshot.mentionAgents, validAgent))) ||
    (snapshot.providers !== undefined &&
      (!Array.isArray(snapshot.providers) || snapshot.providers.length > 500 ||
        !validCatalog(snapshot.providers, validProvider))) ||
    !Array.isArray(snapshot.models) || snapshot.models.length > 5_000 ||
    !validCatalog(snapshot.models, validModel) ||
    (snapshot.resources !== undefined &&
      (!Array.isArray(snapshot.resources) ||
        snapshot.resources.length > 2_000 ||
        !validCatalog(snapshot.resources, validResource))) ||
    (snapshot.catalog !== undefined &&
      (!record(snapshot.catalog) ||
        !exactKeys(snapshot.catalog, ["status", "updatedAt", "error"]) ||
        !["ready", "stale", "error"].includes(
          String(snapshot.catalog.status),
        ) ||
        (snapshot.catalog.updatedAt !== undefined &&
          (!Number.isSafeInteger(snapshot.catalog.updatedAt) ||
            Number(snapshot.catalog.updatedAt) < 0)) ||
        !boundedOptionalString(snapshot.catalog.error, 20_000))) ||
    (snapshot.commands !== undefined &&
      (!Array.isArray(snapshot.commands) || snapshot.commands.length > 1_000 ||
        !validCatalog(snapshot.commands, validCommand))) ||
    (snapshot.autoApproval !== undefined &&
      typeof snapshot.autoApproval !== "boolean") ||
    (snapshot.runtime !== undefined && !validRuntime(snapshot.runtime)) ||
    (snapshot.ptys !== undefined && !validPtys(snapshot.ptys)) ||
    (snapshot.attentionItems !== undefined &&
      !validAttentionItems(snapshot.attentionItems)) ||
    (snapshot.composer !== undefined &&
      (!record(snapshot.composer) ||
        !["send", "newline"].includes(
          String(snapshot.composer.enterBehavior),
        ))) ||
    (snapshot.runGroups !== undefined && !validRunGroups(snapshot.runGroups)) ||
    (snapshot.worktrees !== undefined && !validWorktrees(snapshot.worktrees)) ||
    (snapshot.walkthroughs !== undefined &&
      !validWalkthroughs(snapshot.walkthroughs)) ||
    (snapshot.health !== undefined && !validWorkbenchHealth(snapshot.health)) ||
    (snapshot.trace !== undefined && !validWorkbenchTrace(snapshot.trace)) ||
    (snapshot.projection !== undefined &&
      !validSnapshotProjection(snapshot.projection))
  ) return undefined
  if (snapshot.session !== undefined) {
    if (!record(snapshot.session)) return undefined
    const session = snapshot.session
    if (
      !boundedString(session.id) ||
      !boundedOptionalString(session.parentID) ||
      !boundedOptionalString(session.directory, 8_192) ||
      !boundedString(session.title, 2_000) ||
      !boundedString(session.draft, PROMPT_TEXT_CHARACTER_LIMIT) ||
      !validStatus(session.status) ||
      typeof session.loaded !== "boolean" ||
      !["idle", "loading", "ready", "error"].includes(
        String(session.loadState),
      ) ||
      !Array.isArray(session.messages) || !validMessages(session.messages) ||
      !validMessageRevisions(session.messageRevisions, session.messages) ||
      !boundedOptionalString(session.agent) ||
      !boundedOptionalString(session.model) ||
      !boundedOptionalString(session.variant) ||
      (session.queue !== undefined && !validQueue(session.queue)) ||
      !boundedOptionalString(session.inFlightPromptID) ||
      (session.inFlightPromptID !== undefined &&
        (!Array.isArray(session.queue) ||
          !session.queue.some((prompt) =>
            record(prompt) && prompt.id === session.inFlightPromptID
          ))) ||
      (session.permissions !== undefined &&
        !validPermissions(session.permissions)) ||
      (session.questions !== undefined && !validQuestions(session.questions)) ||
      (session.todos !== undefined && !validTodos(session.todos)) ||
      (session.changes !== undefined && !validChanges(session.changes)) ||
      (session.context !== undefined && !validContext(session.context)) ||
      (session.metrics !== undefined && !validSessionMetrics(session.metrics)) ||
      (session.goal !== undefined && !validGoal(session.goal)) ||
      (session.goalHistory !== undefined && (!Array.isArray(session.goalHistory) || session.goalHistory.length > 100 || !session.goalHistory.every(validGoalMetric))) ||
      (session.delegations !== undefined &&
        !validDelegations(session.delegations)) ||
      (session.contextReceipts !== undefined &&
        !validContextReceipts(session.contextReceipts)) ||
      (session.history !== undefined &&
        (!validTranscriptHistory(session.history) ||
          session.history.visibleMessages !== session.messages.length)) ||
      (session.archived !== undefined &&
        typeof session.archived !== "boolean") ||
      (session.shared !== undefined && typeof session.shared !== "boolean") ||
      !boundedOptionalString(session.shareUrl, 8_192) ||
      !boundedOptionalString(session.revertMessageID)
    ) return undefined
  }
  if (
    snapshot.artifacts !== undefined || snapshot.reviewFindings !== undefined || snapshot.evidence !== undefined ||
    snapshot.runComparisons !== undefined
  ) {
    if (
      !record(snapshot.session) || !boundedString(snapshot.session.id) ||
      (snapshot.artifacts !== undefined &&
        !validTaskArtifactSummaries(snapshot.artifacts, snapshot.session.id)) ||
      (snapshot.reviewFindings !== undefined &&
        !validReviewFindingSnapshots(snapshot.reviewFindings, snapshot.session.id)) ||
      (snapshot.evidence !== undefined &&
        !validEvidenceReferences(snapshot.evidence, snapshot.session.id)) ||
      (snapshot.runComparisons !== undefined &&
        !validRunComparisonSnapshots(snapshot.runComparisons))
    ) return undefined
  }
  return value as HostToWebviewMessage
}
