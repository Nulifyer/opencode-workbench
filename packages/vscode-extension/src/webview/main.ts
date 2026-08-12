import { createOpenCodeMessageID, MULTI_RUN_MAX_CANDIDATES, parseHostMessage } from "@opencode-workbench/shared"
import {
  type ChatSnapshot,
  type ContextAttachmentSummary,
  type EditorContextSummary,
  type InlineAttachment,
  type MessageBundle,
  type MessagePart,
  type PastedTextBlock,
  type PermissionRequest,
  PROMPT_ATTACHMENT_COUNT_LIMIT,
  PROMPT_TEXT_CHARACTER_LIMIT,
  type RecoveryPreview,
  reusablePermissionScopes,
  type RuntimeService,
  type WebviewToHostMessage,
  type WorkbenchCapabilities,
  type WorkbenchCapability,
} from "@opencode-workbench/shared"
import {
  activityVisualState,
  applyPatchFiles,
  applyPatchSection,
  attachmentDisplay,
  attachmentReference,
  commandActivityLabel,
  compactMetric,
  connectionPresentation,
  currentTodoContent,
  delegationCompletionSummary,
  diffHasLineNumbers,
  diffLineKind,
  fileReference,
  fileUriFromPath,
  formatDuration,
  isCompactionMessage,
  isGoalContinuationMessage,
  isNativeCompactionContinuationMessage,
  mergeRevisionValues,
  pastedTextReference,
  patchActivityLabel,
  permissionPresentation,
  permissionUiGroups,
  presentedTodos,
  questionAnswerValues,
  reasoningDetail,
  reasoningSummary,
  runtimeServicePresentation,
  sessionLoadPhase,
  shellOutputWithoutCommandEcho,
  shouldCollapsePaste,
  stripTerminalSequences,
  terminalAnsiMarkup,
  toolKind,
  workspaceMentionReference,
} from "./presentation.js"
import { renderMarkdown } from "./markdown.js"
import { WorkbenchProtocolClient } from "./transport/protocol-v2-client.js"
import { parseWithProtocolV1Adapter } from "./transport/protocol-v1-adapter.js"
import { WorkbenchWebviewStore } from "./state/store.js"
import { type ComposerPayloadState, ComposerState, type PendingComposerPayload } from "./state/composer.js"
import { FocusController } from "./controllers/focus-controller.js"
import { HistoryController } from "./controllers/history-controller.js"
import type { ScrollAnchor } from "./controllers/scroll-controller.js"
import { ModalController } from "./controllers/modal-controller.js"
import { MetricsController } from "./controllers/metrics-controller.js"
import { MultiRunController } from "./controllers/multi-run-controller.js"
import { type MenuNavigationKey, nextMenuIndex } from "./controllers/menu-navigation.js"
import { SplitPaneController } from "./controllers/split-pane-controller.js"
import { ConversationView } from "./views/conversation.js"
import { deliveryLabel, queueProjection } from "./views/queue.js"
import { SESSION_COMPLETED_ICON, sessionListMarkup, sessionStatusLabel } from "./views/session-list.js"
import { InspectorShellController } from "./views/inspector/shell.js"
import {
  inspectorPresentation,
  type InspectorTab,
  type RunComparisonSort,
  type RunComparisonSortKey,
} from "./views/inspector/presentation.js"
import { composerSubmitIntent } from "./views/composer.js"
import {
  addGoalCriterion,
  applyGoalFormPreset,
  createGoalFormDraft,
  type GoalFormDraft,
  goalFormMarkup,
  type GoalFormPreset,
  moveGoalCriterion,
  removeGoalCriterion,
  serializeGoalFormDraft,
} from "./views/goal-form.js"
import { historyLoadAllLabel, historyLoadAllProgress, historyPresentation, mergeHistoryPage } from "./views/history.js"
import { turnNavigationMarkers, turnNavigationScrollTop } from "./views/turn-navigation.js"

interface WebviewState {
  todoExpanded?: boolean
  inspectorOpen?: boolean
  inspectorTab?: string
  layout?: { sessionsWidth?: number; sessionsOpen?: boolean }
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): WebviewState | undefined
  setState(state: WebviewState): void
}

const vscode = acquireVsCodeApi()
let negotiatedCapabilities: WorkbenchCapabilities | undefined
const transport = new WorkbenchProtocolClient<
  WebviewToHostMessage,
  NonNullable<ReturnType<typeof parseHostMessage>>,
  WebviewState
>(vscode, window, {
  surfaceID: document.body.dataset.surfaceId ?? "unknown-surface",
  extensionVersion: document.body.dataset.extensionVersion ?? "unknown",
  legacyReady: { type: "ready" },
  parseInbound: (value) => parseWithProtocolV1Adapter(value, parseHostMessage),
  protocolError: (message) => ({ type: "error", message: `Workbench protocol: ${message}` }),
  onReady: (ready) => {
    negotiatedCapabilities = ready.capabilities
    applyCapabilityControls()
  },
})
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const messages = element<HTMLElement>("messages")
const interactionRegion = document.querySelector<HTMLElement>(".interaction-region")!
const turnNavigation = element<HTMLElement>("turn-navigation")
const turnNavigationPreview = element<HTMLElement>("turn-navigation-preview")
const jumpLatest = element<HTMLButtonElement>("jump-latest")
const jumpLatestCount = element<HTMLElement>("jump-latest-count")
const historyBoundary = element<HTMLElement>("history-boundary")
const historyBoundaryText = element<HTMLElement>("history-boundary-text")
const historyLoadOlder = element<HTMLButtonElement>("history-load-older")
const historyLoadAll = element<HTMLButtonElement>("history-load-all")
const historyLoadProgress = element<HTMLElement>("history-load-progress")
const sessionLoading = element<HTMLElement>("session-loading")
const notice = element<HTMLElement>("notice")
const noticeTitle = element<HTMLElement>("notice-title")
const noticeMessage = element<HTMLElement>("notice-message")
const noticeRetry = element<HTMLButtonElement>("notice-retry")
const noticeLogs = element<HTMLButtonElement>("notice-logs")
const noticeCopy = element<HTMLButtonElement>("notice-copy")
const noticeDismiss = element<HTMLButtonElement>("notice-dismiss")
const empty = element<HTMLElement>("empty")
const draft = element<HTMLTextAreaElement>("draft")
const announcer = element<HTMLElement>("announcer")
const send = element<HTMLButtonElement>("send")
const sendGroup = element<HTMLElement>("send-group")
const sendOptions = element<HTMLDetailsElement>("send-options")
const createHeader = element<HTMLButtonElement>("create-header")
const createEmpty = element<HTMLButtonElement>("create-empty")
const planTask = element<HTMLButtonElement>("plan-task")
const surfaceToggle = element<HTMLButtonElement>("surface-toggle")
const backParent = element<HTMLButtonElement>("back-parent")
const sessionCurrent = element<HTMLButtonElement>("session-current")
const sessionTitle = element<HTMLElement>("session-title")
const sessionState = element<HTMLElement>("session-state")
const publicBadge = element<HTMLElement>("public-badge")
const status = element<HTMLElement>("status")
const connection = element<HTMLElement>("connection")
const attentionToggle = element<HTMLButtonElement>("attention-toggle")
const attentionCount = element<HTMLElement>("attention-count")
const attentionOverlay = element<HTMLElement>("attention-overlay")
const attentionList = element<HTMLElement>("attention-list")
const attentionMarkRead = element<HTMLButtonElement>("attention-mark-read")
const recoveryOverlay = element<HTMLElement>("recovery-overlay")
const recoveryContent = element<HTMLElement>("recovery-content")
const helpToggle = element<HTMLButtonElement>("help-toggle")
const keyboardHelpOverlay = element<HTMLElement>("keyboard-help-overlay")
const inspector = element<HTMLElement>("inspector")
const inspectorClose = element<HTMLButtonElement>("inspector-close")
const sessionDetailsInfo = element<HTMLElement>("session-details-info")
const inspectorPanel = element<HTMLElement>("inspector-panel")
const agent = element<HTMLSelectElement>("agent")
const model = element<HTMLSelectElement>("model")
const variant = element<HTMLSelectElement>("variant")
const modelToggle = element<HTMLButtonElement>("model-toggle")
const modelButtonLabel = element<HTMLElement>("model-button-label")
const variantButtonLabel = element<HTMLElement>("variant-button-label")
const modelPicker = element<HTMLElement>("model-picker")
const modelSearch = element<HTMLInputElement>("model-search")
const modelOptions = element<HTMLElement>("model-options")
const reasoningOptions = element<HTMLElement>("reasoning-options")
const modelMeta = element<HTMLElement>("model-meta")
const multiModelPicker = element<HTMLElement>("multi-model-picker")
const multiModelClose = element<HTMLButtonElement>("multi-model-close")
const multiModelSearch = element<HTMLInputElement>("multi-model-search")
const multiModelOptions = element<HTMLElement>("multi-model-options")
const multiModelSelectVisible = element<HTMLButtonElement>("multi-model-select-visible")
const multiModelClear = element<HTMLButtonElement>("multi-model-clear")
const multiModelCount = element<HTMLElement>("multi-model-count")
const multiModelDisclosure = element<HTMLElement>("multi-model-disclosure")
const multiModelConcurrency = element<HTMLInputElement>("multi-model-concurrency")
const multiModelCancel = element<HTMLButtonElement>("multi-model-cancel")
const multiModelStart = element<HTMLButtonElement>("multi-model-start")
const composer = element<HTMLElement>("composer")
const attachmentDock = element<HTMLElement>("attachment-dock")
const attachmentPreview = element<HTMLElement>("attachment-preview")
const attachmentPreviewTitle = element<HTMLElement>("attachment-preview-title")
const attachmentPreviewImage = element<HTMLImageElement>("attachment-preview-image")
const attachmentPreviewMeta = element<HTMLElement>("attachment-preview-meta")
const attachFiles = element<HTMLButtonElement>("attach-files")
const approvalToggle = element<HTMLButtonElement>("approval-toggle")
const approvalMode = element<HTMLElement>("approval-mode")
const queueDock = element<HTMLElement>("queue-dock")
const commandSuggestions = element<HTMLElement>("command-suggestions")
const fileSuggestionList = element<HTMLElement>("file-suggestions")
const permissionDock = element<HTMLElement>("permission-dock")
const questionDock = element<HTMLElement>("question-dock")
const todoDock = element<HTMLElement>("todo-dock")
const workspaceStrip = element<HTMLElement>("workspace-strip")
const historyOverlay = element<HTMLElement>("history-overlay")
const historySearch = element<HTMLInputElement>("history-search")
const historyList = element<HTMLElement>("history-list")
const railToggle = element<HTMLButtonElement>("rail-toggle")
const railClose = element<HTMLButtonElement>("rail-close")
const rightRail = element<HTMLElement>("right-rail")
const conversationColumn = element<HTMLElement>("conversation-column")
const sessionMenuToggle = element<HTMLButtonElement>("session-menu-toggle")
const sessionMenu = element<HTMLElement>("session-menu")
const sessionMenuSearch = element<HTMLInputElement>("session-menu-search")
const sessionContextMenu = element<HTMLElement>("session-context-menu")
const railSessions = element<HTMLElement>("rail-sessions")
const railSessionCount = element<HTMLElement>("rail-session-count")
const railSessionSearch = element<HTMLInputElement>("rail-session-search")
const railSessionList = element<HTMLElement>("rail-session-list")
const sessionChangeSummary = element<HTMLElement>("session-change-summary")
const sessionTaskDock = element<HTMLElement>("session-task-dock")
const sessionsSplitter = element<HTMLElement>("sessions-splitter")
const store = new WorkbenchWebviewStore()
let snapshot: ChatSnapshot = store.snapshot
const storedState = vscode.getState()
const validInitialWorkbenchControls = new Set(["composer-focus", "sessions-toggle", "sessions-show", "attention-show"])
const initialWorkbenchControl = validInitialWorkbenchControls.has(document.body.dataset.initialControl ?? "")
  ? document.body.dataset.initialControl
  : undefined
let todoExpanded = storedState?.todoExpanded ?? true
const initialInspectorTab = document.body.dataset.initialTab
const inspectorShell = new InspectorShellController({
  ...storedState,
  inspectorOpen: storedState?.inspectorOpen ?? false,
  inspectorTab: initialInspectorTab ?? storedState?.inspectorTab,
})
const INSPECTOR_TABS = new Set<InspectorTab>([
  "activity",
  "plan",
  "changes",
  "review",
  "evidence",
  "goal",
  "jobs",
  "lineage",
  "runs",
  "context",
  "walkthrough",
  "health",
])
const INSPECTOR_DESCRIPTIONS: Record<InspectorTab, string> = {
  activity: "Current status, queue, requests, and todos for this OpenCode session.",
  plan: "A reviewable plan document created before implementation.",
  changes: "Session-attributed file changes with review findings, evidence, and walkthroughs.",
  review: "Review findings anchored to an exact captured diff.",
  evidence: "Deterministic test, diagnostic, task, and diff observations.",
  goal: "Keep OpenCode working toward explicit completion conditions and limits.",
  jobs: "Delegated work, isolated runs, worktrees, terminals, and their session relationships.",
  lineage: "OpenCode parent and child session relationships.",
  runs: "Isolated and multi-model work with comparison and retention controls.",
  context: "Actual token usage and exact context admitted with prompts.",
  walkthrough: "A guided explanation anchored to changed lines.",
  health: "OpenCode connection, companion status, and sanitized diagnostics.",
}
const INSPECTOR_LABELS: Record<InspectorTab, string> = {
  activity: "Session activity",
  plan: "Plan",
  changes: "Changes and results",
  review: "Changes and results",
  evidence: "Changes and results",
  goal: "Keep working until done",
  jobs: "Current work",
  lineage: "Current work",
  runs: "Current work",
  context: "Context details",
  walkthrough: "Changes and results",
  health: "OpenCode health",
}
let inspectorOpen = inspectorShell.open
function consolidatedInspectorTab(tab: string): InspectorTab {
  if (["review", "evidence", "walkthrough"].includes(tab)) return "changes"
  if (["runs", "lineage"].includes(tab)) return "jobs"
  return INSPECTOR_TABS.has(tab as InspectorTab) ? tab as InspectorTab : "activity"
}
let inspectorTab: InspectorTab = consolidatedInspectorTab(inspectorShell.tab)
inspectorShell.select(inspectorTab)
let overlayReturnFocus: HTMLElement | undefined
let railReturnFocus: HTMLElement | undefined
let contextSessionID: string | undefined
let contextReturnSessionID: string | undefined
let contextReturnList: HTMLElement | undefined
let queueSignature = ""
let permissionSignature = ""
let questionSignature = ""
let sessionListSignature = ""
let catalogSignature = ""
let modelPickerSignature = ""
let attentionSignature = ""
let inspectorSignature = ""
let summarySignature = ""
let workspaceSignature = ""
let commandSignature = ""
let sessionRenderLimit = 200
let draftSessionID: string | undefined
let pendingDraft: { sessionID: string; value: string } | undefined
let draftTimer: number | undefined
let fileSearchTimer: number | undefined
let activityTimer: number | undefined
let selectedCommandIndex = 0
let selectedFileIndex = 0
let fileRequestID = 0
let suggestedFiles: string[] = []
let editorContext: EditorContextSummary | undefined
let pendingSessionID: string | undefined
let stoppingSessionID: string | undefined
let creatingSession = false
let attachmentPreviewReturnFocus: HTMLElement | undefined
let modelPickerReturnFocus: HTMLElement | undefined
let modelPickerActiveValue: string | undefined
let reasoningExpanded = false
let noticeKind: "error" | "offline" | "projection" | undefined
let noticeDetail = ""
let dismissedProjectionSignature = ""
let lastAttentionCount: number | undefined
let activeRecoveryPreview: RecoveryPreview | undefined
let recoveryReturnFocus: HTMLElement | undefined
let goalFormDraft: GoalFormDraft | undefined
let goalFormSourceSignature = ""
let comparisonSorts: Record<string, RunComparisonSort> = Object.create(null) as Record<string, RunComparisonSort>
type ReviewFilterKey = "severity" | "category" | "disposition"
type JobFilterKey = "text" | "kind" | "session" | "run"
const reviewFilterKeys = new Set<ReviewFilterKey>(["severity", "category", "disposition"])
const jobFilterKeys = new Set<JobFilterKey>(["text", "kind", "session", "run"])
const localInspectorFilters: { review: Record<ReviewFilterKey, string>; jobs: Record<JobFilterKey, string> } = {
  review: { severity: "", category: "", disposition: "" },
  jobs: { text: "", kind: "", session: "", run: "" },
}
let splitPanes: SplitPaneController | undefined
let pendingAttentionTarget: {
  sessionID?: string
  itemID?: string
  surface: "conversation" | "goal" | "runs" | "health"
} | undefined
const historyController = new HistoryController()
const composerState = new ComposerState()
const localDrafts = composerState.localDrafts
const draftRevisions = composerState.draftRevisions
const submittedDrafts = composerState.submittedDrafts
const attachments = composerState.attachments
const attachmentThumbnails = composerState.attachmentThumbnails
const composerPayloadRevisions = composerState.composerPayloadRevisions
const acknowledgedComposerPayloads = composerState.acknowledgedComposerPayloads
const pendingComposerPayloads = composerState.pendingComposerPayloads
type SentAttachmentPreview = { label: string; name: string; mime: string; thumbnail?: string }
const sentAttachmentPreviews = new Map<string, { sessionID: string; attachments: SentAttachmentPreview[] }>()
const pastedText = composerState.pastedText
const contextAttachments = composerState.contextAttachments
const stashedDrafts = composerState.stashedDrafts
const INLINE_ATTACHMENT_COUNT_LIMIT = 10
const announcedAssistantText = new Map<string, string>()
let announcementTimer: number | undefined
let pendingAnnouncement = ""
const conversationView = new ConversationView({
  container: messages,
  leadingElement: historyBoundary,
  jumpLatest,
  jumpLatestCount,
  renderUser: userHtml,
  renderAssistant: assistantHtml,
  renderTiming: timingHtml,
  renderDependencySignature: messageRenderDependency,
})
const focusController = new FocusController()
const metricsController = new MetricsController(workspaceStrip)
const multiRunController = new MultiRunController({
  root: multiModelPicker,
  search: multiModelSearch,
  options: multiModelOptions,
  selectVisible: multiModelSelectVisible,
  clear: multiModelClear,
  count: multiModelCount,
  disclosure: multiModelDisclosure,
  concurrency: multiModelConcurrency,
  start: multiModelStart,
}, escapeHtml)
const attentionOverlayController = new ModalController(attentionOverlay, attentionToggle)
const keyboardHelpController = new ModalController(keyboardHelpOverlay, helpToggle)
const PRIMARY_ICONS = {
  send: send.innerHTML,
  queue:
    `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 2.4 11.5 7 1.8 11.6 2.9 8 7.4 7 2.9 6 1.8 2.4Zm10.7 7.1h1.2v1.8h1.8v1.2h-1.8v1.8h-1.2v-1.8h-1.8v-1.2h1.8V9.5Z"/></svg>`,
  stop: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4h8v8H4V4Z"/></svg>`,
  sent: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.2 3 3L13 4.8l1 1-8 7.4-4-4 1-1Z"/></svg>`,
  stopping: `<svg class="stopping-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4h8v8H4V4Z"/></svg>`,
}
const FILE_ICON =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.8h6l4 4V14H3V1.8Zm1.2 1.4v9.6h7.6V6.4H8.4V3.2H4.2Zm5.4.5v1.5h1.5L9.6 3.7Z"/></svg>`
const FOLDER_ICON =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 3h5l1.4 1.6h6V13h-12.4V3Zm1.3 1.3v7.4h9.8V5.9H7.6L6.2 4.3H3.1Z"/></svg>`
const COPY_ICON =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2h8v9h-2V9.8h.8V3.2H6.2V4H5V2Zm-2 3h8v9H3V5Zm1.2 1.2v6.6h5.6V6.2H4.2Z"/></svg>`
const EDIT_ICON =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m11.7 1.8 2.5 2.5-8.1 8.1-3.3.8.8-3.3 8.1-8.1Zm0 1.7-7 7-.3 1.1 1.1-.3 7-7-.8-.8Z"/></svg>`
const OPEN_ICON =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5h-1.3V4.2L7.4 9.5l-.9-.9 5.3-5.3H9V2ZM3.2 3.2h4.1v1.3H4.5v7h7V8.7h1.3v4.1H3.2V3.2Z"/></svg>`
const CHEVRON_DOWN_ICON =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.2 5.2 4.8 4.7 4.8-4.7.9.9L8 11.8 2.3 6.1l.9-.9Z"/></svg>`
type UnknownRecord = Record<string, unknown>
type Delegation = NonNullable<NonNullable<ChatSnapshot["session"]>["delegations"]>[number]
type Change = NonNullable<NonNullable<ChatSnapshot["session"]>["changes"]>[number]

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
  )
}

function showNotice(
  kind: "error" | "offline" | "projection",
  title: string,
  message: string,
  retryLabel?: string,
): void {
  noticeKind = kind
  noticeDetail = message
  notice.classList.toggle("offline", kind === "offline")
  notice.classList.toggle("projection", kind === "projection")
  noticeTitle.textContent = title
  noticeMessage.textContent = message
  noticeRetry.textContent = retryLabel ?? ""
  noticeRetry.hidden = !retryLabel
  noticeLogs.hidden = kind === "projection"
  notice.hidden = false
}

function clearNotice(kind?: "error" | "offline" | "projection"): void {
  if (kind && noticeKind !== kind) return
  noticeKind = undefined
  noticeDetail = ""
  notice.hidden = true
}

function projectionSignature(): string {
  return snapshot.projection ? JSON.stringify([snapshot.projection.limitBytes, snapshot.projection.omitted]) : ""
}

function syncProjectionNotice(connectionUnavailable: boolean): void {
  const projection = snapshot.projection
  if (!projection) {
    dismissedProjectionSignature = ""
    clearNotice("projection")
    return
  }
  if (connectionUnavailable || noticeKind === "error" || dismissedProjectionSignature === projectionSignature()) return
  const labels: Record<keyof typeof projection.omitted, string> = {
    sessions: "sessions",
    lineage: "session lineage entries",
    messages: "messages",
    delegations: "delegated tasks",
    queuedPrompts: "queued prompts",
    permissions: "permission requests",
    questions: "questions",
    todos: "todos",
    changes: "changes",
    contextReceipts: "context receipts",
    catalogItems: "catalog entries",
    runtimeServices: "runtime services",
    ptys: "terminal jobs",
    attentionItems: "attention items",
    runGroups: "run groups",
    worktrees: "worktrees",
    walkthroughs: "walkthroughs",
    walkthroughStops: "walkthrough steps",
    taskArtifacts: "task artifacts",
    reviewFindings: "review findings",
    evidence: "evidence records",
    runComparisons: "run comparisons",
  }
  const hidden = Object.entries(projection.omitted).map(([key, count]) =>
    `${count} ${labels[key as keyof typeof projection.omitted]}`
  ).join(", ")
  const size = (projection.encodedBytes / (1024 * 1024)).toFixed(1)
  const limit = (projection.limitBytes / (1024 * 1024)).toFixed(0)
  showNotice(
    "projection",
    "Some Workbench history is hidden",
    `${projection.message} Hidden: ${hidden}. This view uses ${size} MiB of its ${limit} MiB budget.`,
  )
}

function fileTooltip(reference: string | NonNullable<ReturnType<typeof fileReference>>): string {
  const file = typeof reference === "string" ? reference : reference.file
  const suffix = typeof reference === "string" || !reference.line
    ? ""
    : `:${reference.line}${reference.column ? `:${reference.column}` : ""}${
      reference.endLine ? `-${reference.endLine}${reference.endColumn ? `:${reference.endColumn}` : ""}` : ""
    }`
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(file)) return `${file}${suffix}`
  const directory = snapshot.session?.directory?.replace(/[\\/]$/, "")
  return `${directory ? `${directory}/${file}` : file}${suffix}`
}

function fileName(file: string): string {
  return file.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || file
}

function fileButton(
  reference: NonNullable<ReturnType<typeof fileReference>>,
  label = fileName(reference.file),
): string {
  return `<button type="button" class="inline-file" title="${escapeHtml(fileTooltip(reference))}" data-file="${
    escapeHtml(reference.file)
  }"${reference.line ? ` data-line="${reference.line}"` : ""}${
    reference.column ? ` data-column="${reference.column}"` : ""
  }${reference.endLine ? ` data-end-line="${reference.endLine}"` : ""}${
    reference.endColumn ? ` data-end-column="${reference.endColumn}"` : ""
  }>${FILE_ICON}<span>${escapeHtml(label)}</span></button>`
}

function codeBlock(content: string, language = "", extraClass = ""): string {
  return `<div class="code-block${extraClass ? ` ${extraClass}` : ""}"><div class="code-block-header"><span>${
    escapeHtml(language)
  }</span><button type="button" class="copy-block" data-copy-block title="Copy code" aria-label="Copy code">${COPY_ICON}</button></div><pre><code${
    language ? ` data-language="${escapeHtml(language)}"` : ""
  }>${escapeHtml(content)}</code></pre></div>`
}

function shellBlock(content: string, kind: "command" | "output" | "error"): string {
  const label = kind === "command" ? "Command" : kind === "output" ? "Output" : "Error"
  const clean = stripTerminalSequences(content)
  const markup = kind === "command" ? escapeHtml(clean) : terminalAnsiMarkup(content)
  return `<div class="code-block shell-block shell-${kind}"><div class="code-block-header"><span>${label}</span><button type="button" class="copy-block" data-copy-block title="Copy ${label.toLowerCase()}" aria-label="Copy ${label.toLowerCase()}">${COPY_ICON}</button></div><pre aria-label="${label}"><code class="terminal-ansi">${markup}</code></pre></div>`
}

function markdown(source: string): string {
  return renderMarkdown(source, {
    fencedCode: codeBlock,
    inlineCode: (content) => {
      const reference = fileReference(content)
      return reference ? fileButton(reference) : undefined
    },
    link: (url, title) => `<a href="#" data-url="${escapeHtml(url)}" title="${escapeHtml(title)}">`,
    workspaceMention: (value) => {
      const reference = workspaceMentionReference(value)
      return reference ? fileButton(reference, `@${value}`) : undefined
    },
  })
}

function stringify(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return "The value could not be displayed."
  }
}

function stateRecord(part: MessagePart): UnknownRecord | undefined {
  return record(part.state) ? part.state : undefined
}

function completed(part: MessagePart): boolean {
  return ["completed", "complete", "success"].includes(String(part.state?.status).toLowerCase())
}

function fieldLabel(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (value) => value.toUpperCase())
}

function structuredDisplayValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (trimmed.length > 1_000_000 || (!trimmed.startsWith("[") && !trimmed.startsWith("{"))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function friendlyValueHtml(value: unknown, depth = 0): string {
  const structured = structuredDisplayValue(value)
  if (structured === undefined || structured === null || structured === "") {
    return `<span class="tool-value-empty">None</span>`
  }
  if (typeof structured === "boolean") return `<span class="tool-value-badge">${structured ? "Yes" : "No"}</span>`
  if (typeof structured === "number" || typeof structured === "bigint") {
    return `<span class="tool-value-text">${escapeHtml(String(structured))}</span>`
  }
  if (typeof structured === "string") {
    if (structured.includes("\n") || structured.length > 240) return codeBlock(structured, "", "tool-value-block")
    return `<span class="tool-value-text">${escapeHtml(structured)}</span>`
  }
  if (depth >= 3) return codeBlock(stringify(structured), "", "tool-value-block")
  if (Array.isArray(structured)) {
    if (!structured.length) return `<span class="tool-value-empty">None</span>`
    return `<ul class="tool-value-list">${
      structured.slice(0, 100).map((item) => `<li>${friendlyValueHtml(item, depth + 1)}</li>`).join("")
    }${structured.length > 100 ? `<li class="tool-value-empty">${structured.length - 100} more items</li>` : ""}</ul>`
  }
  if (record(structured)) {
    const entries = Object.entries(structured)
    if (!entries.length) return `<span class="tool-value-empty">None</span>`
    return `<dl class="tool-properties">${
      entries.slice(0, 100).map(([key, item]) =>
        `<div><dt>${escapeHtml(fieldLabel(key))}</dt><dd>${friendlyValueHtml(item, depth + 1)}</dd></div>`
      ).join("")
    }${entries.length > 100 ? `<div><dt>More</dt><dd>${entries.length - 100} additional fields</dd></div>` : ""}</dl>`
  }
  return `<span class="tool-value-text">${escapeHtml(String(structured))}</span>`
}

function detailFields(value: UnknownRecord, excluded: ReadonlySet<string> = new Set()): string {
  const entries = Object.entries(value).filter(([key]) => !excluded.has(key))
  return entries.length
    ? `<dl class="tool-properties tool-input-fields">${
      entries.map(([key, item]) =>
        `<div><dt>${escapeHtml(fieldLabel(key))}</dt><dd>${friendlyValueHtml(item, 1)}</dd></div>`
      ).join("")
    }</dl>`
    : ""
}

const CHAT_DEBUG_FIELDS = new Set([
  "timeout",
  "timeoutMilliseconds",
  "maxCharacters",
  "maxChars",
  "limit",
  "offset",
  "preview",
  "scope",
  "extractImages",
  "engine",
  "requestID",
  "mutationID",
  "expectedGeneration",
  "expectedSettlementGeneration",
])

function detailFieldsForChat(value: UnknownRecord, visible: readonly string[]): string {
  const allowed = new Set(visible)
  const fields = Object.fromEntries(
    Object.entries(value).filter(([key]) => allowed.has(key) && !CHAT_DEBUG_FIELDS.has(key)),
  )
  return detailFields(fields)
}

function conciseResultHtml(value: unknown, label: string): string {
  const structured = structuredDisplayValue(value)
  if (structured === undefined || structured === null || structured === "") return ""
  if (Array.isArray(structured)) {
    return `<p class="tool-result-summary">${structured.length.toLocaleString()} ${escapeHtml(label)}${
      structured.length === 1 ? "" : "s"
    }</p>`
  }
  if (record(structured)) {
    const entries = Object.entries(structured)
    if (!entries.length) return ""
    return `<p class="tool-result-summary">${entries.length.toLocaleString()} ${escapeHtml(label)}${
      entries.length === 1 ? "" : "s"
    }</p>`
  }
  if (typeof structured === "string") {
    const trimmed = structured.trim()
    if (!trimmed || trimmed === "null") return ""
    return `<p class="tool-result-summary">${escapeHtml(trimmed.slice(0, 240))}${trimmed.length > 240 ? "…" : ""}</p>`
  }
  return `<p class="tool-result-summary">${escapeHtml(String(structured))}</p>`
}

function conciseReadResultHtml(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return ""
  const lines = value.split(/\r?\n/).length
  return `<p class="tool-result-summary">Read ${lines.toLocaleString()} line${lines === 1 ? "" : "s"}</p>`
}

function ordinaryToolDetailBody(part: MessagePart, state: UnknownRecord, input?: UnknownRecord): string | undefined {
  const kind = toolKind(part)
  const name = (part.tool ?? "").toLowerCase()
  const error = state.error === undefined || state.error === ""
    ? ""
    : codeBlock(stringify(state.error), "Error", "tool-error-block")
  if (kind === "skill") return error
  if (kind === "explore") {
    const visible = name === "read" ? ["filePath"] : ["path", "pattern", "query", "include"]
    const request = input ? detailFieldsForChat(input, visible) : ""
    const result = name === "read" ? conciseReadResultHtml(state.output) : conciseResultHtml(state.output, "result")
    return `${request}${result}${error}`
  }
  if (kind === "web") {
    const request = input ? detailFieldsForChat(input, ["url", "query", "format"]) : ""
    return `${request}${conciseResultHtml(state.output, "result")}${error}`
  }
  if (kind === "lsp") {
    const request = input ? detailFieldsForChat(input, ["uri", "filePath", "line", "column"]) : ""
    return `${request}${conciseResultHtml(state.output, "result")}${error}`
  }
  if (kind === "document") {
    const request = input ? detailFieldsForChat(input, ["filePath"]) : ""
    return `${request}${conciseResultHtml(state.output, "result")}${error}`
  }
  return undefined
}

function vscodeDetailBody(part: MessagePart, state: UnknownRecord, input?: UnknownRecord): string {
  const name = (part.tool ?? "").toLowerCase()
  const kind = toolKind(part)
  const errors = state.error === undefined || state.error === ""
    ? ""
    : codeBlock(stringify(state.error), "Error", "tool-error-block")
  if (kind === "vscodeContext") {
    const visible = name === "vscode_get_diagnostics" ? ["uri"] : []
    const request = input ? detailFieldsForChat(input, visible) : ""
    const result = name === "vscode_get_active_buffer"
      ? state.output === undefined || state.output === null
        ? ""
        : `<p class="tool-result-summary">Editor context captured</p>`
      : name === "vscode_get_selection"
      ? state.output === undefined || state.output === null
        ? ""
        : `<p class="tool-result-summary">Selection captured</p>`
      : name === "vscode_get_debug_context"
      ? state.output === undefined || state.output === null
        ? ""
        : `<p class="tool-result-summary">Debug context captured</p>`
      : conciseResultHtml(
        state.output,
        name.includes("diagnostics") ? "diagnostic" : name.includes("tasks") ? "task" : "editor",
      )
    return `${request}${result}${errors}`
  }
  if (kind === "vscodeLanguage") {
    const visible = name === "vscode_preview_rename"
      ? ["uri", "line", "column", "newName"]
      : name === "vscode_get_code_actions"
      ? ["uri", "startLine", "endLine"]
      : ["uri", "line", "column"]
    const request = input ? detailFieldsForChat(input, visible) : ""
    const result = conciseResultHtml(state.output, name.includes("symbols") ? "symbol" : "result")
    return `${request}${result}${errors}`
  }
  const visible = name === "vscode_execute_terminal"
    ? ["executable", "args"]
    : name === "vscode_run_task"
    ? ["name", "source"]
    : name === "vscode_open_file"
    ? ["path", "line", "column"]
    : name === "vscode_open_url"
    ? ["url"]
    : name === "vscode_request_opencode_reload"
    ? ["reason"]
    : []
  const request = input ? detailFieldsForChat(input, visible) : ""
  const result = errors || !["vscode_execute_terminal", "vscode_run_task"].includes(name)
    ? ""
    : conciseResultHtml(state.output, "result")
  return `${request}${result}${errors}`
}

function memoryDetailBody(part: MessagePart, state: UnknownRecord, input?: UnknownRecord): string {
  const name = (part.tool ?? "").toLowerCase()
  const visible = name === "memory_propose"
    ? ["scope", "category", "key", "value"]
    : name === "memory_approve"
    ? ["decision"]
    : name === "skill_candidate_propose"
    ? ["scope", "name", "rationale"]
    : name.endsWith("_list")
    ? ["query", "category", "status", "scope"]
    : []
  const request = input ? detailFieldsForChat(input, visible) : ""
  const result = conciseResultHtml(state.output, name.endsWith("_list") ? "record" : "result")
  const error = state.error === undefined || state.error === ""
    ? ""
    : codeBlock(stringify(state.error), "Error", "tool-error-block")
  return `${request}${result}${error}`
}

function todoDetailBody(part: MessagePart): string {
  const todos = presentedTodos(part)
  if (!todos.length) return ""
  const icon = (status: string): string => {
    const normalized = status.toLowerCase().replace(/[ -]+/g, "_")
    if (["completed", "complete", "done", "success"].includes(normalized)) return "✓"
    if (["in_progress", "running", "active"].includes(normalized)) return "●"
    if (["cancelled", "canceled", "stopped"].includes(normalized)) return "×"
    return "○"
  }
  return `<div class="tool-detail todo-detail"><ul class="tool-todo-list">${
    todos.map((todo) => {
      const status = fieldLabel(todo.status)
      return `<li><span class="tool-todo-status" title="${escapeHtml(status)}" aria-label="${escapeHtml(status)}">${
        icon(todo.status)
      }</span><span class="tool-todo-content">${escapeHtml(todo.content)}</span>${
        todo.priority ? `<span class="tool-todo-priority">${escapeHtml(todo.priority)}</span>` : ""
      }</li>`
    }).join("")
  }</ul></div>`
}

function toolOutputLabel(part: MessagePart): string {
  const name = (part.tool ?? "").toLowerCase()
  if (name === "read") return "Contents"
  if (["glob", "grep", "list", "codesearch", "websearch", "web_search"].includes(name)) return "Results"
  if (["webfetch", "web_fetch"].includes(name)) return "Response"
  if (toolKind(part) === "lsp") return "Language server response"
  if (toolKind(part) === "goal") return "Goal"
  if (toolKind(part) === "question") return "Answer"
  if (toolKind(part) === "skill") return "Loaded instructions"
  return "Result"
}

function detailBody(part: MessagePart): string {
  const state = stateRecord(part)
  if (!state) return ""
  if (toolKind(part) === "todo") {
    const todos = todoDetailBody(part)
    if (todos) return todos
  }
  const input = record(state.input) ? state.input : undefined
  const kind = toolKind(part)
  const ordinary = ordinaryToolDetailBody(part, state, input)
  if (ordinary !== undefined) {
    return ordinary ? `<div class="tool-detail tool-detail-compact">${ordinary}</div>` : ""
  }
  if (["vscodeContext", "vscodeLanguage", "vscodeAction"].includes(kind)) {
    const body = vscodeDetailBody(part, state, input)
    return body ? `<div class="tool-detail tool-detail-compact">${body}</div>` : ""
  }
  if (kind === "memory" || kind === "skillCandidate") {
    const body = memoryDetailBody(part, state, input)
    return body ? `<div class="tool-detail tool-detail-compact">${body}</div>` : ""
  }
  const command = toolKind(part) === "bash" && typeof input?.command === "string" ? input.command : undefined
  if (command) {
    const outputText = state.output === undefined || state.output === ""
      ? ""
      : shellOutputWithoutCommandEcho(command, stringify(state.output))
    const output = outputText ? shellBlock(outputText, "output") : ""
    const error = state.error === undefined || state.error === "" ? "" : shellBlock(stringify(state.error), "error")
    const body = `${output}${error}`
    return body ? `<div class="tool-detail shell-detail">${body}</div>` : ""
  }
  const inputBody = input
    ? detailFields(input, CHAT_DEBUG_FIELDS)
    : state.input === undefined
    ? ""
    : `<section class="tool-value-section"><h4>Request</h4>${friendlyValueHtml(state.input)}</section>`
  const parsedOutput = structuredDisplayValue(state.output)
  const duplicateOutput = state.output !== undefined &&
    stringify(parsedOutput) === stringify(structuredDisplayValue(state.input))
  const output = state.output === undefined || state.output === "" || duplicateOutput
    ? ""
    : `<section class="tool-value-section"><h4>${escapeHtml(toolOutputLabel(part))}</h4>${
      friendlyValueHtml(parsedOutput)
    }</section>`
  const error = state.error === undefined || state.error === ""
    ? ""
    : codeBlock(stringify(state.error), "Error", "tool-error-block")
  const body = `${inputBody}${output}${error}`
  return body ? `<div class="tool-detail">${body}</div>` : ""
}

function toolSubject(part: MessagePart): string {
  const state = stateRecord(part)
  const input = record(state?.input) ? state.input : undefined
  const metadata = record(state?.metadata) ? state.metadata : undefined
  const subject = input?.filePath ?? input?.path ?? input?.uri ?? input?.pattern ?? input?.name ?? input?.query ??
    input?.reason ?? metadata?.name ?? part.state?.title
  return typeof subject === "string" ? subject : ""
}

function toolLabel(part: MessagePart, state = String(part.state?.status || "pending").toLowerCase()): string {
  const subject = toolSubject(part)
  const kind = toolKind(part)
  const patch = kind === "patch" || kind === "edit" && part.tool === "apply_patch"
  if (kind === "bash") {
    const details = stateRecord(part)
    const input = record(details?.input) ? details.input : undefined
    const command = typeof input?.command === "string" ? input.command.replace(/\s+/g, " ").trim().slice(0, 500) : ""
    const label = commandActivityLabel(state)
    return command ? `${label}: ${command}` : label
  }
  const stateful = (running: string, completed: string, failed: string, stopped: string): string => {
    if (["pending", "running", "in_progress", "in-progress", "active"].includes(state)) return running
    if (["error", "failed", "rejected"].includes(state)) return failed
    return state === "stopped" ? stopped : completed
  }
  const name = (part.tool ?? "").toLowerCase()
  let label: string
  if (kind === "explore") {
    if (name === "read") label = stateful("Reading file", "Read file", "Failed to read file", "Stopped reading file")
    else if (["glob", "list"].includes(name)) {
      label = stateful("Listing files", "Listed files", "Failed to list files", "Stopped listing files")
    } else label = stateful("Searching files", "Searched files", "Failed to search files", "Stopped searching files")
  } else if (kind === "todo") {
    label = name.includes("read")
      ? stateful("Reading todos", "Read todos", "Failed to read todos", "Stopped reading todos")
      : stateful("Updating todos", "Updated todos", "Failed to update todos", "Stopped updating todos")
  } else if (kind === "web") {
    label = name.includes("search")
      ? stateful("Searching the web", "Searched the web", "Web search failed", "Stopped web search")
      : stateful("Fetching page", "Fetched page", "Failed to fetch page", "Stopped fetching page")
  } else if (kind === "lsp") {
    label = stateful(
      "Querying language server",
      "Queried language server",
      "Language server query failed",
      "Stopped language server query",
    )
  } else if (kind === "goal") {
    label = name.startsWith("get_")
      ? stateful("Reading goal", "Read goal", "Failed to read goal", "Stopped reading goal")
      : stateful("Updating goal", "Updated goal", "Failed to update goal", "Stopped updating goal")
  } else if (kind === "question") {
    label = stateful("Asking question", "Asked question", "Question failed", "Stopped question")
  } else if (kind === "vscodeContext") {
    const action = name === "vscode_get_active_buffer"
      ? "active editor context"
      : name === "vscode_get_selection"
      ? "editor selection"
      : name === "vscode_list_open_editors"
      ? "open editors"
      : name === "vscode_get_diagnostics"
      ? "diagnostics"
      : name === "vscode_get_debug_context"
      ? "debug context"
      : "VS Code tasks"
    label = stateful(`Reading ${action}`, `Read ${action}`, `Failed to read ${action}`, `Stopped reading ${action}`)
  } else if (kind === "vscodeLanguage") {
    label = stateful(
      "Querying VS Code language tools",
      "Queried VS Code language tools",
      "VS Code language query failed",
      "Stopped VS Code language query",
    )
  } else if (kind === "vscodeAction") {
    const actions = name === "vscode_execute_terminal"
      ? ["Running terminal command", "Ran terminal command"]
      : name === "vscode_run_task"
      ? ["Running VS Code task", "Ran VS Code task"]
      : name === "vscode_open_file"
      ? ["Opening file", "Opened file"]
      : name === "vscode_open_url"
      ? ["Opening URL", "Opened URL"]
      : name === "vscode_request_opencode_reload"
      ? ["Scheduling OpenCode reload", "Scheduled OpenCode reload"]
      : ["Running VS Code action", "Ran VS Code action"]
    label = stateful(actions[0]!, actions[1]!, `${actions[0]} failed`, `Stopped ${actions[0]!.toLowerCase()}`)
  } else if (kind === "memory") {
    label = name === "memory_list"
      ? stateful("Reading preferences", "Read preferences", "Failed to read preferences", "Stopped reading preferences")
      : stateful(
        "Updating preferences",
        "Updated preferences",
        "Failed to update preferences",
        "Stopped updating preferences",
      )
  } else if (kind === "skillCandidate") {
    label = name.endsWith("_list")
      ? stateful(
        "Reading skill candidates",
        "Read skill candidates",
        "Failed to read skill candidates",
        "Stopped reading skill candidates",
      )
      : stateful(
        "Updating skill candidate",
        "Updated skill candidate",
        "Failed to update skill candidate",
        "Stopped updating skill candidate",
      )
  } else if (kind === "document") {
    label = stateful("Reading document", "Read document", "Failed to read document", "Stopped reading document")
  } else {label = ({
      skill: stateful("Loading skill", "Loaded skill", "Failed to load skill", "Stopped loading skill"),
      edit: patch
        ? patchActivityLabel(state)
        : stateful("Editing file", "Edited file", "Failed to edit file", "Stopped editing file"),
      task: stateful("Delegating task", "Delegated task", "Failed to delegate task", "Stopped delegating task"),
      patch: patchActivityLabel(state),
      unknown: part.state?.title || part.tool || "Tool call",
    } as Partial<Record<typeof kind, string>>)[kind] ?? part.state?.title ?? part.tool ?? "Tool call"}
  return subject && !label.includes(subject) ? `${label}: ${subject}` : label
}

function matchingChange(file: string): Change | undefined {
  const normalized = file.replace(/\\/g, "/")
  return snapshot.session?.changes?.find((change) => {
    const candidate = change.file.replace(/\\/g, "/")
    return candidate === normalized || normalized.endsWith(`/${candidate}`) || candidate.endsWith(`/${normalized}`)
  })
}

function messageRenderDependency(message: MessageBundle): string {
  if (message.info.role !== "assistant") return ""
  const dependsOnChanges = message.parts.some((part) =>
    (part.type === "tool" && ["edit", "patch"].includes(toolKind(part))) ||
    ["patch", "apply_patch", "edit", "write"].includes(part.type)
  )
  return dependsOnChanges ? JSON.stringify(snapshot.session?.changes ?? []) : ""
}

function editPatch(part: MessagePart): string {
  const state = stateRecord(part)
  const input = record(state?.input) ? state.input : undefined
  const candidates = [input?.patchText, input?.patch, input?.diff, state?.output]
  return candidates.find((value) =>
    typeof value === "string" &&
    (/^\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/m.test(value) || /^@@/m.test(value))
  ) as string | undefined ?? ""
}

function diffStats(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

function diffMarkup(patch: string): string {
  let oldLine: number | undefined
  let newLine: number | undefined
  const showLineNumbers = diffHasLineNumbers(patch)
  return patch.split("\n").map((line) => {
    const kind = diffLineKind(line)
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
    }
    const oldNumber = kind === "add" || kind === "hunk" || kind === "meta" ? "" : oldLine
    const newNumber = kind === "remove" || kind === "hunk" || kind === "meta" ? "" : newLine
    if (kind === "add" && newLine !== undefined) newLine += 1
    else if (kind === "remove" && oldLine !== undefined) oldLine += 1
    else if (kind === "context") {
      if (oldLine !== undefined) oldLine += 1
      if (newLine !== undefined) newLine += 1
    }
    const marker = kind === "add" ? "+" : kind === "remove" ? "−" : " "
    const code = kind === "add" || kind === "remove" ? line.slice(1) : line
    const lineNumbers = showLineNumbers
      ? `<span class="diff-line-number" aria-hidden="true">${
        oldNumber ?? ""
      }</span><span class="diff-line-number" aria-hidden="true">${newNumber ?? ""}</span>`
      : ""
    return `<span class="diff-line diff-${kind}">${lineNumbers}<span class="diff-line-marker" aria-hidden="true">${marker}</span><span class="diff-line-code">${
      escapeHtml(code || " ")
    }</span></span>`
  }).join("")
}

function normalizedReviewPath(value: string): string {
  const source = value.replaceAll("\\", "/")
  const drive = /^[A-Za-z]:/.exec(source)?.[0] ?? ""
  const absolute = Boolean(drive || source.startsWith("/"))
  const parts: string[] = []
  for (const part of source.slice(drive.length).split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `${drive}${absolute ? "/" : ""}${parts.join("/")}`
}

function patchReviewScope(file?: string): "workspace" | "external" | undefined {
  if (!file) return undefined
  const reported = matchingChange(file)?.reviewScope
  if (reported) return reported
  const workspace = snapshot.workspaceDirectory &&
    normalizedReviewPath(snapshot.workspaceDirectory)
  const directory = snapshot.session?.directory &&
    normalizedReviewPath(snapshot.session.directory)
  if (!workspace || !directory) return "external"
  const normalizedFile = normalizedReviewPath(file)
  const absolute = normalizedFile.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedFile)
  const candidate = absolute ? normalizedFile : normalizedReviewPath(`${directory}/${file}`)
  const insensitive = /^[A-Za-z]:/.test(workspace)
  const root = insensitive ? workspace.toLocaleLowerCase() : workspace
  const target = insensitive ? candidate.toLocaleLowerCase() : candidate
  return target.startsWith(`${root.replace(/\/$/, "")}/`) ? "workspace" : "external"
}

function editPatchBlock(patch: string, file?: string, source: {
  messageID?: string
  partID?: string
  requestID?: string
  sessionID?: string
} = {}, reviewScope = patchReviewScope(file)): string {
  const preview = patch.length > 50_000
    ? `${patch.slice(0, 50_000)}\n\n[Preview truncated; open the patch for complete output.]`
    : patch
  const sourceAttributes = `${source.messageID ? ` data-patch-message="${escapeHtml(source.messageID)}"` : ""}${
    source.partID ? ` data-patch-part="${escapeHtml(source.partID)}"` : ""
  }${source.requestID ? ` data-patch-request="${escapeHtml(source.requestID)}"` : ""}${
    source.sessionID ? ` data-patch-session="${escapeHtml(source.sessionID)}"` : ""
  }`
  const action = reviewScope === "external"
    ? `<span class="edit-patch-unavailable" title="${
      escapeHtml(`${fileTooltip(file!)} — file not in the current workspace`)
    }">File not in workspace</span>`
    : `<button type="button" data-open-patch="${escapeHtml(file ?? "")}"${sourceAttributes}>Review change</button>`
  const open = file ? `<div class="edit-patch-actions">${action}</div>` : ""
  return `<div class="code-block diff-block edit-patch-block"><button type="button" class="copy-block" data-copy-block title="Copy diff" aria-label="Copy diff">${COPY_ICON}</button><pre><code>${
    diffMarkup(preview)
  }</code></pre>${open}</div>`
}

interface EditEntry {
  file: string
  patch: string
  additions: number
  deletions: number
  key: string
  state: string
  messageID?: string
  partID?: string
  reviewScope?: "workspace" | "external"
}

function editEntries(part: MessagePart, key: string): EditEntry[] {
  const patch = editPatch(part)
  const subject = toolSubject(part)
  const files = applyPatchFiles(patch)
  if (!files.length && Array.isArray(part.files)) {
    files.push(...part.files.filter((file): file is string => typeof file === "string").slice(0, 100))
  }
  if (!files.length && subject) files.push(subject)
  return files.map((file, index) => {
    const change = completed(part) ? matchingChange(file) : undefined
    const detail = change?.patch || applyPatchSection(patch, file)
    const stats = change ?? diffStats(detail)
    const resolvedFile = change?.file || file
    return {
      file: resolvedFile,
      patch: detail,
      additions: stats.additions,
      deletions: stats.deletions,
      key: `${key}:${index}`,
      state: String(part.state?.status ?? "completed"),
      messageID: change ? undefined : part.messageID,
      partID: change ? undefined : part.id,
      reviewScope: change?.reviewScope ?? patchReviewScope(resolvedFile),
    }
  })
}

function editEntryHtml(entry: EditEntry): string {
  const stats = `<span class="edit-stats"><b>+${entry.additions}</b> <i>−${entry.deletions}</i></span>`
  const openLabel = `Open ${fileName(entry.file)} in VS Code`
  const failed = ["error", "failed", "rejected"].includes(
    entry.state.toLowerCase(),
  )
  const status = failed ? `<span class="activity-status">Failed</span>` : ""
  const source = `${entry.messageID ? ` data-file-message="${escapeHtml(entry.messageID)}"` : ""}${
    entry.partID ? ` data-file-part="${escapeHtml(entry.partID)}"` : ""
  }`
  return `<details class="edit-entry${failed ? " tool-error" : ""}" data-detail-key="${
    escapeHtml(entry.key)
  }"><summary>${EDIT_ICON}<button type="button" class="edit-file" data-file="${
    escapeHtml(entry.file)
  }"${source} title="${escapeHtml(openLabel)}" aria-label="${escapeHtml(openLabel)}">${
    escapeHtml(fileName(entry.file))
  }</button>${stats}${status}</summary>${
    entry.patch
      ? editPatchBlock(entry.patch, entry.file, {
        messageID: entry.messageID,
        partID: entry.partID,
      }, entry.reviewScope)
      : `<p class="placeholder">No patch preview available.</p>`
  }</details>`
}

function groupedEditsHtml(parts: MessagePart[], key: string, active: boolean): string {
  const entries = parts.flatMap((part, index) => editEntries(part, `${key}:${index}`))
  if (!entries.length) return parts.map((part, index) => toolHtml(part, `${key}:${index}`, active, false)).join("")
  if (entries.length === 1) return editEntryHtml(entries[0]!)
  return `<details class="activity edit-group" data-detail-key="${
    escapeHtml(key)
  }"><summary>${EDIT_ICON}<span class="activity-title">Edited files</span></summary><div class="edit-list">${
    entries.map(editEntryHtml).join("")
  }</div></details>`
}

function activityMetaHtml(part: MessagePart, state: string): string {
  const start = partTime(part, "start")
  const end = partTime(part, "end")
  const failed = ["error", "failed", "rejected"].includes(state)
  if (failed) return `<span class="activity-status">Failed</span>`
  if (state === "stopped") return `<span class="activity-status">Stopped</span>`
  if (start !== undefined && end !== undefined) {
    return `<span class="activity-status">${escapeHtml(formatDuration(Math.max(0, end - start)))}</span>`
  }
  if (start !== undefined && ["running", "pending"].includes(state)) {
    return `<span class="activity-status"><span class="activity-timer" data-start-time="${start}">${
      formatDuration(Math.max(0, Date.now() - start))
    }</span></span>`
  }
  return ""
}

interface DelegationAction {
  label: string
  detail: string
  state: string
  kind: "reasoning" | "tool" | "output"
  tool?: MessagePart
}

function delegationActions(delegation: Delegation): DelegationAction[] {
  const actions: DelegationAction[] = []
  for (const message of delegation.messages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.synthetic || part.type === "step-start" || part.type === "step-finish") continue
      if (part.type === "reasoning" && part.text?.trim()) {
        actions.push({
          label: `Thought: ${reasoningSummary(part.text) || "Reasoning"}`,
          detail: `<div class="markdown">${markdown(part.text)}</div>`,
          state: "completed",
          kind: "reasoning",
        })
      } else if (part.type === "tool") {
        const state = String(part.state?.status || "pending").toLowerCase()
        actions.push({ label: toolLabel(part, state), detail: detailBody(part), state, kind: "tool", tool: part })
      } else if (part.type === "text" && part.text?.trim()) {
        actions.push({
          label: "Assistant output",
          detail: `<div class="markdown">${markdown(part.text)}</div>`,
          state: "completed",
          kind: "output",
        })
      }
    }
  }
  return actions.slice(-300)
}

function delegationActionHtml(action: DelegationAction, key: string, active: boolean): string {
  const visualState = activityVisualState(action.state, active)
  const failed = ["error", "failed", "rejected"].includes(visualState)
  const state = failed ? "error" : ["running", "pending", "stopped"].includes(visualState) ? visualState : "completed"
  const label = action.tool ? toolLabel(action.tool, visualState) : action.label
  const summary = `<span class="activity-dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`
  return action.detail
    ? `<details class="delegation-action tool-${state}" data-detail-key="${
      escapeHtml(key)
    }"><summary>${summary}</summary>${action.detail}</details>`
    : `<div class="delegation-action delegation-action-static tool-${state}">${summary}</div>`
}

function delegationRequestHtml(part: MessagePart, key: string): string {
  const state = stateRecord(part)
  const input = record(state?.input) ? state.input : undefined
  if (!input) return ""
  const fields = detailFieldsForChat(input, ["description", "subagent_type", "agent", "model"])
  if (!fields) return ""
  return `<details class="delegation-raw" data-detail-key="${
    escapeHtml(`${key}:request`)
  }"><summary>Task details</summary><div class="delegation-request-body">${fields}</div></details>`
}

function delegationHtml(part: MessagePart, key: string, delegation: Delegation, parentActive: boolean): string {
  const state = delegation.status.type === "busy" || delegation.status.type === "retry"
    ? activityVisualState("running", parentActive)
    : delegation.status.type === "error"
    ? "error"
    : "completed"
  const actions = delegationActions(delegation)
  const recent = actions.slice(-4)
  const latest = actions.at(-1)
  const current = actions.slice().reverse().find((action) => ["running", "pending"].includes(action.state)) ?? latest
  const request = delegationRequestHtml(part, key)
  const active = state === "running"
  const completion = delegationCompletionSummary(actions, state === "error")
  const progress = active
    ? current?.label ?? "Starting subagent…"
    : state === "stopped"
    ? completion === "Completed" ? "Stopped" : `Stopped · ${completion}`
    : completion
  return `<details class="activity delegation tool-${state}" data-detail-key="${escapeHtml(key)}">
    <summary><span class="activity-dot" aria-hidden="true"></span><span class="delegation-summary"><span class="activity-title">${
    escapeHtml(delegation.title)
  }</span><span class="delegation-progress"><span>${escapeHtml(progress)}</span>${
    activityMetaHtml(part, state)
  }</span></span></summary>
    <div class="delegation-body">
      ${
    recent.length
      ? `<div class="delegation-recent"><div class="picker-heading">Recent activity</div>${
        recent.map((action, index) =>
          delegationActionHtml(action, `${key}:recent:${actions.length - recent.length + index}`, active)
        ).join("")
      }</div>`
      : `<p class="placeholder">Waiting for delegated activity.</p>`
  }
      ${
    actions.length > recent.length
      ? `<details class="delegation-history" data-detail-key="${
        escapeHtml(`${key}:history`)
      }"><summary>All activity (${actions.length})</summary><div>${
        actions.map((action, index) => delegationActionHtml(action, `${key}:history:${index}`, active)).join("")
      }</div></details>`
      : ""
  }
      ${request}
      <button type="button" class="text-action delegated-session-action" data-delegation-session="${
    escapeHtml(delegation.sessionID)
  }"><span>Open delegated session</span>${OPEN_ICON}</button>
    </div>
  </details>`
}

function toolHtml(part: MessagePart, key: string, active: boolean, specialize = true): string {
  const state = activityVisualState(String(part.state?.status || "pending"), active)
  const delegation = part.tool === "task"
    ? snapshot.session?.delegations?.find((item) => item.partID === part.id)
    : undefined
  if (delegation) return delegationHtml(part, key, delegation, active)
  if (specialize && ["edit", "patch"].includes(toolKind(part))) return groupedEditsHtml([part], key, active)
  const detail = detailBody(part)
  const summary = `<span class="activity-dot" aria-hidden="true"></span><span class="activity-title">${
    escapeHtml(toolLabel(part, state))
  }</span>${activityMetaHtml(part, state)}`
  return detail
    ? `<details class="activity tool-${escapeHtml(state)}" data-detail-key="${
      escapeHtml(key)
    }"><summary>${summary}</summary>${detail}</details>`
    : `<div class="activity activity-static tool-${escapeHtml(state)}">${summary}</div>`
}

function groupedToolsHtml(parts: MessagePart[], kind: "skill" | "explore", key: string): string {
  const title = kind === "skill"
    ? `Loaded ${parts.length} skill${parts.length === 1 ? "" : "s"}`
    : `Explored ${parts.length} item${parts.length === 1 ? "" : "s"}`
  const lines = parts.map((part) => toolSubject(part) || part.state?.title || part.tool || "item")
  const starts = parts.map((part) => partTime(part, "start")).filter((value): value is number => value !== undefined)
  const ends = parts.map((part) => partTime(part, "end")).filter((value): value is number => value !== undefined)
  const timing = starts.length && ends.length
    ? formatDuration(Math.max(0, Math.max(...ends) - Math.min(...starts)))
    : ""
  return `<details class="activity compact-activity" data-detail-key="${
    escapeHtml(key)
  }"><summary><span class="activity-dot" aria-hidden="true"></span><span class="activity-title">${
    escapeHtml(title)
  }</span>${timing ? `<span class="activity-status">${escapeHtml(timing)}</span>` : ""}</summary><pre>${
    escapeHtml(lines.join("\n"))
  }</pre></details>`
}

function partTime(part: MessagePart, key: "start" | "end"): number | undefined {
  const direct = record(part.time) ? part.time[key] : undefined
  const state = stateRecord(part)
  const stateTime = record(state?.time) ? state.time[key] : undefined
  const value = direct ?? stateTime
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function timingHtml(entries: Array<{ message: MessageBundle; live: boolean }>, working?: boolean): string {
  const assistants = entries.filter((entry) => entry.message.info.role === "assistant")
  if (!assistants.length) return ""
  const live = working ?? assistants.some((entry) => entry.live)
  const starts = assistants.flatMap(({ message }) => message.parts.map((part) => partTime(part, "start"))).filter((
    value,
  ): value is number => value !== undefined)
  const ends = assistants.flatMap(({ message }) => message.parts.map((part) => partTime(part, "end"))).filter((
    value,
  ): value is number => value !== undefined)
  const start = starts.length
    ? Math.min(...starts)
    : assistants.map((entry) => entry.message.info.time?.created).find((value): value is number =>
      typeof value === "number"
    )
  const end = ends.length
    ? Math.max(...ends)
    : assistants.map((entry) => entry.message.info.time?.completed).filter((value): value is number =>
      typeof value === "number"
    ).at(-1)
  if (typeof start !== "number") {
    return live ? `<span>Working</span><span class="activity-chevron" aria-hidden="true">›</span>` : ""
  }
  if (!live && typeof end !== "number") return ""
  const duration = Math.max(0, (typeof end === "number" ? end : Date.now()) - start)
  return `<span>${live ? "Working" : "Worked"} for ${
    formatDuration(duration)
  }</span><span class="activity-chevron" aria-hidden="true">›</span>`
}

function assistantHtml(message: MessageBundle, live: boolean, finalTextParts: ReadonlySet<string>): string {
  let processBody = ""
  let responseBody = ""
  const hasEditTool = message.parts.some((part) => part.type === "tool" && ["edit", "patch"].includes(toolKind(part)))
  for (let index = 0; index < message.parts.length; index += 1) {
    const part = message.parts[index]!
    if (part.synthetic) continue
    if (part.type === "text" && part.text) {
      const html = `<div class="markdown">${markdown(part.text)}</div>`
      if (finalTextParts.has(`${message.info.id}:${part.id}`)) responseBody += html
      else processBody += `<div class="assistant-update"><div class="assistant-update-label">Update</div>${html}</div>`
    } else if (part.type === "reasoning" && part.text?.trim()) {
      const grouped = [part]
      while (index + 1 < message.parts.length) {
        const next = message.parts[index + 1]!
        if (next.synthetic || next.type !== "reasoning" || !next.text?.trim()) break
        grouped.push(next)
        index += 1
      }
      const latestSummary = reasoningSummary(grouped.at(-1)!.text!)
      const trailing = live && !message.parts.slice(index + 1).some((candidate) => !candidate.synthetic)
      const label = grouped.length > 1 ? `Thoughts (${grouped.length})` : trailing ? "Thinking" : "Thought"
      const source = part.text.trim()
      const detail = reasoningDetail(source)
      const content = grouped.length > 1
        ? `<div class="reasoning-list">${
          grouped.map((item) => {
            const text = item.text!.trim()
            const itemDetail = reasoningDetail(text)
            return `<section><strong>${escapeHtml(reasoningSummary(text) || "Thought")}</strong>${
              itemDetail ? `<div class="markdown">${markdown(itemDetail)}</div>` : ""
            }</section>`
          }).join("")
        }</div>`
        : detail
      const detailed = grouped.length > 1 || Boolean(detail)
      processBody += !detailed
        ? `<div class="reasoning reasoning-static"><span>${label}:</span>${
          latestSummary ? `<span class="reasoning-summary">${escapeHtml(latestSummary)}</span>` : ""
        }</div>`
        : `<details class="reasoning${grouped.length > 1 ? " reasoning-group" : ""}" data-detail-key="${
          escapeHtml(`${message.info.id}:${part.id}`)
        }"${reasoningExpanded ? " open" : ""}><summary><span>${label}:</span>${
          latestSummary ? `<span class="reasoning-summary">${escapeHtml(latestSummary)}</span>` : ""
        }</summary>${
          grouped.length > 1 ? content : `<div class="markdown">${markdown(content as string)}</div>`
        }</details>`
    } else if (part.type === "tool") {
      const kind = toolKind(part)
      if ((kind === "edit" || kind === "patch") && completed(part)) {
        const grouped = [part]
        while (index + 1 < message.parts.length) {
          const next = message.parts[index + 1]!
          if (
            next.synthetic || next.type !== "tool" || !completed(next) || !["edit", "patch"].includes(toolKind(next))
          ) break
          grouped.push(next)
          index += 1
        }
        processBody += groupedEditsHtml(grouped, `${message.info.id}:${part.id}`, live)
      } else if (kind === "edit" || kind === "patch") {
        processBody += groupedEditsHtml(
          [part],
          `${message.info.id}:${part.id}`,
          live,
        )
      } else if ((kind === "skill" || kind === "explore") && completed(part)) {
        const grouped = [part]
        while (index + 1 < message.parts.length) {
          const next = message.parts[index + 1]!
          if (next.type !== "tool" || !completed(next) || toolKind(next) !== kind) break
          grouped.push(next)
          index += 1
        }
        processBody += groupedToolsHtml(grouped, kind, `${message.info.id}:${part.id}`)
      } else processBody += toolHtml(part, `${message.info.id}:${part.id}`, live)
    } else if (["patch", "apply_patch", "edit", "write", "todowrite", "task", "bash"].includes(part.type)) {
      if (part.type === "patch" && hasEditTool) continue
      processBody += toolHtml({ ...part, type: "tool", tool: part.type }, `${message.info.id}:${part.id}`, live)
    }
  }
  let error = ""
  if (message.info.error !== undefined) {
    error = `<pre class="message-error">${escapeHtml(stringify(message.info.error))}</pre>`
  }
  if (!processBody && !responseBody && live) processBody = `<span class="pending">Thinking</span>`
  const timestamp = message.info.time?.created
    ? new Date(message.info.time.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : ""
  const processOnly = processBody && !responseBody && !error ? " process-only" : ""
  const actions = !live && (responseBody || error) ? messageActions("assistant") : ""
  return `<article class="message assistant${processOnly}" data-message-id="${escapeHtml(message.info.id)}">${
    timestamp ? `<time class="message-time">${escapeHtml(timestamp)}</time>` : ""
  }<div class="content">${processBody ? `<div class="assistant-process">${processBody}</div>` : ""}${
    responseBody ? `<div class="assistant-response">${responseBody}</div>` : ""
  }${error}</div>${actions}</article>`
}

function messageActions(role: "user" | "assistant"): string {
  const action = (name: string, label: string, icon: string) =>
    `<button type="button" data-message-action="${name}" title="${label}" aria-label="${label}">${icon}</button>`
  const retry =
    `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.3 4V1.8h1.3v4.4H9.2V4.9h2.1A4.7 4.7 0 1 0 12.5 9h1.4A6.1 6.1 0 1 1 12.3 4Z"/></svg>`
  const fork =
    `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.8a2.2 2.2 0 1 1-1.3 4v2.1c0 .8.6 1.4 1.4 1.4h4.2V5.8a2.2 2.2 0 1 1 1.4 0v4.9H5.1a2.8 2.8 0 0 1-2.8-2.8V5.8A2.2 2.2 0 0 1 5 1.8Zm0 1.4a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Zm5 0a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6ZM10 10.2a2.2 2.2 0 1 1-.7 4.3 2.2 2.2 0 0 1 .7-4.3Zm0 1.4a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z"/></svg>`
  return `<div class="message-actions" aria-label="Message actions">${
    action("copy", role === "user" ? "Copy message" : "Copy response", COPY_ICON)
  }${role === "user" ? action("edit", "Edit message", EDIT_ICON) : action("retry", "Retry response", retry)}${
    action("fork", "Fork from this message", fork)
  }</div>`
}

function attachmentPreviewsFor(message: MessageBundle): SentAttachmentPreview[] {
  const existing = sentAttachmentPreviews.get(message.info.id)
  return existing?.attachments ?? []
}

function userHtml(message: MessageBundle): string {
  if (isCompactionMessage(message)) {
    return `<div class="compaction-divider" data-message-id="${
      escapeHtml(message.info.id)
    }" role="note"><span>Session compacted</span></div>`
  }
  if (isGoalContinuationMessage(message)) {
    return `<div class="compaction-divider goal-continuation-divider" data-message-id="${
      escapeHtml(message.info.id)
    }" role="note"><span>Goal continued automatically</span></div>`
  }
  if (isNativeCompactionContinuationMessage(message)) {
    return `<div class="native-compaction-continuation" data-message-id="${
      escapeHtml(message.info.id)
    }" aria-hidden="true" hidden></div>`
  }
  const textParts = message.parts.filter((part) => !part.synthetic && part.type === "text" && part.text)
  const text = textParts.map((part) => part.text).join("\n")
  const body = textParts.map((part) => `<div class="markdown">${markdown(part.text!)}</div>`).join("")
  const previews = attachmentPreviewsFor(message)
  const files = message.parts.filter((part) => part.type === "file" && typeof part.filename === "string").map(
    (part) => {
      const filename = part.filename as string
      const display = attachmentDisplay(filename)
      const preview = display.label ? previews.find((item) => item.label === display.label) : undefined
      const thumbnail = preview?.thumbnail
        ? `<button type="button" class="transcript-attachment-thumbnail" data-transcript-preview="${
          escapeHtml(display.label!)
        }" aria-label="Preview ${escapeHtml(display.name)}"><img src="${preview.thumbnail}" alt=""></button>`
        : FILE_ICON
      const mime = typeof part.mime === "string" ? part.mime : "Attachment"
      const previewState = preview?.thumbnail
        ? "Click the thumbnail to preview"
        : mime.startsWith("image/")
        ? "Preview unavailable after reload"
        : "Attachment metadata"
      return `<span class="attachment-chip transcript-attachment" title="${
        escapeHtml(`${mime} · ${previewState}`)
      }">${thumbnail}<span><strong>${escapeHtml(display.name)}</strong><small>${
        escapeHtml(display.label ?? mime)
      }</small></span></span>`
    },
  ).join("")
  const timestamp = message.info.time?.created
    ? new Date(message.info.time.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : ""
  const receipt = snapshot.session?.contextReceipts?.find((candidate) => candidate.promptID === message.info.id)
  const receiptHtml = receipt && receipt.items.length
    ? `<details class="context-receipt"><summary>Sent with ${receipt.items.length} context item${
      receipt.items.length === 1 ? "" : "s"
    }${receipt.estimatedTokens === undefined ? "" : ` · ~${receipt.estimatedTokens} tokens`}</summary><ul>${
      receipt.items.map((item) =>
        `<li><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.kind)}${
          item.truncated ? " · truncated" : ""
        }</small></li>`
      ).join("")
    }</ul>${receipt.truncation === "none" ? "" : `<p>Coverage: ${escapeHtml(receipt.truncation)}</p>`}</details>`
    : ""
  const latest = snapshot.session?.messages.at(-1)?.info.id === message.info.id
  const active = latest && (snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry")
  const empty = !body && !files
    ? active ? '<span class="pending">Saving message…</span>' : `<span class="message-failure" title="${
      escapeHtml(
        snapshot.session?.status.type === "error"
          ? snapshot.session.status.message || "OpenCode failed before saving this message."
          : "OpenCode did not persist any content for this message.",
      )
    }">Message failed before its content was saved</span>`
    : ""
  return `<article class="message user" data-message-id="${
    escapeHtml(message.info.id)
  }"><div class="message-heading">You${
    timestamp ? `<time class="message-time">${escapeHtml(timestamp)}</time>` : ""
  }</div><div class="content">${body}${
    files ? `<div class="transcript-attachments">${files}</div>` : ""
  }${receiptHtml}${empty}</div>${messageActions("user")}</article>`
}

function clearTranscript(): void {
  conversationView.clear()
}

function transcriptNearBottom(): boolean {
  return conversationView.nearBottom()
}

function renderTranscript(
  session: NonNullable<ChatSnapshot["session"]>,
  active: boolean,
  forcedPrependAnchor?: ScrollAnchor,
): void {
  conversationView.render(session, active, forcedPrependAnchor)
}

let turnNavigationObserver: IntersectionObserver | undefined
let turnNavigationSyncFrame: number | undefined
let conversationScrollFrame: number | undefined
const visibleTurnTargets = new Set<string>()

function markerTargetElement(value: string | undefined): HTMLElement | undefined {
  const [kind, ...idParts] = value?.split(":") ?? []
  const id = idParts.join(":")
  const selector = kind === "message"
    ? `[data-message-id="${CSS.escape(id)}"]`
    : kind === "permission"
    ? `[data-request-id="${CSS.escape(id)}"]`
    : kind === "question"
    ? `[data-question-request="${CSS.escape(id)}"]`
    : ""
  return selector ? document.querySelector<HTMLElement>(selector) ?? undefined : undefined
}

function syncVisibleTurnMarkers(): void {
  const buttons = [...turnNavigation.querySelectorAll<HTMLButtonElement>("[data-marker-target]")]
  const visibleButtons = buttons.filter((button) => visibleTurnTargets.has(button.dataset.markerTarget ?? ""))
  const atLatest = transcriptNearBottom()
  const first = atLatest ? buttons.at(-1) : visibleButtons[0]
  const last = atLatest ? first : visibleButtons.at(-1)
  if (!first || !last) return
  const nextScrollTop = turnNavigationScrollTop({
    scrollTop: turnNavigation.scrollTop,
    scrollHeight: turnNavigation.scrollHeight,
    clientHeight: turnNavigation.clientHeight,
    edgeInset: buttons[0]?.offsetTop ?? 0,
    activeTop: first.offsetTop,
    activeBottom: last.offsetTop + last.offsetHeight,
  })
  for (const button of buttons) {
    if (button === first) button.setAttribute("aria-current", "true")
    else button.removeAttribute("aria-current")
  }
  if (turnNavigation.scrollTop !== nextScrollTop) turnNavigation.scrollTop = nextScrollTop
}

function cancelVisibleTurnMarkerSync(): void {
  if (turnNavigationSyncFrame === undefined) return
  cancelAnimationFrame(turnNavigationSyncFrame)
  turnNavigationSyncFrame = undefined
}

function scheduleVisibleTurnMarkerSync(): void {
  if (turnNavigationSyncFrame !== undefined) return
  turnNavigationSyncFrame = requestAnimationFrame(() => {
    turnNavigationSyncFrame = undefined
    syncVisibleTurnMarkers()
  })
}

function scheduleConversationScrollSync(): void {
  if (conversationScrollFrame !== undefined) return
  conversationScrollFrame = requestAnimationFrame(() => {
    conversationScrollFrame = undefined
    conversationView.handleScroll()
    syncVisibleTurnMarkers()
  })
}

function observeTurnMarkers(): void {
  cancelVisibleTurnMarkerSync()
  turnNavigationObserver?.disconnect()
  turnNavigationObserver = undefined
  visibleTurnTargets.clear()
  if (typeof IntersectionObserver === "undefined" || turnNavigation.hidden) return
  const targets = new Map<Element, string>()
  for (const button of turnNavigation.querySelectorAll<HTMLButtonElement>("[data-marker-target]")) {
    const value = button.dataset.markerTarget
    const target = markerTargetElement(value)
    if (value && target && target.closest("#messages")) targets.set(target, value)
  }
  turnNavigationObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const value = targets.get(entry.target)
      if (!value) continue
      if (entry.isIntersecting) visibleTurnTargets.add(value)
      else visibleTurnTargets.delete(value)
    }
    scheduleVisibleTurnMarkerSync()
  }, { root: messages, rootMargin: "-16px 0px -16px 0px" })
  for (const target of targets.keys()) turnNavigationObserver.observe(target)
}

function renderTurnNavigation(session?: NonNullable<ChatSnapshot["session"]>): void {
  cancelVisibleTurnMarkerSync()
  turnNavigationObserver?.disconnect()
  turnNavigationObserver = undefined
  visibleTurnTargets.clear()
  if (!session) {
    turnNavigation.hidden = true
    turnNavigation.replaceChildren()
    turnNavigationPreview.hidden = true
    return
  }
  const markers = turnNavigationMarkers(session)
  const promptCount = markers.filter((marker) => marker.id.startsWith("message:")).length
  turnNavigation.hidden = promptCount < 4
  turnNavigationPreview.hidden = true
  const currentIndex = markers.findIndex((marker) => marker.current)
  const rovingIndex = currentIndex >= 0 ? currentIndex : Math.max(0, markers.length - 1)
  turnNavigation.innerHTML = markers.map((marker, index) =>
    `<button type="button" data-marker-target="${escapeHtml(marker.target)}" data-marker-label="${
      escapeHtml(marker.label)
    }" aria-label="${escapeHtml(marker.label)}"${marker.current ? ` aria-current="true"` : ""} tabindex="${
      index === rovingIndex ? 0 : -1
    }"><span aria-hidden="true"></span></button>`
  ).join("")
  observeTurnMarkers()
  scheduleVisibleTurnMarkerSync()
}

const revealedTurnNavigationSessions = new Set<string>()

function transcriptOverflows(): boolean {
  return messages.clientHeight > 0 && messages.scrollHeight > messages.clientHeight + 1
}

function syncTurnNavigationVisibility(session = snapshot.session): void {
  const markerCount = turnNavigation.querySelectorAll("[data-marker-target]").length
  if (!session || markerCount === 0) {
    cancelVisibleTurnMarkerSync()
    turnNavigation.hidden = true
    return
  }
  const wasHidden = turnNavigation.hidden
  if (!revealedTurnNavigationSessions.has(session.id) && transcriptOverflows()) {
    revealedTurnNavigationSessions.add(session.id)
  }
  turnNavigation.hidden = !revealedTurnNavigationSessions.has(session.id)
  if (wasHidden && !turnNavigation.hidden) observeTurnMarkers()
}

const turnNavigationResizeObserver = typeof ResizeObserver === "undefined"
  ? undefined
  : new ResizeObserver(() => scheduleViewportLayout(true))
turnNavigationResizeObserver?.observe(messages)

function renderSessionChangeSummary(session?: NonNullable<ChatSnapshot["session"]>, active = false): void {
  const changes = session?.changes ?? []
  const visible = Boolean(session && session.messages.length && changes.length && !active)
  sessionChangeSummary.hidden = !visible
  if (!visible) {
    sessionChangeSummary.replaceChildren()
    return
  }
  const additions = changes.reduce((total, change) => total + change.additions, 0)
  const deletions = changes.reduce((total, change) => total + change.deletions, 0)
  const unreviewed = changes.filter((change) => !change.reviewed).length
  sessionChangeSummary.innerHTML =
    `<div class="session-change-heading"><span class="session-change-icon" aria-hidden="true">${EDIT_ICON}</span><div><strong>${unreviewed} unreviewed of ${changes.length} changed file${
      changes.length === 1 ? "" : "s"
    }</strong><small><b>+${additions}</b> <i>−${deletions}</i></small></div><button type="button" data-session-changes-review>Review changes</button></div><ul>${
      changes.slice(0, 8).map((change) =>
        `<li>${
          change.reviewScope === "external"
            ? `<span>${escapeHtml(change.file)}</span>`
            : `<button type="button" data-session-change-review="${escapeHtml(change.file)}">${
              escapeHtml(change.file)
            }</button>`
        }<span>${
          change.reviewScope === "external" ? "External patch · " : change.reviewed ? "Reviewed · " : ""
        }<b>+${change.additions}</b> <i>−${change.deletions}</i></span></li>`
      ).join("")
    }</ul>${
      changes.length > 8 ? `<small class="session-change-more">${changes.length - 8} more files in Changes</small>` : ""
    }`
}

function renderHistoryBoundary(session?: NonNullable<ChatSnapshot["session"]>): void {
  const presentation = historyPresentation(session?.history)
  const loading = Boolean(session && historyController.sessionID === session.id)
  const loadingAll = loading && historyController.mode === "all"
  const actionable = Boolean(presentation.actionLabel && session)
  const loadAllLabel = historyLoadAllLabel(session?.history)
  const loadAllProgress = historyLoadAllProgress(
    historyController.loaded,
    historyController.target,
  )
  historyBoundary.hidden = !presentation.visible && !loading
  historyBoundary.setAttribute("aria-busy", String(loading))
  historyBoundaryText.textContent = loadingAll
    ? `${loadAllProgress}. ${
      historyController.cancelled ? "Cancelling after the current page." : "Loading older messages."
    }`
    : loading
    ? `${presentation.text} Loading the next older page…`
    : presentation.text
  historyBoundaryText.classList.toggle(
    "visually-hidden",
    actionable || loading,
  )
  historyLoadOlder.hidden = !actionable || loadingAll
  historyLoadOlder.disabled = loading
  historyLoadOlder.textContent = loading ? "Loading…" : presentation.actionLabel ?? "Load older messages"
  historyLoadOlder.title = presentation.text
  historyLoadOlder.setAttribute(
    "aria-label",
    loading ? "Loading older messages" : `${presentation.actionLabel ?? "Load older messages"}. ${presentation.text}`,
  )
  historyLoadAll.hidden = !actionable && !loadingAll
  historyLoadAll.disabled = (loading && !loadingAll) ||
    historyController.cancelled
  historyLoadAll.textContent = loadingAll ? historyController.cancelled ? "Cancelling…" : "Cancel" : loadAllLabel
  historyLoadAll.title = loadingAll
    ? "Stop after the current history page"
    : `Load every available older message. ${presentation.text}`
  historyLoadAll.setAttribute(
    "aria-label",
    loadingAll
      ? historyController.cancelled ? "Cancelling load all messages" : "Cancel loading all messages"
      : `${loadAllLabel}. ${presentation.text}`,
  )
  historyLoadProgress.hidden = !loadingAll
  historyLoadProgress.textContent = loadingAll ? loadAllProgress : ""
}

function resetHistoryLoading(): void {
  historyController.reset()
}

function beginHistoryLoad(mode: "page" | "all"): void {
  const session = snapshot.session
  const beforeMessageID = session?.messages[0]?.info.id
  if (!session?.history?.hasOlder || historyController.loading) return
  const anchor = conversationView.capturePrependAnchor()
  const target = mode === "all" && !session.history.sourceMayBeTruncated
    ? Math.max(0, session.history.totalMessages - session.history.visibleMessages)
    : undefined
  historyController.begin(session.id, mode, anchor, target)
  renderHistoryBoundary(session)
  if (mode === "all") conversationView.restorePrependAnchor(historyController.anchor)
  post({ type: "loadOlderHistory", sessionID: session.id, beforeMessageID })
}

function fillSelect(
  select: HTMLSelectElement,
  defaultLabel: string,
  options: Array<{ value: string; label: string }>,
  selected?: string,
): void {
  const html = [
    `<option value="">${escapeHtml(defaultLabel)}</option>`,
    ...options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`),
  ].join("")
  if (select.dataset.options !== html) {
    select.innerHTML = html
    select.dataset.options = html
  }
  if (select.value !== (selected || "")) select.value = selected || ""
}

function variantLabel(value: string): string {
  return ({
    none: "None",
    low: "Light",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
    ultra: "Ultra",
  } as Record<string, string>)[value.toLowerCase()] ?? value
}

function selectedModelOption() {
  return snapshot.models.find((item) => `${item.providerID}/${item.id}` === model.value)
}

function renderModelPicker(): void {
  const selected = selectedModelOption()
  const variants = selected?.variants ?? []
  modelButtonLabel.textContent = selected?.name || "Default model"
  variantButtonLabel.textContent = variant.value ? `· ${variantLabel(variant.value)}` : ""
  modelToggle.title = selected
    ? `${selected.name} · ${
      snapshot.providers?.find((provider) => provider.id === selected.providerID)?.name ?? selected.providerID
    }${variant.value ? ` · ${variantLabel(variant.value)}` : ""}`
    : "Model and reasoning"
  if (modelPicker.hidden) return
  const focusedModelValue =
    document.activeElement instanceof HTMLElement && modelOptions.contains(document.activeElement)
      ? document.activeElement.closest<HTMLButtonElement>("[data-model-value]")?.dataset.modelValue
      : undefined
  const focusedVariant =
    document.activeElement instanceof HTMLElement && reasoningOptions.contains(document.activeElement)
      ? document.activeElement.closest<HTMLButtonElement>("[data-variant-value]")
      : undefined
  const signature = JSON.stringify([snapshot.models, model.value, variant.value, modelSearch.value])
  if (signature === modelPickerSignature) return
  modelPickerSignature = signature
  reasoningOptions.hidden = variants.length === 0
  const variantHeading = selected?.capabilities?.reasoning ? "Reasoning" : "Model variant"
  reasoningOptions.innerHTML = variants.length
    ? `<div class="picker-heading">${variantHeading}</div><button type="button" data-variant-value="" aria-pressed="${!variant
      .value}">Provider default</button>${
      variants.map((value) =>
        `<button type="button" data-variant-value="${escapeHtml(value)}" aria-pressed="${variant.value === value}">${
          escapeHtml(variantLabel(value))
        }</button>`
      ).join("")
    }`
    : ""
  const query = modelSearch.value.trim().toLowerCase()
  const matchingModels = snapshot.models
    .filter((item) => !query || `${item.name}\n${item.providerID}\n${item.id}`.toLowerCase().includes(query))
    .sort((left, right) =>
      left.providerID.localeCompare(right.providerID, undefined, { numeric: true }) ||
      left.name.localeCompare(right.name, undefined, { numeric: true })
    )
  const selectedMatch = matchingModels.find((item) => `${item.providerID}/${item.id}` === model.value)
  const models = [selectedMatch, ...matchingModels.filter((item) => item !== selectedMatch)].filter((
    item,
  ): item is typeof matchingModels[number] => Boolean(item)).slice(0, 120)
  const availableValues = new Set(models.map((item) => `${item.providerID}/${item.id}`))
  modelPickerActiveValue = modelPickerActiveValue && availableValues.has(modelPickerActiveValue)
    ? modelPickerActiveValue
    : model.value && availableValues.has(model.value)
    ? model.value
    : models[0]
    ? `${models[0].providerID}/${models[0].id}`
    : undefined
  const selectedModels = models.filter((item) => `${item.providerID}/${item.id}` === model.value)
  const groupedModels = models.filter((item) => `${item.providerID}/${item.id}` !== model.value)
  let modelIndex = 0
  const modelButton = (item: typeof models[number]) => {
    const value = `${item.providerID}/${item.id}`
    const index = modelIndex++
    return `<button id="model-option-${index}" type="button" role="option" data-model-value="${
      escapeHtml(value)
    }" aria-selected="${model.value === value}" tabindex="${modelPickerActiveValue === value ? 0 : -1}"><span>${
      escapeHtml(item.name)
    }</span><small>${item.contextLimit ? `${Math.round(item.contextLimit / 1_000)}k` : ""}</small></button>`
  }
  const providerGroups = new Map<string, typeof groupedModels>()
  for (const item of groupedModels) {
    providerGroups.set(item.providerID, [...(providerGroups.get(item.providerID) ?? []), item])
  }
  const selectedGroup = selectedModels.length
    ? `<div class="model-option-group" role="group" aria-label="Selected model"><div class="picker-heading picker-provider" aria-hidden="true">Selected</div>${
      selectedModels.map(modelButton).join("")
    }</div>`
    : ""
  const grouped = [...providerGroups].map(([providerID, items]) => {
    const label = snapshot.providers?.find((candidate) => candidate.id === providerID)?.name ?? providerID
    return `<div class="model-option-group" role="group" aria-label="${
      escapeHtml(label)
    }"><div class="picker-heading picker-provider" aria-hidden="true">${escapeHtml(label)}</div>${
      items.map(modelButton).join("")
    }</div>`
  }).join("")
  modelOptions.innerHTML = models.length
    ? `${selectedGroup}${grouped}`
    : `<p class="placeholder" role="status">No matching models.</p>`
  if (focusedModelValue) {
    const replacement = modelOptionButtons().find((button) => button.dataset.modelValue === focusedModelValue)
    if (replacement) {
      modelOptionButtons().forEach((button) => button.tabIndex = button === replacement ? 0 : -1)
      modelPickerActiveValue = focusedModelValue
      replacement.focus()
    } else modelSearch.focus()
  } else if (focusedVariant) {
    const replacement = [...reasoningOptions.querySelectorAll<HTMLButtonElement>("[data-variant-value]")]
      .find((button) => button.dataset.variantValue === focusedVariant.dataset.variantValue)
    ;(replacement ?? modelSearch).focus()
  }
  const limits = selected
    ? [
      selected.contextLimit ? `context ${selected.contextLimit.toLocaleString()}` : "context unknown",
      selected.inputLimit ? `input ${selected.inputLimit.toLocaleString()}` : "",
      selected.outputLimit ? `output ${selected.outputLimit.toLocaleString()}` : "",
    ].filter(Boolean).join(" · ")
    : "Context limit unavailable"
  const abilities = selected
    ? [
      selected.capabilities?.reasoning ? "reasoning" : "",
      selected.capabilities?.toolcall ? "tools" : "",
      selected.capabilities?.input?.image ? "images" : "",
      selected.capabilities?.input?.pdf ? "PDF" : "",
    ].filter(Boolean).join(", ")
    : ""
  const freshness = snapshot.catalog?.status === "stale"
    ? " · stale catalog"
    : snapshot.catalog?.status === "error"
    ? " · catalog unavailable"
    : ""
  const providerSource = selected
    ? snapshot.providers?.find((provider) => provider.id === selected.providerID)?.source
    : undefined
  modelMeta.textContent = `${limits}${abilities ? ` · ${abilities}` : ""}${
    providerSource ? ` · configured via ${providerSource}` : ""
  }${selected?.status && selected.status !== "active" ? ` · ${selected.status}` : ""}${freshness}`
  modelMeta.title = snapshot.catalog?.error ||
    "Models are resolved by OpenCode for this workspace. OpenCode does not report provider subscription tier."
}

function openModelPicker(focusReasoning = false): void {
  commandSuggestions.hidden = true
  if (modelPicker.hidden) {
    modelPickerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : modelToggle
  }
  modelPickerActiveValue = model.value || undefined
  modelPickerSignature = ""
  modelPicker.hidden = false
  modelToggle.setAttribute("aria-expanded", "true")
  renderModelPicker()
  requestAnimationFrame(() =>
    focusReasoning && !reasoningOptions.hidden
      ? reasoningOptions.querySelector<HTMLButtonElement>("button[aria-pressed='true']")?.focus()
      : modelSearch.focus()
  )
}

function closeModelPicker(restoreFocus = true): void {
  modelPicker.hidden = true
  modelToggle.setAttribute("aria-expanded", "false")
  modelSearch.value = ""
  modelPickerSignature = ""
  const target = modelPickerReturnFocus
  modelPickerReturnFocus = undefined
  if (restoreFocus) (target?.isConnected ? target : modelToggle).focus()
}

function renderMultiModelPicker(): void {
  multiRunController.reconcile(snapshot.models, snapshot.providers, snapshot.connected)
}

function openMultiModelPicker(): void {
  const sessionID = snapshot.session?.id
  if (!sessionID || !snapshot.connected || !draft.value.trim()) {
    showNotice("error", "Task required", "Enter the task every isolated model should perform before selecting models.")
    return
  }
  closeModelPicker(false)
  const preferred = model.value || snapshot.session?.model
  multiRunController.show({
    sessionID,
    draft: draft.value,
    preferred,
    models: snapshot.models,
    providers: snapshot.providers,
    connected: snapshot.connected,
    returnFocus: send,
  })
  sendOptions.open = false
}

function closeMultiModelPicker(restoreFocus = true): void {
  multiRunController.close(restoreFocus)
}

function modelOptionButtons(): HTMLButtonElement[] {
  return [...modelOptions.querySelectorAll<HTMLButtonElement>("[data-model-value]")]
}

function navigateMenu(root: HTMLElement, event: KeyboardEvent, selector = "button:not([disabled])"): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false
  const buttons = [...root.querySelectorAll<HTMLButtonElement>(selector)].filter((button) =>
    !button.hidden && !button.closest("[hidden]")
  )
  const next = nextMenuIndex(
    event.key as MenuNavigationKey,
    buttons.indexOf(document.activeElement as HTMLButtonElement),
    buttons.length,
  )
  if (next === undefined) return false
  event.preventDefault()
  buttons.forEach((button, index) => button.tabIndex = index === next ? 0 : -1)
  buttons[next]?.focus()
  return true
}

function focusModelOption(index: number): void {
  const buttons = modelOptionButtons()
  if (!buttons.length) return
  const bounded = Math.max(0, Math.min(index, buttons.length - 1))
  buttons.forEach((button, buttonIndex) => button.tabIndex = buttonIndex === bounded ? 0 : -1)
  modelPickerActiveValue = buttons[bounded]?.dataset.modelValue
  buttons[bounded]?.focus()
}

function moveModelOptionFocus(key: string): void {
  const buttons = modelOptionButtons()
  if (!buttons.length) return
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = key === "Home"
    ? 0
    : key === "End"
    ? buttons.length - 1
    : key === "ArrowDown"
    ? (Math.max(0, current) + 1) % buttons.length
    : (current <= 0 ? buttons.length : current) - 1
  focusModelOption(next)
}

function renderSessionLists(): void {
  const signature = JSON.stringify([
    snapshot.sessions,
    snapshot.session?.id,
    historySearch.value,
    railSessionSearch.value,
  ])
  if (signature === sessionListSignature) return
  const focusedSession = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLButtonElement>("[data-session-id]")
    : undefined
  const focusedList = focusedSession && historyList.contains(focusedSession)
    ? historyList
    : focusedSession && railSessionList.contains(focusedSession)
    ? railSessionList
    : undefined
  const focusedSessionID = focusedSession?.dataset.sessionId
  sessionListSignature = signature
  historyList.innerHTML = sessionListMarkup(snapshot.sessions, {
    query: historySearch.value,
    empty: "No matching sessions.",
    selectedSessionID: snapshot.session?.id,
    renderLimit: sessionRenderLimit,
  })
  railSessionCount.textContent = String(snapshot.sessions.length)
  railSessionList.innerHTML = sessionListMarkup(snapshot.sessions, {
    query: railSessionSearch.value,
    empty: railSessionSearch.value ? "No matching sessions." : "No sessions yet.",
    selectedSessionID: snapshot.session?.id,
    renderLimit: sessionRenderLimit,
  })
  if (focusedList && focusedSessionID) {
    const replacement = [...focusedList.querySelectorAll<HTMLButtonElement>("[data-session-id]")].find((button) =>
      button.dataset.sessionId === focusedSessionID
    )
    if (replacement) {
      focusedList.querySelectorAll<HTMLButtonElement>("[data-session-id]").forEach((button) =>
        button.tabIndex = button === replacement ? 0 : -1
      )
      replacement.focus()
    } else (focusedList === historyList ? historySearch : railSessionSearch).focus()
  }
}

function renderQueue(session: NonNullable<ChatSnapshot["session"]>): void {
  const { queue, running, pending, signature } = queueProjection(session)
  if (signature === queueSignature) return
  queueSignature = signature
  queueDock.hidden = queue.length === 0
  const preview = (prompt: typeof queue[number]) =>
    escapeHtml(
      prompt.text.replace(/\s+/g, " ").trim() || prompt.attachments?.map((attachment) => attachment.name).join(", ") ||
        "Attachment",
    )
  const delivery = (prompt: typeof queue[number]) => deliveryLabel(prompt.delivery)
  const active = session.status.type === "busy" || session.status.type === "retry"
  queueDock.innerHTML = queue.length
    ? `${
      running
        ? `<div class="dock-heading"><strong>Running</strong></div><ol><li class="queue-running"><span class="queue-preview">${
          preview(running)
        }</span><small>${delivery(running)}</small></li></ol>`
        : ""
    }${
      pending.length
        ? `<div class="dock-heading"><strong>Queue</strong><span>${pending.length}</span></div><ol>${
          pending.map((prompt, index) =>
            `<li><span class="queue-preview">${preview(prompt)}</span><small>${
              delivery(prompt)
            }</small><span class="queue-actions"><button type="button" data-queue-action="now" data-prompt-id="${
              escapeHtml(prompt.id)
            }" title="${active ? "Cancel the current response and send this message" : "Send this message now"}" ${
              running ? "disabled" : ""
            }>${
              active ? "Stop and send" : "Send now"
            }</button><button type="button" data-queue-action="edit" data-prompt-id="${
              escapeHtml(prompt.id)
            }">Edit</button><button type="button" data-queue-action="up" data-prompt-id="${escapeHtml(prompt.id)}" ${
              index === 0 ? "disabled" : ""
            }>Up</button><button type="button" data-queue-action="down" data-prompt-id="${escapeHtml(prompt.id)}" ${
              index === pending.length - 1 ? "disabled" : ""
            }>Down</button><button type="button" data-queue-action="remove" data-prompt-id="${
              escapeHtml(prompt.id)
            }">Remove from queue</button></span></li>`
          ).join("")
        }</ol>`
        : ""
    }`
    : ""
}

function incompletePermissionDetails(request: PermissionRequest): string {
  return [
    `Title: ${request.title}`,
    `Type: ${request.type ?? "unspecified"}`,
    `Pattern:\n${stringify(request.pattern ?? "unspecified")}`,
    `Metadata:\n${stringify(request.metadata ?? {})}`,
  ].filter(Boolean).join("\n\n")
}

function renderPermissions(session: NonNullable<ChatSnapshot["session"]>): void {
  const permissions = session.permissions ?? []
  const signature = JSON.stringify([session.id, permissions])
  if (signature === permissionSignature) return
  permissionSignature = signature
  permissionDock.hidden = permissions.length === 0
  permissionDock.innerHTML = permissionUiGroups(permissions).map((group) => {
    const request = group.request
    const incomplete = request.truncated === true
    const disabled = incomplete ? ` disabled title="Unavailable because the request details were truncated"` : ""
    const delegated = request.sessionID !== session.id
    const delegation = delegated ? session.delegations?.find((item) => item.sessionID === request.sessionID) : undefined
    const origin = delegated
      ? `Requested by subagent${delegation ? `: ${delegation.title}` : ""}`
      : "Permission required"
    const presentation = permissionPresentation(request)
    const exactPatterns = typeof request.pattern === "string" ? [request.pattern] : request.pattern ?? []
    const reusableScopes = reusablePermissionScopes(request)
    const canReuseExact = exactPatterns.length > 0 && request.type !== "vscode.reload_opencode"
    const summaryText = presentation.lines.join("\n")
    const summary = summaryText
      ? `<pre class="permission-summary-lines" title="${escapeHtml(summaryText)}">${escapeHtml(summaryText)}</pre>`
      : ""
    const changes = presentation.diff
      ? `<details class="permission-changes"><summary>Review proposed changes</summary>${
        editPatchBlock(presentation.diff, presentation.file, {
          requestID: request.id,
          sessionID: request.sessionID,
        })
      }</details>`
      : ""
    const exactAction = canReuseExact
      ? `<button type="button" role="menuitem" data-permission="exact">Allow Exact ${
        request.type === "bash" || request.type === "shell" ? "Command Line" : "Scope"
      } in this Session</button>`
      : ""
    const scopeActions = reusableScopes.map((candidate) =>
      candidate === "*"
        ? `<button type="button" role="menuitem" data-permission="scope" data-permission-scope="*">Allow All Shell Commands in this Session</button>`
        : `<button type="button" role="menuitem" data-permission="scope" data-permission-scope="${
          escapeHtml(candidate)
        }">Allow <code>${escapeHtml(candidate.replace(/ \*$/, " …"))}</code> in this Session</button>`
    ).join("")
    const allowMenu = !incomplete && (exactAction || scopeActions)
      ? `<details class="permission-allow-menu"><summary aria-label="More allow options" title="More allow options">${CHEVRON_DOWN_ICON}</summary><div class="permission-allow-options" role="menu" popover="auto">${exactAction}${scopeActions}</div></details>`
      : ""
    const incompleteDetails = incomplete
      ? `<details class="permission-raw"><summary>Available request data</summary><pre>${
        escapeHtml(incompletePermissionDetails(request))
      }</pre></details><p class="permission-warning">Some request metadata was truncated. Review the available data and reject this request.</p>`
      : ""
    const groupedRequests = escapeHtml(
      JSON.stringify(
        group.requests.map((candidate) => ({
          id: candidate.id,
          sessionID: candidate.sessionID,
          protocol: candidate.protocol,
        })),
      ),
    )
    const duplicateCount = group.requests.length > 1
      ? `<span class="permission-duplicate-count">${group.requests.length} identical requests</span>`
      : ""
    const rejectLabel = group.requests.length > 1 ? "Reject all" : "Reject"
    const allowLabel = group.requests.length > 1 ? "Allow all" : "Allow"
    const allowTitle = group.requests.length > 1
      ? `Allow all ${group.requests.length} identical requests once`
      : "Allow once"
    return `<article class="permission-card${incomplete ? " permission-incomplete" : ""}" data-request-id="${
      escapeHtml(request.id)
    }" data-request-session="${
      escapeHtml(request.sessionID)
    }" data-request-protocol="${request.protocol}" data-request-group="${groupedRequests}"><div class="permission-heading"><span class="permission-request-icon" aria-hidden="true">${
      escapeHtml(presentation.icon)
    }</span><span class="permission-heading-copy"><strong>${escapeHtml(presentation.title)}</strong><small>${
      escapeHtml(origin)
    }</small></span>${duplicateCount}</div>${summary}${changes}${incompleteDetails}<details class="permission-feedback"><summary>Explain rejection <small>(optional)</small></summary><label class="custom-answer"><span>Feedback</span><input type="text" data-permission-feedback maxlength="20000" autocomplete="off"></label></details><div class="permission-actions"><button type="button" data-permission="reject">${rejectLabel}</button><div class="permission-allow-group"><button type="button" data-permission="once" class="primary-action" title="${allowTitle}"${disabled}>${allowLabel}</button>${allowMenu}</div></div></article>`
  }).join("")
}

function renderQuestions(session: NonNullable<ChatSnapshot["session"]>): void {
  const questions = session.questions ?? []
  const signature = JSON.stringify([session.id, questions])
  if (signature === questionSignature) return
  questionSignature = signature
  questionDock.hidden = questions.length === 0
  questionDock.innerHTML = questions.map((request) => {
    const delegated = request.sessionID !== session.id
    const delegation = delegated ? session.delegations?.find((item) => item.sessionID === request.sessionID) : undefined
    return `<form class="question-card" data-question-request="${escapeHtml(request.id)}" data-request-session="${
      escapeHtml(request.sessionID)
    }">
    <div class="permission-heading"><strong>${
      delegated ? "Subagent needs input" : "OpenCode needs input"
    }</strong><span>${
      request.questions.length === 1
        ? escapeHtml(request.questions[0]!.header)
        : `${request.questions.length} questions`
    }</span>${
      delegated ? `<small>Requested by subagent${delegation ? `: ${escapeHtml(delegation.title)}` : ""}</small>` : ""
    }</div>
    ${
      request.questions.map((question, questionIndex) =>
        `<fieldset data-question-index="${questionIndex}"><legend>${escapeHtml(question.header)}</legend><p>${
          escapeHtml(question.question)
        }</p><div class="question-options">${
          question.options.map((option, optionIndex) =>
            `<label><input type="${question.multiple ? "checkbox" : "radio"}" name="question-${
              escapeHtml(request.id)
            }-${questionIndex}" value="${escapeHtml(option.label)}"><span><strong>${escapeHtml(option.label)}</strong>${
              option.description ? `<small>${escapeHtml(option.description)}</small>` : ""
            }</span></label>`
          ).join("")
        }</div>${
          question.custom !== false
            ? `<label class="custom-answer"><span>Custom answer</span><input type="text" data-custom-answer maxlength="20000" autocomplete="off"></label>`
            : ""
        }</fieldset>`
      ).join("")
    }
    <div class="permission-actions"><button type="button" data-question-action="reject">Reject</button><button type="submit" class="primary-action">Submit answer</button></div>
  </form>`
  }).join("")
}

function renderSessionTaskDock(session: NonNullable<ChatSnapshot["session"]>): void {
  const plan = (snapshot.artifacts ?? [])
    .filter((artifact) => artifact.kind === "plan" && artifact.lifecycle === "active")
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
  const cards: string[] = []
  if (plan) {
    cards.push(
      `<button type="button" class="session-task-card" data-session-detail="plan"><span class="dock-label">Plan</span><strong>Implementation plan</strong><small>${
        escapeHtml(plan.state)
      } · updated ${
        escapeHtml(new Date(plan.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
      }</small></button>`,
    )
  }
  const ownedGroups = (snapshot.runGroups ?? []).filter((group) => group.ownerSessionID === session.id).sort((
    left,
    right,
  ) => right.createdAt - left.createdAt)
  const latestGroup = ownedGroups[0]
  if (latestGroup) {
    const completed = latestGroup.runs.filter((run) => ["completed", "failed", "cancelled"].includes(run.phase)).length
    const needsInput = latestGroup.runs.filter((run) => run.phase === "needs-input").length
    const detail = needsInput
      ? `${needsInput} need input`
      : completed === latestGroup.runs.length
      ? "Ready to review, compare, fuse, keep, or discard"
      : `${latestGroup.runs.length - completed} still working or queued`
    cards.push(
      `<button type="button" class="session-task-card session-task-card-compact" data-session-detail="runs"><span class="dock-label">Multi-model</span><strong>${completed}/${latestGroup.runs.length} finished</strong><small>${
        escapeHtml(detail)
      }</small><span aria-hidden="true">›</span></button>`,
    )
  } else {
    const activeRuns = (snapshot.runGroups ?? []).flatMap((group) => group.runs).filter((run) =>
      ["pending", "preparing", "admitting", "working", "needs-input"].includes(run.phase)
    )
    if (activeRuns.length) {
      cards.push(
        `<button type="button" class="session-task-card session-task-card-compact" data-session-detail="jobs"><span class="dock-label">Background runs</span><strong>${activeRuns.length} active ${
          activeRuns.length === 1 ? "run" : "runs"
        }</strong><small>Isolated work not already shown in chat</small><span aria-hidden="true">›</span></button>`,
      )
    }
  }
  sessionTaskDock.hidden = cards.length === 0
  sessionTaskDock.innerHTML = cards.join("")
}

function renderSummaries(session: NonNullable<ChatSnapshot["session"]>, active: boolean): void {
  const signature = JSON.stringify([
    session.id,
    session.todos,
    session.delegations,
    snapshot.artifacts,
    snapshot.runGroups,
    active,
  ])
  if (signature === summarySignature) return
  summarySignature = signature
  const todos = session.todos ?? []
  const completed = todos.filter((todo) => todo.status === "completed").length
  const currentTodo = currentTodoContent(todos)
  todoDock.hidden = todos.length === 0
  todoDock.classList.toggle("collapsed", !todoExpanded)
  todoDock.innerHTML = todos.length
    ? `<button type="button" class="todo-dock-header" aria-expanded="${todoExpanded}" title="${
      todoExpanded ? "Collapse todos" : "Expand todos"
    }"><span class="todo-dock-title">Todos</span><span class="todo-dock-current" title="${escapeHtml(currentTodo)}">${
      escapeHtml(currentTodo)
    }</span><small>${completed}/${todos.length}</small><span class="todo-dock-chevron" aria-hidden="true">›</span></button><ol class="todo-dock-list"${
      todoExpanded ? "" : " hidden"
    }>${
      todos.map((todo) => {
        const status = activityVisualState(todo.status, active)
        const kind = status === "completed"
          ? "completed"
          : ["in_progress", "in-progress", "active"].includes(status)
          ? "working"
          : ["cancelled", "canceled", "skipped"].includes(status)
          ? "cancelled"
          : "pending"
        const visualKind = status === "stopped" ? "stopped" : kind
        const label = visualKind === "completed"
          ? "Completed"
          : visualKind === "working"
          ? "In progress"
          : visualKind === "cancelled"
          ? "Cancelled"
          : visualKind === "stopped"
          ? "Stopped"
          : "Pending"
        const indicator = visualKind === "completed"
          ? SESSION_COMPLETED_ICON
          : visualKind === "working"
          ? ""
          : visualKind === "cancelled"
          ? "−"
          : visualKind === "stopped"
          ? "·"
          : ""
        return `<li class="todo-dock-item todo-${visualKind}"><span class="todo-state" role="img" aria-label="${label}" title="${label}">${indicator}</span><span>${
          escapeHtml(todo.content)
        }</span>${todo.priority ? `<small>${escapeHtml(todo.priority)}</small>` : ""}</li>`
      }).join("")
    }</ol>`
    : ""
  renderSessionTaskDock(session)
}

function serviceLabel(service: RuntimeService): string {
  return `${service.name || service.id}: ${service.error || service.status || "available"}${
    service.root ? ` · ${service.root}` : ""
  }`
}

function serviceList(services: RuntimeService[], kind: "lsp" | "formatter" | "mcp"): string {
  return `<ul class="workspace-service-list">${
    services.map((service) => {
      const name = escapeHtml(service.name || service.id)
      const presentation = runtimeServicePresentation(service, kind)
      const detail = presentation.detail ? `<code>${escapeHtml(presentation.detail)}</code>` : ""
      const error = service.error && service.error !== presentation.status
        ? `<small class="service-error">${escapeHtml(service.error)}</small>`
        : ""
      return `<li><span>${name}</span><small class="service-${presentation.tone}">${
        escapeHtml(presentation.status)
      }</small>${error}${detail}</li>`
    }).join("")
  }</ul>`
}

function workspaceDetail(kind: string, label: string, title: string, content: string, tooltip: string): string {
  return `<details class="workspace-detail workspace-${kind}"><summary title="${escapeHtml(tooltip)}">${
    escapeHtml(label)
  }</summary><div class="workspace-detail-popover" popover="auto"><strong>${
    escapeHtml(title)
  }</strong>${content}</div></details>`
}

function healthWorkspaceDetail(): string {
  const health = snapshot.health
  const healthy = Boolean(
    snapshot.connected && health?.serverState === "connected" && health.eventStream.state === "connected",
  )
  const reconnecting = snapshot.connectionState === "reconnecting" || health?.serverState === "starting" ||
    health?.eventStream.state === "reconnecting"
  const tone = healthy ? "healthy" : reconnecting ? "pending" : "unhealthy"
  const state = healthy ? "Connected" : reconnecting ? "Reconnecting" : "Needs attention"
  const tooltip = health
    ? `${state}\nServer: ${health.serverState}\nEvent stream: ${health.eventStream.state}\nCompanion: ${health.pluginState}\nOpenCode: ${
      health.openCodeVersion ?? "Unknown"
    }`
    : `${state}\nHealth details are not available yet.`
  const rows = health
    ? [
      ["Server", health.serverState],
      ["Event stream", health.eventStream.state],
      ["Companion", health.pluginState],
      ["OpenCode", health.openCodeVersion ?? "Unknown"],
      ["Request queue", String(health.requestQueueDepth)],
    ]
    : [["Status", state]]
  const content = `<dl class="workspace-context-list">${
    rows.map(([label, value]) => `<div><dt>${escapeHtml(label!)}</dt><dd>${escapeHtml(value!)}</dd></div>`).join("")
  }</dl>`
  return `<details class="workspace-detail workspace-health"><summary title="${
    escapeHtml(tooltip)
  }" aria-label="OpenCode health: ${
    escapeHtml(state)
  }"><span class="workspace-health-dot ${tone}" aria-hidden="true"></span><span>OpenCode</span></summary><div class="workspace-detail-popover" popover="auto"><strong>OpenCode health</strong>${content}</div></details>`
}

function contextDetails(context: NonNullable<NonNullable<ChatSnapshot["session"]>["context"]>): string {
  const reported = context.usageReported !== false
  const count = (value: number): string => reported ? value.toLocaleString() : "Not reported"
  const rows = [
    ["Model", context.model ?? "Unknown"],
    ["Total tokens", count(context.totalTokens)],
    ["Input", count(context.inputTokens)],
    ["Output", count(context.outputTokens)],
    ["Reasoning", count(context.reasoningTokens)],
    ["Cache read", count(context.cacheReadTokens)],
    ["Cache write", count(context.cacheWriteTokens)],
    ["Context limit", context.contextLimit?.toLocaleString() ?? "Unknown"],
    ["Input limit", context.inputLimit?.toLocaleString() ?? "Unknown"],
    ["Output limit", context.outputLimit?.toLocaleString() ?? "Unknown"],
    ["Session cost", `$${context.cost.toFixed(4)}`],
  ]
  return `<dl class="workspace-context-list">${
    rows.map(([label, value]) => `<div><dt>${escapeHtml(label!)}</dt><dd>${escapeHtml(value!)}</dd></div>`).join("")
  }</dl>`
}

function metricDuration(seconds: number, detailed = false): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor(total % 86_400 / 3_600)
  const minutes = Math.floor(total % 3_600 / 60)
  if (days) return `${days}d${hours || detailed ? ` ${hours}h` : ""}${detailed && minutes ? ` ${minutes}m` : ""}`
  if (hours) return `${hours}h${minutes || detailed ? ` ${minutes}m` : ""}`
  if (minutes) return `${minutes}m${detailed ? ` ${total % 60}s` : ""}`
  return `${total}s`
}

function sessionTurnMetric(
  metrics: NonNullable<NonNullable<ChatSnapshot["session"]>["metrics"]>,
  suffix = " turns",
): string {
  return `${metrics.turnsTruncated ? "≥" : ""}${metrics.turnsUsed.toLocaleString()}${suffix}`
}

function liveMetricDuration(seconds: number | undefined, sampledAt: number | undefined, running: boolean): number {
  return metricsController.liveDuration(seconds, sampledAt, running)
}

function goalStateLabel(status: string | undefined): string {
  return ({
    active: "Active",
    paused: "Paused",
    budgetLimited: "Token limit",
    usageLimited: "Time limit",
    complete: "Complete",
    unmet: "Needs input",
  } as Record<string, string>)[status ?? ""] ?? "Goal"
}

function verdictLabel(verdict: string): string {
  return ({ continue: "Continue", complete: "Complete", blocked: "Blocked", "needs-user": "Needs input" } as Record<
    string,
    string
  >)[verdict] ?? verdict
}

function goalMetricRow(
  label: string,
  objective: string,
  status: string,
  tokens: number,
  seconds: number,
  turns: number,
  current = false,
): string {
  return `<li class="goal-metric-row${current ? " current" : ""}"><span class="goal-tree-branch" aria-hidden="true">${
    current ? "└" : "├"
  }</span><span class="goal-metric-copy"><strong>${escapeHtml(label)}</strong><small title="${escapeHtml(objective)}">${
    escapeHtml(objective)
  }</small></span><span>${tokens.toLocaleString()} tokens</span><span${
    current ? ` data-workspace-duration="goal" data-duration-detailed="true"` : ""
  }>${
    escapeHtml(metricDuration(seconds, true))
  }</span><span>${turns.toLocaleString()} turns</span><small class="goal-metric-status">${
    escapeHtml(goalStateLabel(status))
  }</small></li>`
}

function workspaceDurationValues(
  session: NonNullable<ChatSnapshot["session"]>,
): { session: number; goal: number; outside: number } {
  return metricsController.durationValues(session)
}

function syncWorkspaceDurations(session: NonNullable<ChatSnapshot["session"]>): void {
  const durations = metricsController.sync(session, metricDuration)
  const goal = session.goal
  const history = session.goalHistory ?? goal?.archivedGoals ?? []
  const sequence = goal?.sequence ?? (history.at(-1)?.sequence ?? 0) + 1
  const label = goal
    ? `Goal ${sequence}, ${goalStateLabel(goal.status)}: ${(goal.tokensUsed ?? 0).toLocaleString()} tokens, ${
      metricDuration(durations.goal, true)
    } elapsed, ${(goal.turnsUsed ?? 0).toLocaleString()} turns. Session totals: ${
      session.metrics?.tokensUsed?.toLocaleString() ?? "unknown"
    } tokens, age ${metricDuration(durations.session, true)}, ${
      session.metrics ? sessionTurnMetric(session.metrics) : "unknown turns"
    }.`
    : `Session totals: ${session.metrics?.tokensUsed?.toLocaleString() ?? "unknown"} tokens, age ${
      metricDuration(durations.session, true)
    }, ${session.metrics ? sessionTurnMetric(session.metrics) : "unknown turns"}.`
  const summary = workspaceStrip.querySelector<HTMLElement>(".workspace-goal > summary")
  summary?.setAttribute("title", label)
  summary?.setAttribute("aria-label", label)
}

function goalWorkspaceDetail(session: NonNullable<ChatSnapshot["session"]>): string {
  const goal = session.goal
  const history = session.goalHistory ?? goal?.archivedGoals ?? []
  const metrics = session.metrics
  const durations = workspaceDurationValues(session)
  const sessionSeconds = durations.session
  const goalSeconds = durations.goal
  const goalSequence = goal?.sequence ?? (history.at(-1)?.sequence ?? 0) + 1
  const goalStatus = goalStateLabel(goal?.status)
  const goalTokens = goal?.tokensUsed ?? 0
  const goalTurns = goal?.turnsUsed ?? 0
  const statusAttention = goal && ["paused", "budgetLimited", "usageLimited", "unmet"].includes(goal.status ?? "")
  const triggerLabel = goal
    ? `Goal ${goalSequence}, ${goalStatus}: ${goalTokens.toLocaleString()} tokens, ${
      metricDuration(goalSeconds, true)
    } elapsed, ${goalTurns.toLocaleString()} turns. Session totals: ${
      metrics?.tokensUsed?.toLocaleString() ?? "unknown"
    } tokens, age ${metricDuration(sessionSeconds, true)}, ${metrics ? sessionTurnMetric(metrics) : "unknown turns"}.`
    : `Session totals: ${metrics?.tokensUsed?.toLocaleString() ?? "unknown"} tokens, age ${
      metricDuration(sessionSeconds, true)
    }, ${metrics ? sessionTurnMetric(metrics) : "unknown turns"}.`
  const trigger = goal
    ? `<span class="goal-strip-state${statusAttention ? " attention" : ""}"><span aria-hidden="true">${
      statusAttention ? "!" : "◎"
    }</span>${
      goalStatus === "Active" ? "" : `<span class="goal-strip-state-label">${escapeHtml(goalStatus)}</span>`
    }</span><span class="goal-strip-session">${
      compactMetric(metrics?.tokensUsed)
    } · <span data-workspace-duration="session">${escapeHtml(metricDuration(sessionSeconds))}</span> · ${
      metrics ? sessionTurnMetric(metrics, "t") : "--t"
    }</span><span class="goal-strip-separator" aria-hidden="true">›</span><b class="goal-strip-id">Goal ${goalSequence}</b><span class="goal-strip-objective">${
      escapeHtml(goal.objective || "Current goal")
    }</span><span class="goal-strip-tokens">${
      compactMetric(goalTokens)
    }</span><span class="goal-strip-time" data-workspace-duration="goal">${
      escapeHtml(metricDuration(goalSeconds))
    }</span><span class="goal-strip-turns">${goalTurns}t</span>`
    : `<span class="goal-strip-state"><span aria-hidden="true">◷</span><span class="goal-strip-state-label">Session</span></span><span class="goal-strip-session standalone">${
      compactMetric(metrics?.tokensUsed)
    } · <span data-workspace-duration="session">${escapeHtml(metricDuration(sessionSeconds))}</span> · ${
      metrics ? sessionTurnMetric(metrics, "t") : "--t"
    }</span>`
  const archivedRows = history.map((entry) =>
    goalMetricRow(
      `Goal ${entry.sequence}`,
      entry.objective,
      entry.status,
      entry.tokensUsed,
      entry.timeUsedSeconds,
      entry.turnsUsed,
    )
  ).join("")
  const currentRow = goal
    ? goalMetricRow(
      `Goal ${goalSequence}`,
      goal.objective || "Current goal",
      goal.status ?? "active",
      goalTokens,
      goalSeconds,
      goalTurns,
      true,
    )
    : ""
  const accountedTokens = history.reduce((total, entry) => total + entry.tokensUsed, 0) + goalTokens
  const accountedTurns = history.reduce((total, entry) => total + entry.turnsUsed, 0) + goalTurns
  const outsideTokens = Math.max(0, (metrics?.tokensUsed ?? accountedTokens) - accountedTokens)
  const outsideSeconds = durations.outside
  const outsideTurns = Math.max(0, (metrics?.turnsUsed ?? accountedTurns) - accountedTurns)
  const outsideTurnLabel = `${metrics?.turnsTruncated ? "≥" : ""}${outsideTurns.toLocaleString()} turns`
  const outside = outsideTokens || outsideSeconds || outsideTurns
    ? `<li class="goal-metric-row outside"><span class="goal-tree-branch" aria-hidden="true">└</span><span class="goal-metric-copy"><strong>Outside goals</strong><small>Tokens and turns outside goals; time is elapsed between goal periods</small></span><span>${outsideTokens.toLocaleString()} tokens</span><span data-workspace-duration="outside" data-duration-detailed="true">${
      escapeHtml(metricDuration(outsideSeconds, true))
    }</span><span>${outsideTurnLabel}</span></li>`
    : ""
  const criteria = goal?.acceptanceCriteria?.length
    ? `<section class="goal-popover-section"><h3>Done when</h3><ol>${
      goal.acceptanceCriteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("")
    }</ol></section>`
    : ""
  const checkpoint = goal?.checkpoint
    ? `<section class="goal-popover-section"><h3>Last checkpoint</h3><p>${escapeHtml(goal.checkpoint)}</p></section>`
    : ""
  const verdict = goal?.latestVerdict
    ? `<section class="goal-popover-section"><h3>Latest verification</h3><p><strong>${
      escapeHtml(verdictLabel(goal.latestVerdict.verdict))
    }</strong> · ${escapeHtml(goal.latestVerdict.confidence)} confidence</p><p>${
      escapeHtml(goal.latestVerdict.reason)
    }</p></section>`
    : ""
  const toggle = goal?.status === "active" ? "pause" : goal?.status === "paused" ? "resume" : undefined
  const actions = goal
    ? `<div class="goal-popover-actions">${
      toggle
        ? `<button type="button" data-goal-action="${toggle}">${toggle === "pause" ? "Pause" : "Resume"}</button>`
        : ""
    }<button type="button" data-goal-action="verify"${
      goal.verifier?.enabled === false ? ` title="Verification is disabled in goal settings"` : ""
    }>Verify now</button><button type="button" data-goal-action="edit">Edit</button><button type="button" class="danger-action" data-goal-action="cancel">Stop</button></div>`
    : ""
  return `<details class="workspace-detail workspace-goal${statusAttention ? " attention" : ""}"><summary title="${
    escapeHtml(triggerLabel)
  }" aria-label="${
    escapeHtml(triggerLabel)
  }">${trigger}</summary><div class="workspace-detail-popover goal-workspace-popover" popover="auto"><header><div><strong>${
    goal ? `Goal ${goalSequence}` : "Session totals"
  }</strong>${goal ? `<small>${escapeHtml(goalStatus)}</small>` : ""}</div>${
    goal ? `<p>${escapeHtml(goal.objective || "Current goal")}</p>` : ""
  }</header><section class="goal-popover-section goal-metrics"><h3>Session totals</h3><div class="session-metric-row"><strong>Session age</strong><span>${
    metrics?.tokensUsed?.toLocaleString() ?? "--"
  } tokens</span><span data-workspace-duration="session" data-duration-detailed="true" title="Elapsed since this session was created">${
    escapeHtml(metricDuration(sessionSeconds, true))
  }</span><span>${metrics ? sessionTurnMetric(metrics) : "-- turns"}</span></div>${
    archivedRows || currentRow || outside
      ? `<ol>${archivedRows}${currentRow}${outside}</ol>`
      : `<p>No goals have been recorded in this session.</p>`
  }</section>${criteria}${checkpoint}${verdict}${actions}</div></details>`
}

function workspaceElementKey(element: Element): string | undefined {
  if (element.id) return `id:${element.id}`
  if (element instanceof HTMLDetailsElement && element.classList.contains("workspace-detail")) {
    const kind = [...element.classList].find((value) => value.startsWith("workspace-") && value !== "workspace-detail")
    if (kind) return `detail:${kind}`
  }
  if (element instanceof HTMLElement && element.dataset.goalAction) return `goal-action:${element.dataset.goalAction}`
  return undefined
}

function compatibleWorkspaceNode(current: Node, incoming: Node): boolean {
  if (current.nodeType !== incoming.nodeType) return false
  if (!(current instanceof Element) || !(incoming instanceof Element)) return true
  if (current.tagName !== incoming.tagName) return false
  const currentKey = workspaceElementKey(current)
  const incomingKey = workspaceElementKey(incoming)
  return currentKey === undefined && incomingKey === undefined || currentKey === incomingKey
}

function reconcileWorkspaceAttributes(current: Element, incoming: Element): void {
  const preserveOpen = current instanceof HTMLDetailsElement && current.open
  const preservePopoverPosition = current instanceof HTMLElement && current.hasAttribute("popover")
  for (const attribute of [...current.attributes]) {
    if ((preserveOpen && attribute.name === "open") || (preservePopoverPosition && attribute.name === "style")) continue
    if (!incoming.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
  }
  for (const attribute of [...incoming.attributes]) {
    if (preservePopoverPosition && attribute.name === "style") continue
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value)
  }
  if (preserveOpen && current instanceof HTMLDetailsElement) current.open = true
}

function reconcileWorkspaceNode(current: Node, incoming: Node): void {
  if (current instanceof Element && incoming instanceof Element) {
    reconcileWorkspaceAttributes(current, incoming)
    reconcileWorkspaceChildren(current, incoming)
  } else if (current.nodeValue !== incoming.nodeValue) current.nodeValue = incoming.nodeValue
}

function reconcileWorkspaceChildren(current: Node & ParentNode, incoming: Node & ParentNode): void {
  let cursor = current.firstChild
  for (const incomingChild of [...incoming.childNodes]) {
    let match = cursor
    if (!match || !compatibleWorkspaceNode(match, incomingChild)) {
      match = cursor?.nextSibling ?? null
      while (match && !compatibleWorkspaceNode(match, incomingChild)) match = match.nextSibling
    }
    if (!match) {
      current.insertBefore(incomingChild.cloneNode(true), cursor)
      continue
    }
    while (cursor && cursor !== match) {
      const obsolete = cursor
      cursor = cursor.nextSibling
      current.removeChild(obsolete)
    }
    reconcileWorkspaceNode(match, incomingChild)
    cursor = match.nextSibling
  }
  while (cursor) {
    const next = cursor.nextSibling
    current.removeChild(cursor)
    cursor = next
  }
}

function reconcileWorkspaceStrip(markup: string): void {
  const template = document.createElement("template")
  template.innerHTML = markup
  const focused = workspaceStrip.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined
  const focusedOwner = focused?.closest<HTMLDetailsElement>(".workspace-detail")
  const ownerKey = focusedOwner ? workspaceElementKey(focusedOwner) : undefined
  reconcileWorkspaceChildren(workspaceStrip, template.content)
  if (focused && !focused.isConnected && ownerKey) {
    const restored = [...workspaceStrip.querySelectorAll<HTMLDetailsElement>(".workspace-detail")].find((detail) =>
      workspaceElementKey(detail) === ownerKey
    )
    restored?.querySelector<HTMLElement>("summary")?.focus()
  }
  scheduleViewportLayout()
}

function renderWorkspaceStrip(session?: NonNullable<ChatSnapshot["session"]>): void {
  const runtime = snapshot.runtime
  const metrics = session?.metrics
    ? { ...session.metrics, timeUsedSeconds: undefined, sampledAt: undefined }
    : undefined
  const goal = session?.goal ? { ...session.goal, timeUsedSeconds: undefined, sampledAt: undefined } : undefined
  const hasOutsideDuration = session ? workspaceDurationValues(session).outside > 0 : false
  const signature = JSON.stringify([
    snapshot.connected,
    snapshot.connectionState,
    snapshot.health,
    runtime?.lsp,
    runtime?.formatters,
    runtime?.mcp,
    session?.context,
    metrics,
    goal,
    session?.goalHistory,
    hasOutsideDuration,
  ])
  if (signature === workspaceSignature) {
    if (session) syncWorkspaceDurations(session)
    return
  }
  workspaceSignature = signature
  const lspHealthy = runtime?.lsp.filter((service) => runtimeServicePresentation(service, "lsp").healthy).length ?? 0
  const formatterHealthy =
    runtime?.formatters.filter((service) => runtimeServicePresentation(service, "formatter").healthy).length ?? 0
  const mcpHealthy = runtime?.mcp.filter((service) => runtimeServicePresentation(service, "mcp").healthy).length ?? 0
  const context = session?.context
  const left = healthWorkspaceDetail()
  const center = session ? goalWorkspaceDetail(session) : ""
  const lsp = runtime?.lsp ?? []
  const formatters = runtime?.formatters ?? []
  const mcp = runtime?.mcp ?? []
  const lspTooltip = lsp.map(serviceLabel).join("\n")
  const formatterTooltip = formatters.map((formatter) =>
    `${formatter.name || formatter.id}: ${formatter.enabled ? "available" : "executable not found"}`
  ).join("\n")
  const mcpTooltip = mcp.map(serviceLabel).join("\n")
  const healthRows = [
    ...(lsp.length ? [["LSP", `${lspHealthy}/${lsp.length}`]] : []),
    ...(formatters.length ? [["Formatters", `${formatterHealthy}/${formatters.length}`]] : []),
    ...(mcp.length ? [["MCP", `${mcpHealthy}/${mcp.length}`]] : []),
    ...(context
      ? [["Context", context.usagePercent === undefined ? "--" : `${Math.round(context.usagePercent)}%`]]
      : []),
  ]
  const hasRuntimeServices = Boolean(lsp.length || formatters.length || mcp.length)
  const aggregateLabel = hasRuntimeServices
    ? "Health"
    : context
    ? `Context ${context.usagePercent === undefined ? "--" : `${Math.round(context.usagePercent)}%`}`
    : ""
  const aggregateHealth = healthRows.length
    ? workspaceDetail(
      "services",
      aggregateLabel,
      "Workspace health",
      `<dl class="workspace-context-list">${
        healthRows.map(([label, value]) => `<div><dt>${escapeHtml(label!)}</dt><dd>${escapeHtml(value!)}</dd></div>`)
          .join("")
      }</dl>`,
      [lspTooltip, formatterTooltip, mcpTooltip].filter(Boolean).join("\n"),
    )
    : ""
  const right = [
    aggregateHealth,
    lsp.length
      ? workspaceDetail(
        "lsp",
        `LSP ${lspHealthy}/${lsp.length}`,
        "Language servers",
        serviceList(lsp, "lsp"),
        lspTooltip,
      )
      : "",
    formatters.length
      ? workspaceDetail(
        "formatter",
        `Fmt ${formatterHealthy}/${formatters.length}`,
        "Formatters",
        serviceList(formatters, "formatter"),
        formatterTooltip,
      )
      : "",
    mcp.length
      ? workspaceDetail("mcp", `MCP ${mcpHealthy}/${mcp.length}`, "MCP servers", serviceList(mcp, "mcp"), mcpTooltip)
      : "",
    context
      ? workspaceDetail(
        "context",
        `Context ${context.usagePercent === undefined ? "--" : `${Math.round(context.usagePercent)}%`}`,
        "Context usage",
        contextDetails(context),
        context.model ?? "Context usage",
      )
      : `<span>Context --</span>`,
  ].filter(Boolean).join("")
  reconcileWorkspaceStrip(
    `<span class="workspace-left">${left}</span><div class="workspace-center">${center}</div><div class="workspace-right">${right}</div>`,
  )
}

function resizeDraft(): void {
  draft.style.height = "auto"
  draft.style.height = `${Math.min(Math.max(draft.scrollHeight, 46), 180)}px`
}

function sessionAttachments(sessionID = snapshot.session?.id): InlineAttachment[] {
  return sessionID ? attachments.get(sessionID) ?? [] : []
}

function sessionPastedText(sessionID = snapshot.session?.id): PastedTextBlock[] {
  return sessionID ? pastedText.get(sessionID) ?? [] : []
}

function sessionContextAttachments(sessionID = snapshot.session?.id): ContextAttachmentSummary[] {
  return sessionID ? contextAttachments.get(sessionID) ?? [] : []
}

function normalizeComposerLabels(payload: ComposerPayloadState): ComposerPayloadState {
  let image = 1
  let pdf = 1
  const normalizedAttachments = payload.attachments.map((attachment) => ({
    ...attachment,
    label: attachment.mime === "application/pdf"
      ? attachmentReference("PDF", pdf++)
      : attachmentReference("Image", image++),
  }))
  const normalizedPastes = payload.pastedText.map((block, index) => ({
    ...block,
    label: pastedTextReference(index + 1, block.lineCount),
  }))
  return { attachments: normalizedAttachments, pastedText: normalizedPastes }
}

function composerPayloadCanSync(payload: ComposerPayloadState): boolean {
  const attachmentCharacters = payload.attachments.reduce(
    (total, attachment) =>
      total + attachment.id.length + attachment.label.length + attachment.name.length + attachment.mime.length +
      attachment.data.length,
    0,
  )
  const pastedCharacters = payload.pastedText.reduce(
    (total, block) => total + block.id.length + block.label.length + block.text.length,
    0,
  )
  return payload.attachments.length <= INLINE_ATTACHMENT_COUNT_LIMIT &&
    payload.attachments.length + payload.pastedText.length <= PROMPT_ATTACHMENT_COUNT_LIMIT &&
    attachmentCharacters <= 20_000_000 && pastedCharacters <= PROMPT_TEXT_CHARACTER_LIMIT
}

function reconcileComposerReferences(sessionID: string, previousLabels: string[], payload: ComposerPayloadState): void {
  if (sessionID !== snapshot.session?.id) return
  let value = draft.value
  for (const label of new Set(previousLabels)) value = value.replaceAll(label, "")
  value = value.replace(/[ \t]{2,}/g, " ").trim()
  const labels = [
    ...payload.attachments.map((attachment) => attachment.label),
    ...payload.pastedText.map((block) => block.label),
  ]
  draft.value = [value, labels.join(" ")].filter(Boolean).join(" ")
  postDraftNow(sessionID, draft.value)
  resizeDraft()
}

function renderAttachments(): void {
  const sessionID = snapshot.session?.id
  const inline = sessionAttachments(sessionID)
  const pasted = sessionPastedText(sessionID)
  const context = sessionContextAttachments(sessionID)
  attachmentDock.hidden = Boolean(pendingSessionID) || !sessionID ||
    (!editorContext && !context.length && !inline.length && !pasted.length)
  attachmentDock.innerHTML = sessionID
    ? [
      editorContext && !editorContext.attached
        ? `<button type="button" class="attachment-chip implicit-context" data-add-editor-context title="Add ${
          escapeHtml(editorContext.name)
        }${editorContext.detail ? ` · ${escapeHtml(editorContext.detail)}` : ""}"><b>+</b><span>${
          escapeHtml(editorContext.name)
        }</span></button>`
        : "",
      ...context.map((attachment) =>
        `<span class="attachment-chip context-chip context-${escapeHtml(attachment.kind)}" title="${
          escapeHtml(`${attachment.name}${attachment.detail ? ` · ${attachment.detail}` : ""}`)
        }">${
          attachment.kind === "folder" ? FOLDER_ICON : FILE_ICON
        }<button type="button" class="context-chip-copy" data-open-context="${
          escapeHtml(attachment.id)
        }" aria-label="Open ${escapeHtml(attachment.name)}"><strong>${
          escapeHtml(attachment.name)
        }</strong></button><button type="button" data-remove-context="${
          escapeHtml(attachment.id)
        }" title="Remove from context" aria-label="Remove ${
          escapeHtml(attachment.name)
        } from context">×</button></span>`
      ),
      ...inline.map((attachment) => {
        const metadata = `${attachment.name} · ${attachment.mime} · ${formatBytes(attachment.size)}${
          attachment.width && attachment.height ? ` · ${attachment.width}×${attachment.height}` : ""
        }`
        const thumbnail = attachmentThumbnails.get(attachment.id)
        return `<span class="attachment-card" title="${escapeHtml(metadata)}">${
          attachment.mime.startsWith("image/") && thumbnail
            ? `<button type="button" class="attachment-thumbnail" data-preview-attachment="${
              escapeHtml(attachment.id)
            }" aria-label="Preview ${escapeHtml(attachment.label)}"><img src="${thumbnail}" alt=""></button>`
            : `<span class="attachment-file-icon" aria-hidden="true">${
              attachment.mime === "application/pdf" ? "PDF" : "IMG"
            }</span>`
        }<span class="attachment-card-copy"><strong>${
          escapeHtml(attachment.label)
        }</strong></span><button type="button" class="attachment-remove" data-remove-attachment="${
          escapeHtml(attachment.id)
        }" title="Remove attachment" aria-label="Remove ${escapeHtml(attachment.label)}">×</button></span>`
      }),
      ...pasted.map((block) =>
        `<details class="attachment-card pasted-text-card"><summary><span class="attachment-file-icon" aria-hidden="true">TXT</span><span class="attachment-card-copy"><strong>${
          escapeHtml(block.label)
        }</strong><small>${block.text.length.toLocaleString()} characters</small></span></summary><div class="pasted-text-detail"><pre>${
          escapeHtml(block.text)
        }</pre><div class="permission-actions"><button type="button" data-copy-paste="${
          escapeHtml(block.id)
        }">Copy</button><button type="button" data-remove-paste="${
          escapeHtml(block.id)
        }">Remove</button></div></div></details>`
      ),
    ].join("")
    : ""
}

function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`
  if (value < 1_000_000) return `${Math.round(value / 100) / 10} KB`
  return `${Math.round(value / 100_000) / 10} MB`
}

function openAttachmentPreview(
  title: string,
  source: string,
  alt: string,
  metadata: string,
  returnFocus: HTMLElement,
): void {
  attachmentPreviewReturnFocus = returnFocus
  attachmentPreviewTitle.textContent = title
  attachmentPreviewImage.src = source
  attachmentPreviewImage.alt = alt
  attachmentPreviewMeta.textContent = metadata
  attachmentPreview.hidden = false
  attachmentPreview.querySelector<HTMLButtonElement>("[data-close-attachment-preview]")?.focus()
}

function closeAttachmentPreview(): void {
  attachmentPreview.hidden = true
  attachmentPreviewImage.removeAttribute("src")
  const returnFocus = attachmentPreviewReturnFocus
  attachmentPreviewReturnFocus = undefined
  if (returnFocus?.isConnected) returnFocus.focus()
  else draft.focus()
}

function attachmentOrdinal(kind: "Image" | "PDF", values = sessionAttachments()): number {
  return values.reduce((maximum, attachment) => {
    const match = new RegExp(`^\\[${kind} (\\d+)\\]$`).exec(attachment.label)
    return Math.max(maximum, Number(match?.[1] ?? 0))
  }, 0) + 1
}

function pastedTextOrdinal(values = sessionPastedText()): number {
  return values.reduce(
    (maximum, block) => Math.max(maximum, Number(/^\[Pasted text (\d+)/.exec(block.label)?.[1] ?? 0)),
    0,
  ) + 1
}

async function imageDimensions(url: string): Promise<{ width?: number; height?: number }> {
  return await new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth || undefined, height: image.naturalHeight || undefined })
    image.onerror = () => resolve({})
    image.src = url
  })
}

async function imageThumbnail(url: string): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const scale = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext("2d")
      if (!context) {
        resolve(undefined)
        return
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL("image/webp", .78))
    }
    image.onerror = () => resolve(undefined)
    image.src = url
  })
}

async function cacheAttachmentThumbnails(values: InlineAttachment[]): Promise<void> {
  await Promise.all(
    values.filter((attachment) => attachment.mime.startsWith("image/") && !attachmentThumbnails.has(attachment.id)).map(
      async (attachment) => {
        const thumbnail = await imageThumbnail(`data:${attachment.mime};base64,${attachment.data}`)
        if (thumbnail) attachmentThumbnails.set(attachment.id, thumbnail)
      },
    ),
  )
}

async function inlineAttachment(file: File, label: string): Promise<InlineAttachment> {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type
  if (!["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mime)) {
    throw new Error(`Unsupported attachment type: ${mime || file.name}`)
  }
  const maxBytes = mime === "application/pdf" ? 10_000_000 : 3_900_000
  if (file.size > maxBytes) throw new Error(`${file.name} exceeds ${mime === "application/pdf" ? "10 MB" : "3.9 MB"}`)
  const result = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read attachment"))
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment"))
    reader.readAsDataURL(file)
  })
  const data = result.slice(result.indexOf(",") + 1)
  const dimensions = mime.startsWith("image/") ? await imageDimensions(result) : {}
  const id = crypto.randomUUID()
  return {
    id,
    label,
    name: file.name.slice(0, 255) || "attachment",
    mime: mime as InlineAttachment["mime"],
    data,
    size: file.size,
    ...dimensions,
  }
}

function syncComposerPayload(sessionID = snapshot.session?.id): void {
  if (!sessionID) return
  const revision = composerPayloadRevisions.get(sessionID) ?? 0
  const payload = { attachments: sessionAttachments(sessionID), pastedText: sessionPastedText(sessionID) }
  const base = acknowledgedComposerPayloads.get(sessionID) ?? { attachments: [], pastedText: [] }
  const mutationID = `cmp_${crypto.randomUUID().replaceAll("-", "")}`
  composerPayloadRevisions.set(sessionID, revision + 1)
  pendingComposerPayloads.set(sessionID, { revision: revision + 1, mutationID, base, ...payload })
  post({ type: "setComposerPayload", sessionID, revision, mutationID, ...payload })
}

async function addInlineFiles(files: File[]): Promise<void> {
  const sessionID = snapshot.session?.id
  if (!sessionID || !files.length) return
  attachmentDock.setAttribute("aria-busy", "true")
  status.textContent = `Attaching ${files.length} file${files.length === 1 ? "" : "s"}…`
  try {
    const current = sessionAttachments(sessionID)
    const remaining = Math.max(
      0,
      Math.min(
        INLINE_ATTACHMENT_COUNT_LIMIT - current.length,
        PROMPT_ATTACHMENT_COUNT_LIMIT - current.length - sessionPastedText(sessionID).length,
      ),
    )
    if (!remaining) {
      throw new Error(
        current.length >= INLINE_ATTACHMENT_COUNT_LIMIT
          ? `This prompt already has ${INLINE_ATTACHMENT_COUNT_LIMIT} image or PDF attachments`
          : `This prompt already has ${PROMPT_ATTACHMENT_COUNT_LIMIT} file and pasted-text attachments`,
      )
    }
    let image = attachmentOrdinal("Image", current)
    let pdf = attachmentOrdinal("PDF", current)
    const added = await Promise.all(
      files.slice(0, remaining).map((file) =>
        inlineAttachment(
          file,
          file.type === "application/pdf" ? attachmentReference("PDF", pdf++) : attachmentReference("Image", image++),
        )
      ),
    )
    const unique = added.filter((attachment) =>
      !current.some((value) => value.mime === attachment.mime && value.data === attachment.data)
    )
    if (!unique.length) {
      status.textContent = "Already attached"
      status.title = "This attachment is already in the prompt."
      return
    }
    const combined = [...current, ...unique]
    const characters = combined.reduce(
      (total, attachment) =>
        total + attachment.id.length + attachment.label.length + attachment.name.length + attachment.mime.length +
        attachment.data.length,
      0,
    )
    if (characters > 20_000_000) throw new Error("Attachments exceed the 20 MB prompt payload limit")
    await cacheAttachmentThumbnails(unique)
    attachments.set(sessionID, combined)
    clearNotice("error")
    insertComposerText(unique.map((attachment) => attachment.label).join(" "))
    syncComposerPayload(sessionID)
    renderAttachments()
    updatePrimaryAction()
    status.textContent = ""
    status.title = ""
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status.textContent = message
    status.title = message
    showNotice("error", "Could not attach file", message)
  } finally {
    attachmentDock.setAttribute("aria-busy", "false")
  }
}

function addPastedText(value: string): void {
  const sessionID = snapshot.session?.id
  if (!sessionID) return
  const normalized = value.replace(/\r\n?/g, "\n")
  const current = sessionPastedText(sessionID)
  if (current.some((block) => block.text === normalized)) {
    status.textContent = "Already pasted"
    status.title = "This pasted block is already in the prompt."
    return
  }
  if (
    current.length + sessionAttachments(sessionID).length >= PROMPT_ATTACHMENT_COUNT_LIMIT ||
    current.reduce((total, block) => total + block.text.length, 0) + normalized.length > PROMPT_TEXT_CHARACTER_LIMIT
  ) {
    const message =
      `Pasted text exceeds the ${PROMPT_TEXT_CHARACTER_LIMIT.toLocaleString()}-character or ${PROMPT_ATTACHMENT_COUNT_LIMIT}-attachment prompt limit`
    status.textContent = "Paste too large"
    status.title = message
    showNotice("error", "Could not add pasted text", message)
    return
  }
  const lineCount = (normalized.match(/\n/g)?.length ?? 0) + 1
  const ordinal = pastedTextOrdinal(current)
  const block: PastedTextBlock = {
    id: crypto.randomUUID(),
    label: pastedTextReference(ordinal, lineCount),
    text: normalized,
    lineCount,
  }
  pastedText.set(sessionID, [...current, block])
  insertComposerText(block.label)
  syncComposerPayload(sessionID)
  renderAttachments()
}

function removeDraftLabel(sessionID: string, label: string): void {
  const index = draft.value.indexOf(label)
  if (index < 0) return
  const before = draft.value.slice(0, index).replace(/[ \t]+$/, "")
  const after = draft.value.slice(index + label.length).replace(/^[ \t]+/, "")
  draft.value = before && after ? `${before} ${after}` : `${before}${after}`
  postDraftNow(sessionID, draft.value)
  resizeDraft()
}

function insertComposerText(text: string): void {
  const sessionID = snapshot.session?.id
  if (!text) {
    draft.focus()
    return
  }
  const start = draft.selectionStart
  const end = draft.selectionEnd
  const before = draft.value.slice(0, start)
  const after = draft.value.slice(end)
  const prefix = before && !/\s$/.test(before) ? " " : ""
  const suffix = after && !/^\s/.test(after) ? " " : ""
  draft.value = `${before}${prefix}${text}${suffix}${after}`
  const cursor = before.length + prefix.length + text.length + suffix.length
  draft.setSelectionRange(cursor, cursor)
  if (sessionID) postDraftNow(sessionID, draft.value)
  resizeDraft()
  updatePrimaryAction()
  draft.focus()
}

function updatePrimaryAction(): void {
  const closeSendOptions = (): void => {
    sendOptions.hidden = true
    sendOptions.open = false
    sendGroup.classList.remove("split")
  }
  if (creatingSession) {
    closeSendOptions()
    send.dataset.action = "idle"
    send.disabled = true
    send.classList.remove("stop-action", "queue-action")
    send.innerHTML = PRIMARY_ICONS.send
    send.title = "Starting new session…"
    send.setAttribute("aria-label", "Starting new session")
    return
  }
  if (pendingSessionID) {
    closeSendOptions()
    send.dataset.action = "idle"
    send.disabled = true
    send.classList.remove("stop-action", "queue-action")
    send.innerHTML = PRIMARY_ICONS.send
    send.title = "Loading session"
    send.setAttribute("aria-label", "Loading session")
    return
  }
  const session = snapshot.session
  if (sessionLoadPhase(session) === "initial") {
    closeSendOptions()
    send.dataset.action = "idle"
    send.disabled = true
    send.classList.remove("stop-action", "queue-action")
    send.innerHTML = PRIMARY_ICONS.send
    send.title = "Loading session"
    send.setAttribute("aria-label", "Loading session")
    return
  }
  const hasDraft = Boolean(
    draft.value.trim() || sessionAttachments(session?.id).length || sessionPastedText(session?.id).length ||
      sessionContextAttachments(session?.id).length,
  )
  if (!session) {
    closeSendOptions()
    send.dataset.action = hasDraft ? "send" : "idle"
    send.disabled = !snapshot.connected || !hasDraft || !capabilityAvailable("session.create") ||
      !capabilityAvailable("prompt.followUp")
    send.classList.remove("stop-action", "queue-action")
    send.innerHTML = PRIMARY_ICONS.send
    send.title = hasDraft ? "Start new session" : "Send message"
    send.setAttribute("aria-label", send.title)
    return
  }
  const active = session.status.type === "busy" || session.status.type === "retry"
  if (stoppingSessionID === session?.id && !active) stoppingSessionID = undefined
  const stopping = stoppingSessionID === session?.id
  const action = stopping ? "stopping" : active ? hasDraft ? "queue" : "stop" : hasDraft ? "send" : "idle"
  send.dataset.action = action
  const requiredCapability = action === "stop" || action === "stopping"
    ? "prompt.cancel"
    : action === "queue" || action === "send"
    ? "prompt.followUp"
    : undefined
  send.disabled = !session || !snapshot.connected || action === "idle" || action === "stopping" ||
    (requiredCapability !== undefined && !capabilityAvailable(requiredCapability))
  send.classList.toggle("stop-action", action === "stop" || action === "stopping")
  send.classList.toggle("queue-action", action === "queue")
  const hasSendOptions = snapshot.connected && hasDraft
  sendOptions.hidden = !hasSendOptions
  if (!hasSendOptions) sendOptions.open = false
  sendGroup.classList.toggle("split", hasSendOptions)
  for (const button of sendOptions.querySelectorAll<HTMLButtonElement>("[data-send-delivery]")) {
    button.hidden = action !== "queue"
  }
  const multiButton = sendOptions.querySelector<HTMLButtonElement>("[data-send-multi-model]")
  if (multiButton) multiButton.disabled = !draft.value.trim()
  send.innerHTML = PRIMARY_ICONS[action === "idle" ? "send" : action as keyof typeof PRIMARY_ICONS]
  const label = action === "stopping"
    ? "Stopping response…"
    : action === "stop"
    ? "Stop response (Esc)"
    : action === "queue"
    ? "Add to Queue (Enter)"
    : "Send message"
  send.title = label
  send.setAttribute("aria-label", label)
}

function capabilityAvailable(capability: WorkbenchCapability): boolean {
  return negotiatedCapabilities?.[capability] ?? true
}

function applyCapabilityControls(): void {
  if (!negotiatedCapabilities) return
  createHeader.disabled ||= !capabilityAvailable("session.create")
  createEmpty.disabled ||= !capabilityAvailable("session.create")
  const createMenu = sessionMenu.querySelector<HTMLButtonElement>('[data-menu-command="create"]')
  if (createMenu) createMenu.disabled = !capabilityAvailable("session.create")
  for (
    const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-session-action="fork"], [data-message-action="fork"]',
    )
  ) {
    button.disabled = !capabilityAvailable("session.fork")
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-session-action="delete"]')) {
    button.disabled = !capabilityAvailable("session.delete")
  }
  for (const button of sendOptions.querySelectorAll<HTMLButtonElement>("[data-send-delivery]")) {
    const capability = button.dataset.sendDelivery === "steer"
      ? "prompt.steer"
      : button.dataset.sendDelivery === "replace"
      ? "prompt.replace"
      : "prompt.followUp"
    button.disabled = !capabilityAvailable(capability)
  }
  for (const button of permissionDock.querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = !capabilityAvailable("input.permissions.exact")
  }
  for (const control of questionDock.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) {
    control.disabled = !capabilityAvailable("input.questions")
  }
  for (const button of workspaceStrip.querySelectorAll<HTMLButtonElement>("[data-goal-action]")) {
    button.disabled = !capabilityAvailable("goal.lifecycle")
  }
  updatePrimaryAction()
}

function matchingCommands(): NonNullable<ChatSnapshot["commands"]> {
  const match = /^\/([^\s/]*)$/.exec(draft.value.trimStart())
  if (!match) return []
  const query = match[1]!.toLowerCase()
  return (snapshot.commands ?? [])
    .filter((command) => !query || command.name.toLowerCase().includes(query))
    .sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(query)
      const rightStarts = right.name.toLowerCase().startsWith(query)
      return Number(rightStarts) - Number(leftStarts) || left.name.localeCompare(right.name)
    })
    .slice(0, 8)
}

function renderCommandSuggestions(): void {
  const commands = matchingCommands()
  const query = /^\/([^\s/]*)$/.exec(draft.value.trimStart())?.[1] ?? ""
  const signature = JSON.stringify([commands, selectedCommandIndex, query])
  if (signature === commandSignature) return
  commandSignature = signature
  selectedCommandIndex = Math.min(selectedCommandIndex, Math.max(0, commands.length - 1))
  commandSuggestions.hidden = commands.length === 0
  commandSuggestions.innerHTML = commands.map((command, index) =>
    `<button id="command-option-${index}" type="button" role="option" aria-selected="${
      index === selectedCommandIndex
    }" data-command-name="${escapeHtml(command.name)}"><strong>/${escapeHtml(command.name)}</strong><span>${
      escapeHtml(command.description || command.source || "OpenCode command")
    }</span></button>`
  ).join("")
  draft.setAttribute("aria-expanded", String(!commandSuggestions.hidden || !fileSuggestionList.hidden))
  if (commands.length) draft.setAttribute("aria-activedescendant", `command-option-${selectedCommandIndex}`)
}

function chooseCommand(index = selectedCommandIndex): void {
  const command = matchingCommands()[index]
  const sessionID = snapshot.session?.id
  if (!command) return
  draft.value = `/${command.name} `
  if (sessionID) postDraftNow(sessionID, draft.value)
  renderCommandSuggestions()
  resizeDraft()
  draft.focus()
}

function fileMentionAtCursor(): { start: number; query: string } | undefined {
  const before = draft.value.slice(0, draft.selectionStart)
  const match = /(?:^|\s)@<?([A-Za-z0-9._~/-]*)$/.exec(before)
  if (!match) return undefined
  return { start: before.lastIndexOf("@"), query: match[1] ?? "" }
}

interface MentionSuggestion {
  kind: "file" | "agent" | "resource"
  value: string
  label: string
  detail: string
}

function currentMentionSuggestions(): MentionSuggestion[] {
  const mention = fileMentionAtCursor()
  if (!mention) return []
  const query = mention.query.toLowerCase()
  const agents: MentionSuggestion[] = (snapshot.mentionAgents ?? [])
    .filter((item) =>
      /^[A-Za-z0-9._-]+$/.test(item.name) &&
      (!query || `${item.name}\n${item.description ?? ""}`.toLowerCase().includes(query))
    )
    .map((item) => ({
      kind: "agent",
      value: item.name,
      label: `@${item.name}`,
      detail: item.description || "OpenCode agent",
    }))
  const resources: MentionSuggestion[] = (snapshot.resources ?? [])
    .filter((item) => !query || `${item.name}\n${item.client}\n${item.description ?? ""}`.toLowerCase().includes(query))
    .map((item) => ({ kind: "resource", value: item.uri, label: item.name, detail: `${item.client} · MCP resource` }))
  const files: MentionSuggestion[] = suggestedFiles.map((file) => ({
    kind: "file",
    value: file,
    label: fileName(file),
    detail: file,
  }))
  return [...agents, ...resources, ...files].slice(0, 24)
}

function renderFileSuggestions(): void {
  const suggestions = currentMentionSuggestions()
  selectedFileIndex = Math.min(selectedFileIndex, Math.max(0, suggestions.length - 1))
  fileSuggestionList.hidden = suggestions.length === 0
  fileSuggestionList.innerHTML = suggestions.map((item, index) =>
    `<button id="mention-option-${index}" type="button" role="option" aria-selected="${
      index === selectedFileIndex
    }" data-mention-index="${index}"><strong>${escapeHtml(item.label)}</strong><span>${
      escapeHtml(item.detail)
    }</span></button>`
  ).join("")
  draft.setAttribute("aria-expanded", String(!commandSuggestions.hidden || !fileSuggestionList.hidden))
  if (suggestions.length) draft.setAttribute("aria-activedescendant", `mention-option-${selectedFileIndex}`)
  else if (commandSuggestions.hidden) draft.removeAttribute("aria-activedescendant")
}

function announce(value: string): void {
  pendingAnnouncement = value.slice(-500)
  if (announcementTimer !== undefined) return
  announcementTimer = window.setTimeout(() => {
    announcementTimer = undefined
    announcer.textContent = pendingAnnouncement
    pendingAnnouncement = ""
  }, 250)
}

function requestFileSuggestions(): void {
  if (fileSearchTimer !== undefined) window.clearTimeout(fileSearchTimer)
  const requestID = ++fileRequestID
  const mention = fileMentionAtCursor()
  const sessionID = snapshot.session?.id
  if (!mention || !sessionID) {
    suggestedFiles = []
    renderFileSuggestions()
    return
  }
  renderFileSuggestions()
  fileSearchTimer = window.setTimeout(() => {
    fileSearchTimer = undefined
    post({ type: "searchFiles", sessionID, requestID, query: mention.query })
  }, 100)
}

function chooseFile(index = selectedFileIndex): void {
  const mention = fileMentionAtCursor()
  const suggestion = currentMentionSuggestions()[index]
  if (!mention || !suggestion) return
  const cursor = draft.selectionStart
  const sessionID = snapshot.session?.id
  if (!sessionID) return
  const replacement = suggestion.kind === "agent"
    ? `@${suggestion.value} `
    : suggestion.kind === "file"
    ? `@<${suggestion.value}> `
    : ""
  draft.value = `${draft.value.slice(0, mention.start)}${replacement}${draft.value.slice(cursor)}`
  const next = mention.start + replacement.length
  draft.setSelectionRange(next, next)
  postDraftNow(sessionID, draft.value)
  if (suggestion.kind === "file") post({ type: "attachWorkspacePath", sessionID, path: suggestion.value })
  else if (suggestion.kind === "resource") post({ type: "attachResource", sessionID, uri: suggestion.value })
  suggestedFiles = []
  renderFileSuggestions()
  resizeDraft()
  updatePrimaryAction()
  draft.focus()
}

function updateActivityTimers(): void {
  for (const timer of document.querySelectorAll<HTMLElement>("[data-start-time]")) {
    const start = Number(timer.dataset.startTime)
    if (Number.isFinite(start)) timer.textContent = formatDuration(Math.max(0, Date.now() - start))
  }
}

function activeThrobberHtml(): string {
  return `<span class="active-throbber" aria-label="OpenCode is working">${
    Array.from({ length: 8 }, () => `<i aria-hidden="true"></i>`).join("")
  }</span>`
}

function syncDraft(session?: NonNullable<ChatSnapshot["session"]>): void {
  if (!session) {
    if (draftSessionID !== undefined) draft.value = ""
    draftSessionID = undefined
    return
  }
  if (draftSessionID !== session.id) {
    if (pendingDraft?.sessionID !== session.id) flushPendingDraft()
    draftSessionID = session.id
    draft.value = localDrafts.get(session.id) ?? session.draft
  }
  const local = localDrafts.get(session.id)
  const submitted = submittedDrafts.get(session.id)
  if (submitted !== undefined && session.draft === "") {
    if (draft.value === submitted && (local === undefined || local === submitted)) {
      draft.value = ""
      localDrafts.delete(session.id)
      submittedDrafts.delete(session.id)
    }
    return
  }
  if (local !== undefined) {
    if (draft.value !== local) draft.value = local
    if (session.draft === local) {
      localDrafts.delete(session.id)
      if (submitted !== undefined && local !== submitted) submittedDrafts.delete(session.id)
    }
    return
  }
  if (draft.value !== session.draft) draft.value = session.draft
  if (submitted !== undefined && session.draft !== submitted) submittedDrafts.delete(session.id)
}

function cancelPendingDraft(): void {
  if (draftTimer !== undefined) window.clearTimeout(draftTimer)
  draftTimer = undefined
  pendingDraft = undefined
}

function flushPendingDraft(): void {
  const pending = pendingDraft
  cancelPendingDraft()
  if (pending) post({ type: "setDraft", sessionID: pending.sessionID, draft: pending.value })
}

function postDraftNow(sessionID: string, value: string): void {
  cancelPendingDraft()
  localDrafts.set(sessionID, value)
  post({ type: "setDraft", sessionID, draft: value })
}

function queueDraftUpdate(sessionID: string, value: string): void {
  pendingDraft = { sessionID, value }
  if (draftTimer !== undefined) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(flushPendingDraft, 150)
}

function renderCatalogs(session?: NonNullable<ChatSnapshot["session"]>): void {
  const signature = JSON.stringify([snapshot.agents, snapshot.models])
  if (signature !== catalogSignature) {
    catalogSignature = signature
    fillSelect(
      agent,
      "Default agent",
      snapshot.agents.map((item) => ({ value: item.name, label: item.name })),
      session?.agent,
    )
    fillSelect(
      model,
      "Default model",
      snapshot.models.map((item) => ({
        value: `${item.providerID}/${item.id}`,
        label: `${item.name} · ${item.providerID}`,
      })),
      session?.model,
    )
  } else {
    if (agent.value !== (session?.agent || "")) agent.value = session?.agent || ""
    if (model.value !== (session?.model || "")) model.value = session?.model || ""
  }
}

function syncAnimationTimers(active: boolean): void {
  const running = active && document.visibilityState === "visible"
  if (running && activityTimer === undefined) activityTimer = window.setInterval(updateActivityTimers, 1_000)
  if (!running && activityTimer !== undefined) {
    window.clearInterval(activityTimer)
    activityTimer = undefined
  }
}

function syncConnectionNotice(): boolean {
  const presentation = connectionPresentation(snapshot.connectionState, snapshot.connectionError)
  connection.hidden = !presentation.showNotice
  connection.textContent = presentation.label
  connection.classList.toggle("reconnecting", snapshot.connectionState === "reconnecting")
  if (presentation.showNotice) {
    const needsWorkspace = snapshot.connectionError?.startsWith("Open a trusted workspace folder")
    showNotice("offline", presentation.title, presentation.message, needsWorkspace ? "Open folder" : "Reload window")
  } else clearNotice("offline")
  return presentation.showNotice
}

function selectInspectorTab(tab: string, focusTab = true): void {
  if (!INSPECTOR_TABS.has(tab as InspectorTab)) return
  tab = consolidatedInspectorTab(tab)
  if (narrowWorkbench() && document.body.classList.contains("rail-open")) closeRail(false)
  if (!inspectorOpen) inspectorShell.toggle()
  inspectorOpen = inspectorShell.open
  inspectorShell.select(tab)
  inspectorTab = inspectorShell.tab as InspectorTab
  persistInspector()
  renderInspector()
  if (focusTab) requestAnimationFrame(() => inspectorPanel.focus())
}

function focusSessionWorkTrigger(): void {
  const target = sessionChangeSummary.querySelector<HTMLButtonElement>("button") ??
    workspaceStrip.querySelector<HTMLElement>(".workspace-goal > summary") ??
    sessionTaskDock.querySelector<HTMLButtonElement>("button") ??
    draft
  target.focus()
}

function focusAttentionElement(target?: HTMLElement): boolean {
  if (!target || target.closest("[hidden]")) return false
  target.scrollIntoView({ block: "center" })
  const focusTarget = target.matches("button, input, summary, [tabindex]") ? target : target.querySelector<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex='-1'])",
  )
  if (focusTarget) focusTarget.focus()
  else {
    target.tabIndex = -1
    target.focus()
  }
  return document.activeElement === focusTarget || document.activeElement === target
}

function routePendingAttention(): void {
  const pending = pendingAttentionTarget
  if (!pending || (pending.sessionID && snapshot.session?.id !== pending.sessionID)) return
  let target: HTMLElement | undefined
  if (pending.surface === "goal") {
    selectInspectorTab("goal", false)
    target = inspectorPanel
  } else if (pending.surface === "runs") {
    selectInspectorTab("runs", false)
    target = pending.itemID
      ? inspectorPanel.querySelector<HTMLElement>(
        `[data-run-id="${CSS.escape(pending.itemID)}"], [data-worktree-id="${CSS.escape(pending.itemID)}"]`,
      ) ?? undefined
      : inspectorPanel
  } else if (pending.surface === "health") {
    target = !notice.hidden ? notice : !connection.hidden ? connection : status
  } else if (pending.itemID) {
    const id = CSS.escape(pending.itemID)
    target = document.querySelector<HTMLElement>(
      `[data-request-id="${id}"], [data-question-request="${id}"], [data-message-id="${id}"]`,
    ) ?? undefined
  } else {
    target = !notice.hidden ? notice : status
  }
  pendingAttentionTarget = undefined
  if (!focusAttentionElement(target)) {
    attentionToggle.focus()
    announce("The attention item is no longer available")
  }
}

function renderAttention(): void {
  const items = snapshot.attentionItems ?? []
  const count = items.filter((item) => !item.acknowledged).length
  const resolvedLastItem = lastAttentionCount !== undefined && lastAttentionCount > 0 && count === 0 &&
    items.length === 0
  attentionCount.hidden = count === 0
  attentionCount.textContent = count > 99 ? "99+" : String(count)
  attentionToggle.classList.toggle("has-attention", count > 0)
  attentionMarkRead.hidden = count === 0
  attentionMarkRead.disabled = count === 0
  attentionToggle.title = count ? `Needs Attention (${count})` : "No items need attention"
  attentionToggle.setAttribute(
    "aria-label",
    count ? `Needs Attention, ${count} item${count === 1 ? "" : "s"}` : "Needs Attention, no items",
  )
  const nextSignature = JSON.stringify(
    items.map((item) => [item.id, item.kind, item.sessionID, item.title, item.detail, item.acknowledged, item.target]),
  )
  if (nextSignature !== attentionSignature) {
    const focusedID = !attentionOverlay.hidden && document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>("[data-attention-id]")?.dataset.attentionId
      : undefined
    attentionSignature = nextSignature
    attentionList.innerHTML = items.length
      ? items.map((item) =>
        `<button type="button" data-attention-id="${escapeHtml(item.id)}"${
          item.acknowledged ? ` class="acknowledged"` : ""
        }><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.kind.replaceAll("-", " "))}${
          item.acknowledged ? " · acknowledged" : ""
        }</small>${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ""}</button>`
      ).join("")
      : `<p class="placeholder">Nothing needs attention.</p>`
    if (focusedID) {
      const replacement =
        attentionList.querySelector<HTMLButtonElement>(`[data-attention-id="${CSS.escape(focusedID)}"]`) ??
          attentionList.querySelector<HTMLButtonElement>("[data-attention-id]")
      ;(replacement ?? attentionOverlay.querySelector<HTMLButtonElement>("[data-close-attention]"))?.focus()
    }
  }
  if (lastAttentionCount !== undefined && count > lastAttentionCount) {
    const added = count - lastAttentionCount
    announce(`${added} new attention item${added === 1 ? "" : "s"}; ${count} total`)
  }
  if (resolvedLastItem) {
    pendingAttentionTarget = undefined
    if (!attentionOverlay.hidden) attentionOverlayController.close()
    announce("All attention items resolved")
  }
  lastAttentionCount = count
  routePendingAttention()
}

function goalFormPresentation(): { signature: string; markup: string } | undefined {
  const goal = snapshot.session?.goal
  if (!goal) return undefined
  const sourceSignature = JSON.stringify([
    snapshot.session?.id,
    goal.objective,
    goal.acceptanceCriteria,
    goal.tokenBudget,
    goal.maxAutoTurns,
    goal.maxDurationSeconds,
    goal.verifier,
    goal.settlementGeneration,
  ])
  if (!goalFormDraft || sourceSignature !== goalFormSourceSignature) {
    goalFormSourceSignature = sourceSignature
    goalFormDraft = createGoalFormDraft({
      objective: goal.objective,
      acceptanceCriteria: goal.acceptanceCriteria,
      tokenBudget: goal.tokenBudget,
      maxAutoTurns: goal.maxAutoTurns,
      maxDurationSeconds: goal.maxDurationSeconds,
      verifier: goal.verifier,
      settlementGeneration: goal.settlementGeneration,
    })
  }
  return {
    signature: JSON.stringify(["goal-form", sourceSignature, goalFormDraft]),
    markup: goalFormMarkup(goalFormDraft, {
      models: snapshot.models.map((entry) => ({
        value: `${entry.providerID}/${entry.id}`,
        label: entry.name,
        description: entry.providerID,
      })),
      agents: snapshot.agents.map((entry) => ({
        value: entry.name,
        label: entry.name,
        description: entry.description,
      })),
    }),
  }
}

function readGoalFormDraft(): GoalFormDraft | undefined {
  const form = inspectorPanel.querySelector<HTMLFormElement>("[data-goal-form]")
  const previous = goalFormDraft
  if (!form || !previous) return previous
  const value = (name: string): string =>
    form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? ""
  const unlimited = (name: "tokenBudget" | "maxAutoTurns" | "maxDurationSeconds"): boolean =>
    Boolean(form.querySelector<HTMLInputElement>(`[data-goal-unlimited="${name}"]`)?.checked)
  const criteria = [...form.querySelectorAll<HTMLElement>("[data-goal-criterion-id]")].map((row, index) => ({
    id: row.dataset.goalCriterionId || `criterion-${index + 1}`,
    value: row.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "",
  }))
  return {
    ...previous,
    objective: value("objective"),
    criteria,
    tokenBudget: { unlimited: unlimited("tokenBudget"), value: value("tokenBudget") },
    maxAutoTurns: { unlimited: unlimited("maxAutoTurns"), value: value("maxAutoTurns") },
    maxDurationSeconds: { unlimited: unlimited("maxDurationSeconds"), value: value("maxDurationSeconds") },
    verifierEnabled: Boolean(form.querySelector<HTMLInputElement>("[name=verifierEnabled]")?.checked),
    verifierModel: value("verifierModel"),
    verifierAgent: value("verifierAgent"),
    verifierTimeoutMilliseconds: value("verifierTimeoutMilliseconds"),
    repeatedBlockThreshold: value("repeatedBlockThreshold"),
  }
}

function renderInspector(): void {
  inspector.classList.toggle("current-work-inspector", inspectorTab === "jobs")
  inspector.hidden = !inspectorOpen || !snapshot.session
  splitPanes?.reconcile()
  inspector.setAttribute("aria-label", INSPECTOR_LABELS[inspectorTab])
  inspector.querySelector<HTMLElement>(".session-details-header strong")!.textContent = INSPECTOR_LABELS[inspectorTab]
  sessionDetailsInfo.title = INSPECTOR_DESCRIPTIONS[inspectorTab]
  sessionDetailsInfo.setAttribute("aria-label", `About this view: ${INSPECTOR_DESCRIPTIONS[inspectorTab]}`)
  inspectorPanel.setAttribute("aria-label", `${INSPECTOR_LABELS[inspectorTab]} details`)
  if (!inspectorOpen || !snapshot.session) return
  const presentation = inspectorTab === "goal"
    ? goalFormPresentation() ?? inspectorPresentation(snapshot, inspectorTab)
    : inspectorPresentation(snapshot, inspectorTab, undefined, { comparisonSorts })
  if (presentation.signature === inspectorSignature) return
  const previousTab = inspectorPanel.dataset.tab
  const scrollTop = previousTab === inspectorTab ? inspectorPanel.scrollTop : 0
  const hadFocus = inspectorPanel.contains(document.activeElement)
  const focusedKey = hadFocus && document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>("[data-inspector-key]")?.dataset.inspectorKey
    : undefined
  inspectorSignature = presentation.signature
  inspectorPanel.dataset.tab = inspectorTab
  inspectorPanel.innerHTML = presentation.markup
  restoreLocalInspectorFilters()
  inspectorPanel.scrollTop = scrollTop
  if (hadFocus) {
    const replacement = focusedKey
      ? inspectorPanel.querySelector<HTMLElement>(`[data-inspector-key="${CSS.escape(focusedKey)}"]`)
      : undefined
    ;(replacement ?? inspectorPanel).focus()
  }
}

function closeRecoveryPreview(): void {
  const returnFocus = recoveryReturnFocus
  recoveryOverlay.hidden = true
  activeRecoveryPreview = undefined
  recoveryReturnFocus = undefined
  const unavailable = !returnFocus?.isConnected || Boolean(returnFocus.closest("[hidden]")) ||
    (returnFocus instanceof HTMLButtonElement && returnFocus.disabled)
  if (!unavailable && returnFocus) returnFocus.focus()
  else sessionMenuToggle.focus()
}

function openRecoveryPreview(preview: RecoveryPreview): void {
  const active = document.activeElement
  recoveryReturnFocus = active instanceof HTMLElement && active !== document.body && !recoveryOverlay.contains(active)
    ? active
    : undefined
  activeRecoveryPreview = preview
  const redoOnly = preview.canRedo && !preview.canRevert && !preview.canFork
  const files = preview.changedFiles.length
    ? `<ul class="inspector-list">${
      preview.changedFiles.map((file) =>
        `<li>${escapeHtml(file.file)}<small>currently reported · +${file.additions} −${file.deletions}</small></li>`
      ).join("")
    }</ul>`
    : `<p class="placeholder">OpenCode currently reports no changed files for this session.</p>`
  const explanation = redoOnly
    ? `<p><strong>This is OpenCode's native redo.</strong> It restores the transcript and file state held by OpenCode's current coupled revert marker. It does not create a new revert or fork.</p><dl class="inspector-metrics"><dt>Native revert boundary</dt><dd>${
      escapeHtml(preview.userText.slice(0, 500) || "OpenCode revert marker")
    }</dd></dl>`
    : `<p><strong>Revert is one coupled OpenCode operation.</strong> It reverts the selected transcript tail and OpenCode-managed file changes together; files-only and transcript-only recovery are unavailable.</p><p><strong>Fork does not revert.</strong> It creates a new OpenCode session from the selected turn and leaves the current files unchanged.</p><dl class="inspector-metrics"><dt>Selected turn</dt><dd>${
      escapeHtml(preview.userText.slice(0, 500) || "User message")
    }</dd><dt>Transcript</dt><dd>${preview.removedTurns} turn${
      preview.removedTurns === 1 ? "" : "s"
    } · ${preview.removedMessageIDs.length} message${preview.removedMessageIDs.length === 1 ? "" : "s"}</dd></dl>`
  recoveryContent.innerHTML = `${explanation}<h3>${
    redoOnly ? "Current OpenCode change summary" : "Current change set"
  }</h3>${files}<h3>Limits</h3><ul>${
    preview.limitations.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")
  }</ul><div class="recovery-actions">${
    preview.canRevert ? `<button type="button" data-recovery-mode="revert">Revert with OpenCode</button>` : ""
  }${
    preview.canFork
      ? `<button type="button" data-recovery-mode="fork">Fork OpenCode session here (files unchanged)</button>`
      : ""
  }${
    preview.canRedo ? `<button type="button" data-recovery-mode="redo">Redo OpenCode revert</button>` : ""
  }<button type="button" data-close-recovery>Cancel</button></div>`
  recoveryOverlay.hidden = false
  recoveryContent.querySelector<HTMLButtonElement>("button")?.focus()
}

function render(): void {
  const session = snapshot.session
  const active = session?.status.type === "busy" || session?.status.type === "retry"
  const loadPhase = sessionLoadPhase(session)
  const loading = loadPhase === "initial"
  const refreshing = loadPhase === "refreshing"
  const connectionUnavailable = syncConnectionNotice()
  syncProjectionNotice(connectionUnavailable)
  const connecting = snapshot.connectionState === "connecting"
  sessionTitle.textContent = session?.title || "No session"
  publicBadge.hidden = !session?.shared
  backParent.hidden = !session?.parentID && document.body.dataset.mode !== "editor"
  const backLabel = session?.parentID ? "Back to parent session" : "Go back"
  backParent.title = backLabel
  backParent.setAttribute("aria-label", backLabel)
  const sessionOption = session
    ? snapshot.sessions.find((value) => value.id === session.id) ??
      { id: session.id, title: session.title, status: session.status, unread: 0 }
    : undefined
  sessionState.innerHTML = connecting
    ? `<span class="header-active-indicator" title="Connecting to OpenCode" aria-label="Connecting to OpenCode"></span>`
    : sessionOption && (sessionOption.status.type === "busy" || sessionOption.status.type === "retry" || refreshing)
    ? `<span class="header-active-indicator" title="${
      refreshing && !active ? "Refreshing session" : "Working"
    }" aria-label="${refreshing && !active ? "Refreshing session" : "Working"}"></span>`
    : sessionOption
    ? escapeHtml(sessionStatusLabel(sessionOption))
    : ""
  sessionCurrent.disabled = snapshot.sessions.length === 0
  sessionMenuToggle.disabled = !session
  syncSessionMenuItems()
  createHeader.disabled = !snapshot.connected
  createEmpty.disabled = !snapshot.connected
  planTask.disabled = !snapshot.connected
  const emptyConversation = Boolean(session && session.messages.length === 0)
  const accessibleHistory = Boolean(session?.history?.hasOlder || session?.history?.sourceMayBeTruncated)
  empty.hidden = loading || Boolean(session && (!emptyConversation || accessibleHistory))
  sessionLoading.hidden = !loading
  messages.hidden = loading || !session || (emptyConversation && !accessibleHistory)
  createEmpty.hidden = Boolean(session)
  draft.disabled = loading || !snapshot.connected || creatingSession
  composer.setAttribute("aria-busy", String(Boolean(active)))
  messages.setAttribute("aria-busy", String(Boolean(active)))
  updatePrimaryAction()
  const statusError = session?.status.type === "error" ? session.status.message || "Session failed" : undefined
  status.classList.toggle("error", Boolean(statusError))
  status.innerHTML = session
    ? loading
      ? "Loading session…"
      : stoppingSessionID === session.id
      ? "Stopping…"
      : active
      ? activeThrobberHtml()
      : session.loadState === "error"
      ? "Transcript unavailable"
      : statusError
      ? `Error: ${escapeHtml(statusError)}`
      : ""
    : connecting
    ? "Connecting…"
    : connectionUnavailable
    ? snapshot.connectionState === "reconnecting" ? "Reconnecting…" : "Offline"
    : ""
  status.title = session?.status.type === "error" ? session.status.message || "Session error" : ""
  renderCatalogs(session)
  const selectedModel = snapshot.models.find((item) => `${item.providerID}/${item.id}` === session?.model)
  const variants = selectedModel?.variants ?? []
  fillSelect(
    variant,
    "Default reasoning",
    variants.map((value) => ({ value, label: variantLabel(value) })),
    variants.includes(session?.variant ?? "") ? session?.variant : undefined,
  )
  variant.disabled = !session || variants.length === 0
  agent.disabled = !session
  model.disabled = !session
  modelToggle.disabled = !session
  renderModelPicker()
  renderMultiModelPicker()
  const auto = snapshot.autoApproval === true
  approvalToggle.setAttribute("aria-checked", String(auto))
  approvalToggle.classList.toggle("auto", auto)
  approvalMode.textContent = auto ? "Auto" : "Ask"
  approvalToggle.title = auto
    ? "Warning: permission requests are automatically allowed once. Activate to require approval."
    : "Ask before OpenCode performs permission-gated actions. Activate to auto-allow once."
  if (!session) {
    clearTranscript()
    renderSessionChangeSummary()
    syncDraft()
    queueSignature = ""
    permissionSignature = ""
    questionSignature = ""
    queueDock.replaceChildren()
    permissionDock.replaceChildren()
    questionDock.replaceChildren()
    attachmentDock.replaceChildren()
    queueDock.hidden =
      permissionDock.hidden =
      questionDock.hidden =
      sessionTaskDock.hidden =
      todoDock.hidden =
        true
  } else {
    const deferHistoryTranscript = historyController.sessionID === session.id &&
      historyController.mode === "all"
    if (!deferHistoryTranscript) renderTranscript(session, Boolean(active))
    renderSessionChangeSummary(session, Boolean(active))
    if (!deferHistoryTranscript) {
      renderTurnNavigation(session)
      syncTurnNavigationVisibility(session)
    }
    renderHistoryBoundary(session)
    syncDraft(session)
    renderAttachments()
    renderQueue(session)
    renderPermissions(session)
    renderQuestions(session)
    renderSummaries(session, Boolean(active))
  }
  if (!session) {
    renderTurnNavigation()
    renderHistoryBoundary()
  }
  renderSessionLists()
  renderAttention()
  renderInspector()
  renderWorkspaceStrip(session)
  renderCommandSuggestions()
  resizeDraft()
  updatePrimaryAction()
  applyCapabilityControls()
  syncAnimationTimers(Boolean(active))
}

function post(message: WebviewToHostMessage): void {
  transport.post(message)
}

function closeHistory(): void {
  historyOverlay.hidden = true
  sessionCurrent.setAttribute("aria-expanded", "false")
  overlayReturnFocus?.focus()
  overlayReturnFocus = undefined
}

function openHistory(): void {
  overlayReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : sessionCurrent
  historyOverlay.hidden = false
  sessionCurrent.setAttribute("aria-expanded", "true")
  historySearch.value = ""
  renderSessionLists()
  requestAnimationFrame(() => historySearch.focus())
}

function narrowWorkbench(): boolean {
  return document.body.dataset.mode === "editor" && window.innerWidth <= 1120
}

function persistRail(open: boolean): void {
  const current = vscode.getState() ?? {}
  vscode.setState({ ...current, layout: { ...current.layout, sessionsOpen: open } })
}

function showRail(persist = true): void {
  if (!document.body.classList.contains("rail-open")) {
    railReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  }
  document.body.classList.add("rail-open")
  railToggle.setAttribute("aria-expanded", "true")
  if (narrowWorkbench()) {
    rightRail.setAttribute("role", "dialog")
    rightRail.setAttribute("aria-modal", "true")
    conversationColumn.inert = true
    requestAnimationFrame(() => (railSessionSearch.offsetParent ? railSessionSearch : railClose).focus())
  }
  if (persist) persistRail(true)
  splitPanes?.reconcile()
}

function closeRail(restoreFocus = true, persist = true): void {
  document.body.classList.remove("rail-open")
  railToggle.setAttribute("aria-expanded", "false")
  rightRail.removeAttribute("role")
  rightRail.removeAttribute("aria-modal")
  conversationColumn.inert = false
  if (persist) persistRail(false)
  splitPanes?.reconcile()
  const target = railReturnFocus
  railReturnFocus = undefined
  if (restoreFocus && target?.isConnected) target.focus()
}

function syncSessionMenuItems(query = sessionMenuSearch.value.trim().toLowerCase()): void {
  sessionMenu.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    const unavailable = button.dataset.sessionAction === "share"
      ? snapshot.session?.shared === true
      : button.dataset.sessionAction === "unshare" || button.dataset.menuCommand === "copyShare"
      ? snapshot.session?.shared !== true
      : button.dataset.sessionAction === "redo"
      ? !snapshot.session?.revertMessageID
      : false
    button.hidden = unavailable || (Boolean(query) && !button.textContent?.toLowerCase().includes(query))
  })
  sessionMenu.querySelectorAll<HTMLHRElement>("hr").forEach((separator) => separator.hidden = Boolean(query))
}

function closeSessionMenu(): void {
  sessionMenu.hidden = true
  sessionMenuToggle.setAttribute("aria-expanded", "false")
  sessionMenuSearch.value = ""
  syncSessionMenuItems("")
}

function requestSessionSelection(sessionID: string): void {
  if (!sessionID || sessionID === snapshot.session?.id) return
  if (!multiModelPicker.hidden) closeMultiModelPicker(false)
  flushPendingDraft()
  pendingSessionID = sessionID
  clearTranscript()
  messages.hidden = true
  sessionLoading.hidden = false
  empty.hidden = true
  sessionTitle.textContent = "Loading session…"
  draft.value = ""
  draft.disabled = true
  attachmentDock.hidden = true
  approvalToggle.setAttribute("aria-checked", "false")
  approvalToggle.classList.remove("auto")
  approvalMode.textContent = "Ask"
  for (const dock of [queueDock, permissionDock, questionDock, todoDock]) {
    dock.hidden = true
    dock.replaceChildren()
  }
  queueSignature =
    permissionSignature =
    questionSignature =
    summarySignature =
      ""
  updatePrimaryAction()
  post({ type: "selectSession", sessionID })
}

draft.addEventListener("input", () => {
  resizeDraft()
  updatePrimaryAction()
  const sessionID = snapshot.session?.id
  if (sessionID) {
    localDrafts.set(sessionID, draft.value)
    queueDraftUpdate(sessionID, draft.value)
  }
  selectedCommandIndex = 0
  renderCommandSuggestions()
  selectedFileIndex = 0
  requestFileSuggestions()
})
draft.addEventListener("keydown", (event) => {
  const mentions = currentMentionSuggestions()
  if (!fileSuggestionList.hidden && mentions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault()
    selectedFileIndex = (selectedFileIndex + (event.key === "ArrowDown" ? 1 : mentions.length - 1)) % mentions.length
    renderFileSuggestions()
    return
  }
  if (!fileSuggestionList.hidden && mentions.length && (event.key === "Tab" || event.key === "Enter")) {
    event.preventDefault()
    chooseFile()
    return
  }
  const commands = matchingCommands()
  if (commands.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault()
    selectedCommandIndex = (selectedCommandIndex + (event.key === "ArrowDown" ? 1 : commands.length - 1)) %
      commands.length
    renderCommandSuggestions()
    return
  }
  if (commands.length && (event.key === "Tab" || event.key === "Enter")) {
    event.preventDefault()
    chooseCommand()
    return
  }
  if (event.key === "Escape" && !fileSuggestionList.hidden) {
    event.preventDefault()
    event.stopPropagation()
    fileSuggestionList.hidden = true
    return
  }
  if (event.key === "Escape" && !commandSuggestions.hidden) {
    event.preventDefault()
    event.stopPropagation()
    commandSuggestions.hidden = true
    return
  }
  const submitIntent = composerSubmitIntent(
    event,
    snapshot.composer?.enterBehavior,
    snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry",
  )
  if (submitIntent !== "none") {
    event.preventDefault()
    if (submitIntent === "steer") submitMessage("steer")
    else send.click()
  }
})
commandSuggestions.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-command-name]")
    : undefined
  if (!button) return
  const commands = matchingCommands()
  const index = commands.findIndex((command) => command.name === button.dataset.commandName)
  if (index >= 0) chooseCommand(index)
})
fileSuggestionList.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-mention-index]")
    : undefined
  const index = Number(button?.dataset.mentionIndex)
  if (index >= 0) chooseFile(index)
})
modelToggle.addEventListener("click", () => modelPicker.hidden ? openModelPicker() : closeModelPicker())
modelSearch.addEventListener("input", renderModelPicker)
modelSearch.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown") return
  event.preventDefault()
  const buttons = modelOptionButtons()
  const active = buttons.findIndex((button) => button.dataset.modelValue === modelPickerActiveValue)
  focusModelOption(active >= 0 ? active : 0)
})
modelOptions.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault()
    moveModelOptionFocus(event.key)
  } else if ((event.key === "Enter" || event.key === " ") && document.activeElement instanceof HTMLButtonElement) {
    event.preventDefault()
    document.activeElement.click()
  }
})
modelPicker.addEventListener("click", (event) => {
  const modelButton = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-model-value]")
    : undefined
  const variantButton = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-variant-value]")
    : undefined
  const sessionID = snapshot.session?.id
  if (!sessionID) return
  if (modelButton?.dataset.modelValue) {
    model.value = modelButton.dataset.modelValue
    modelPickerActiveValue = model.value
    variant.value = ""
    const selected = selectedModelOption()
    const variants = selected?.variants ?? []
    fillSelect(variant, "Default reasoning", variants.map((value) => ({ value, label: variantLabel(value) })))
    post({ type: "setPreference", sessionID, agent: agent.value, model: model.value })
    modelPickerSignature = ""
    renderModelPicker()
    if (!variants.length) closeModelPicker()
    else {requestAnimationFrame(() =>
        reasoningOptions.querySelector<HTMLButtonElement>("button[aria-pressed='true']")?.focus()
      )}
    return
  }
  if (variantButton) {
    variant.value = variantButton.dataset.variantValue ?? ""
    post({ type: "setPreference", sessionID, agent: agent.value, model: model.value, variant: variant.value })
    renderModelPicker()
    closeModelPicker()
  }
})
function requestStop(): void {
  const sessionID = snapshot.session?.id
  const active = snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry"
  if (!sessionID || !active || stoppingSessionID === sessionID) return
  stoppingSessionID = sessionID
  updatePrimaryAction()
  status.textContent = "Stopping…"
  post({ type: "abort", sessionID })
}

function submitMessage(delivery?: "queue" | "steer" | "replace"): void {
  const sessionID = snapshot.session?.id
  if (send.dataset.action === "stop") {
    requestStop()
    return
  }
  const text = draft.value
  clearNotice("error")
  if (!sessionID) {
    if (!text.trim() || !snapshot.connected || creatingSession) return
    creatingSession = true
    updatePrimaryAction()
    post({ type: "createSession", draft: text, submit: true })
    return
  }
  const files = sessionAttachments(sessionID)
  const pasted = sessionPastedText(sessionID)
  const contexts = sessionContextAttachments(sessionID)
  if (!sessionID || (!text.trim() && !files.length && !pasted.length && !contexts.length) || !snapshot.connected) return
  const selected = snapshot.models.find((item) =>
    `${item.providerID}/${item.id}` === (model.value || snapshot.session?.model)
  )
  const needsImages = files.some((file) => file.mime.startsWith("image/"))
  const needsPdf = files.some((file) => file.mime === "application/pdf")
  if (
    (needsImages && selected?.capabilities?.input?.image === false) ||
    (needsPdf && selected?.capabilities?.input?.pdf === false)
  ) {
    const detail = `${selected?.name ?? "The selected model"} does not support ${
      needsImages ? "image" : "PDF"
    } input. Choose a compatible model or remove the attachment.`
    status.textContent = "Unsupported attachment"
    status.title = detail
    showNotice("error", "Unsupported attachment", detail)
    return
  }
  cancelPendingDraft()
  submittedDrafts.set(sessionID, text)
  const promptID = createOpenCodeMessageID()
  if (files.length || pasted.length) {
    if (files.length) {
      sentAttachmentPreviews.set(promptID, {
        sessionID,
        attachments: files.map((file) => ({
          label: file.label,
          name: file.name,
          mime: file.mime,
          thumbnail: file.mime.startsWith("image/") ? attachmentThumbnails.get(file.id) : undefined,
        })),
      })
      while (sentAttachmentPreviews.size > 10) {
        sentAttachmentPreviews.delete(sentAttachmentPreviews.keys().next().value!)
      }
    }
  }
  const active = snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry"
  const effectiveDelivery = active ? delivery ?? "queue" : undefined
  conversationView.jumpToLatest()
  scheduleVisibleTurnMarkerSync()
  post({
    type: "send",
    sessionID,
    promptID,
    composerRevision: composerPayloadRevisions.get(sessionID) ?? 0,
    delivery: effectiveDelivery,
    text,
    agent: agent.value || undefined,
    model: model.value || undefined,
    variant: variant.value || undefined,
    attachments: files.length ? files : undefined,
    pastedText: pasted.length ? pasted : undefined,
    contextIDs: contexts.length ? contexts.map((attachment) => attachment.id) : undefined,
  })
  send.dataset.action = "sent"
  send.innerHTML = PRIMARY_ICONS.sent
  send.disabled = true
  send.title = effectiveDelivery === "queue"
    ? "Queued"
    : effectiveDelivery === "steer"
    ? "Steering"
    : effectiveDelivery === "replace"
    ? "Stopping and sending"
    : "Sent"
  sendOptions.open = false
  setTimeout(updatePrimaryAction, 350)
}

function submitMultiModel(): void {
  const sessionID = snapshot.session?.id
  const ownership = multiRunController.validateOwner(sessionID, draft.value)
  if (
    ownership === "missing" || ownership === "session-changed" || !snapshot.connected
  ) {
    closeMultiModelPicker(false)
    showNotice(
      "error",
      "Session changed",
      "Open the multi-model picker again from the session that owns the task.",
    )
    draft.focus()
    return
  }
  if (ownership === "draft-changed") {
    closeMultiModelPicker(false)
    showNotice(
      "error",
      "Draft changed",
      "Review the updated task, then open the multi-model picker again.",
    )
    draft.focus()
    return
  }
  if (!sessionID) return
  const text = draft.value
  const files = sessionAttachments(sessionID)
  const pasted = sessionPastedText(sessionID)
  const contexts = sessionContextAttachments(sessionID)
  const models = multiRunController.values
  if (!text.trim() || models.length < 2 || models.length > MULTI_RUN_MAX_CANDIDATES) return
  const selectedModels = models.flatMap((value) => {
    const selected = snapshot.models.find((item) => `${item.providerID}/${item.id}` === value)
    return selected ? [selected] : []
  })
  if (selectedModels.length !== models.length) {
    showNotice("error", "Model catalog changed", "Review the available models and select the candidates again.")
    renderMultiModelPicker()
    return
  }
  const needsImages = files.some((file) => file.mime.startsWith("image/"))
  const needsPdf = files.some((file) => file.mime === "application/pdf")
  const incompatible = selectedModels.filter((item) =>
    (needsImages && item.capabilities?.input?.image === false) || (needsPdf && item.capabilities?.input?.pdf === false)
  )
  if (incompatible.length) {
    const names = incompatible.slice(0, 4).map((item) => item.name).join(", ")
    showNotice(
      "error",
      "Unsupported attachment",
      `${names}${incompatible.length > 4 ? ` and ${incompatible.length - 4} more` : ""} cannot receive the attached ${
        needsImages ? "image" : "PDF"
      }.`,
    )
    return
  }
  const concurrency = multiRunController.requestedConcurrency()
  const sharedVariant = variant.value && selectedModels.every((item) => item.variants?.includes(variant.value))
    ? variant.value
    : undefined
  cancelPendingDraft()
  submittedDrafts.set(sessionID, text)
  clearNotice("error")
  post({
    type: "sendMultiModel",
    sessionID,
    composerRevision: composerPayloadRevisions.get(sessionID) ?? 0,
    text,
    models,
    concurrency,
    agent: agent.value || undefined,
    variant: sharedVariant,
    attachments: files.length ? files : undefined,
    pastedText: pasted.length ? pasted : undefined,
    contextIDs: contexts.length ? contexts.map((attachment) => attachment.id) : undefined,
  })
  status.textContent = `Starting ${models.length} isolated runs…`
  closeMultiModelPicker(false)
  sendOptions.open = false
  draft.focus()
}

send.addEventListener("click", () => submitMessage())
sendOptions.addEventListener("click", (event) => {
  const multi = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-send-multi-model]")
    : undefined
  if (multi) {
    openMultiModelPicker()
    return
  }
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-send-delivery]")
    : undefined
  const delivery = button?.dataset.sendDelivery
  if (delivery === "queue" || delivery === "steer" || delivery === "replace") submitMessage(delivery)
})
sendOptions.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sendOptions.open) {
    event.preventDefault()
    event.stopPropagation()
    sendOptions.open = false
    sendOptions.querySelector<HTMLElement>("summary")?.focus()
    return
  }
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && !sendOptions.open) sendOptions.open = true
  navigateMenu(sendOptions, event, "button:not([disabled]):not([hidden])")
})
multiModelSearch.addEventListener("input", renderMultiModelPicker)
multiModelConcurrency.addEventListener("input", () => multiRunController.syncControls())
multiModelOptions.addEventListener("change", (event) => {
  const input = event.target instanceof HTMLInputElement
    ? event.target.closest<HTMLInputElement>("[data-multi-model-value]")
    : undefined
  if (input) multiRunController.change(input)
})
multiModelOptions.addEventListener("keydown", (event) => {
  multiRunController.navigate(event)
})
multiModelSelectVisible.addEventListener("click", () => multiRunController.selectAllVisible())
multiModelClear.addEventListener("click", () => multiRunController.clear())
multiModelClose.addEventListener("click", () => closeMultiModelPicker())
multiModelCancel.addEventListener("click", () => closeMultiModelPicker())
multiModelStart.addEventListener("click", submitMultiModel)
multiModelPicker.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return
  event.preventDefault()
  event.stopPropagation()
  closeMultiModelPicker()
})
attachFiles.addEventListener("click", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "pickFiles", sessionID })
})
attachmentDock.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>("button, [data-remove-context]")
    : undefined
  const sessionID = snapshot.session?.id
  if (!sessionID || !target) return
  if (target.hasAttribute("data-add-editor-context")) {
    post({ type: "attachCurrentEditor", sessionID })
    return
  }
  if (target.hasAttribute("data-pick-files")) {
    post({ type: "pickFiles", sessionID })
    return
  }
  if (target.dataset.removeContext) {
    post({ type: "removeContextAttachment", sessionID, attachmentID: target.dataset.removeContext })
    return
  }
  if (target.dataset.openContext) {
    post({ type: "openContextAttachment", sessionID, attachmentID: target.dataset.openContext })
    return
  }
  if (target.dataset.previewAttachment) {
    const attachment = sessionAttachments(sessionID).find((value) => value.id === target.dataset.previewAttachment)
    if (!attachment || !attachment.mime.startsWith("image/")) return
    openAttachmentPreview(
      `${attachment.label} · ${attachment.name}`,
      `data:${attachment.mime};base64,${attachment.data}`,
      `Preview of ${attachment.name}`,
      `${attachment.mime} · ${formatBytes(attachment.size)}${
        attachment.width && attachment.height ? ` · ${attachment.width}×${attachment.height}` : ""
      }`,
      target,
    )
    return
  }
  if (target.dataset.copyPaste) {
    const block = sessionPastedText(sessionID).find((value) => value.id === target.dataset.copyPaste)
    if (block) post({ type: "copyText", text: block.text })
    return
  }
  if (target.dataset.removePaste) {
    const block = sessionPastedText(sessionID).find((value) => value.id === target.dataset.removePaste)
    if (!block) return
    const values = sessionPastedText(sessionID).filter((value) => value.id !== block.id)
    if (values.length) pastedText.set(sessionID, values)
    else pastedText.delete(sessionID)
    removeDraftLabel(sessionID, block.label)
  } else if (target.dataset.removeAttachment) {
    const attachment = sessionAttachments(sessionID).find((value) => value.id === target.dataset.removeAttachment)
    if (!attachment) return
    const values = sessionAttachments(sessionID).filter((value) => value.id !== attachment.id)
    if (values.length) attachments.set(sessionID, values)
    else attachments.delete(sessionID)
    attachmentThumbnails.delete(attachment.id)
    removeDraftLabel(sessionID, attachment.label)
  } else return
  syncComposerPayload(sessionID)
  renderAttachments()
  updatePrimaryAction()
})
draft.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith("image/") || file.type === "application/pdf"
  )
  if (files.length) {
    event.preventDefault()
    void addInlineFiles(files)
    return
  }
  const text = event.clipboardData?.getData("text/plain") ?? ""
  if (!shouldCollapsePaste(text)) return
  event.preventDefault()
  addPastedText(text)
})
attachmentPreview.addEventListener("click", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest("[data-close-attachment-preview]")) return
  closeAttachmentPreview()
})
noticeRetry.addEventListener("click", () => {
  if (noticeKind === "offline") {
    post({
      type: snapshot.connectionError?.startsWith("Open a trusted workspace folder") ? "openFolder" : "reloadWindow",
    })
  } else post({ type: "refresh" })
})
noticeLogs.addEventListener("click", () => post({ type: "openLogs" }))
noticeCopy.addEventListener("click", () => {
  if (noticeDetail) post({ type: "copyText", text: noticeDetail })
})
noticeDismiss.addEventListener("click", () => {
  if (noticeKind === "projection") dismissedProjectionSignature = projectionSignature()
  clearNotice()
})
composer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer) return
  const types = Array.from(event.dataTransfer.types, (type) => type.toLowerCase())
  if (
    types.some((type) =>
      ["files", "text/uri-list", "application/vnd.code.uri-list", "resourceurls", "codefiles"].includes(type)
    )
  ) {
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    composer.classList.add("drag-active")
  }
})
composer.addEventListener("dragleave", (event) => {
  if (!composer.contains(event.relatedTarget as Node | null)) composer.classList.remove("drag-active")
})
composer.addEventListener("drop", (event) => {
  const sessionID = snapshot.session?.id
  if (!sessionID || !event.dataTransfer) return
  event.preventDefault()
  composer.classList.remove("drag-active")
  const files = Array.from(event.dataTransfer.files).filter((file) =>
    file.type.startsWith("image/") || file.type === "application/pdf"
  )
  if (files.length) void addInlineFiles(files)
  const lines = (value: string): string[] => value.split(/\r?\n/).filter((item) => item && !item.startsWith("#"))
  const uris = [
    ...lines(event.dataTransfer.getData("application/vnd.code.uri-list")),
    ...lines(event.dataTransfer.getData("text/uri-list")),
  ]
  for (const type of ["ResourceURLs", "resourceurls"]) {
    try {
      const values = JSON.parse(event.dataTransfer.getData(type))
      if (Array.isArray(values)) uris.push(...values.filter((value): value is string => typeof value === "string"))
    } catch { /* Ignore malformed private VS Code drag data. */ }
  }
  for (const type of ["CodeFiles", "codefiles"]) {
    try {
      const values = JSON.parse(event.dataTransfer.getData(type))
      if (Array.isArray(values)) {
        uris.push(
          ...values.filter((value): value is string => typeof value === "string").map((value) => {
            return fileUriFromPath(value)
          }),
        )
      }
    } catch { /* Ignore malformed private VS Code drag data. */ }
  }
  const uniqueUris = [...new Set(uris)]
  if (uniqueUris.length) post({ type: "resolveDroppedUris", sessionID, uris: uniqueUris.slice(0, 10) })
})
createHeader.addEventListener("click", () => {
  flushPendingDraft()
  post({ type: "createSession" })
})
attentionToggle.addEventListener("click", () => {
  const initialFocus = attentionList.querySelector<HTMLElement>("button") ??
    attentionOverlay.querySelector<HTMLElement>(".attention-panel [data-close-attention]") ?? undefined
  attentionOverlayController.show(initialFocus)
})
helpToggle.addEventListener(
  "click",
  () => keyboardHelpController.show(keyboardHelpOverlay.querySelector<HTMLElement>("button") ?? undefined),
)
keyboardHelpOverlay.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : undefined
  if (target?.closest("[data-close-keyboard-help]")) keyboardHelpController.close()
})
attentionOverlay.addEventListener("click", (event) => {
  const markRead = event.target instanceof Element && event.target.closest("#attention-mark-read")
  if (markRead) {
    post({ type: "markAttentionRead" })
    return
  }
  const close = event.target instanceof Element && event.target.closest("[data-close-attention]")
  if (close) {
    attentionOverlayController.close()
    return
  }
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-attention-id]")
    : undefined
  const item = snapshot.attentionItems?.find((candidate) => candidate.id === button?.dataset.attentionId)
  if (!item) return
  pendingAttentionTarget = { sessionID: item.sessionID, itemID: item.target.itemID, surface: item.target.surface }
  attentionOverlayController.close(false)
  if (item.sessionID && snapshot.session?.id !== item.sessionID) {
    focusAttentionElement(status)
    post({ type: "selectSession", sessionID: item.sessionID })
  } else renderAttention()
})
recoveryOverlay.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : undefined
  if (target?.closest("[data-close-recovery]")) {
    closeRecoveryPreview()
    return
  }
  const mode = target?.closest<HTMLButtonElement>("[data-recovery-mode]")?.dataset.recoveryMode
  const preview = activeRecoveryPreview
  if (!preview || !mode || !["revert", "fork", "redo"].includes(mode)) return
  post({
    type: "applyRecovery",
    sessionID: preview.sessionID,
    mode: mode as "revert" | "fork" | "redo",
    messageID: preview.messageID,
  })
  closeRecoveryPreview()
})
function persistInspector(): void {
  vscode.setState({ ...(vscode.getState() ?? {}), todoExpanded, ...inspectorShell.persisted() })
}
const comparisonSortKeys = new Set<RunComparisonSortKey>([
  "model",
  "status",
  "elapsed",
  "changedFiles",
  "taskOutcomes",
  "diagnostics",
  "verifier",
  "tokens",
  "cost",
  "blocker",
])

function normalizedInspectorFilter(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function applyReviewFilters(announceChange = false): void {
  if (inspectorTab !== "review" && inspectorTab !== "changes") return
  const filters = localInspectorFilters.review
  const findings = [...inspectorPanel.querySelectorAll<HTMLElement>("[data-review-finding]")]
  let visible = 0
  for (const finding of findings) {
    const matches = (!filters.severity || finding.dataset.reviewSeverity === filters.severity) &&
      (!filters.category || finding.dataset.reviewCategory === filters.category) &&
      (!filters.disposition || finding.dataset.reviewDisposition === filters.disposition)
    finding.hidden = !matches
    if (matches) visible += 1
  }
  const message = `Showing ${visible} of ${findings.length} finding${findings.length === 1 ? "" : "s"}.`
  const filterStatus = inspectorPanel.querySelector<HTMLElement>("[data-review-filter-status]")
  if (filterStatus) filterStatus.textContent = message
  if (announceChange) announce(message)
}

function applyJobFilters(announceChange = false): void {
  if (inspectorTab !== "jobs") return
  const filters = localInspectorFilters.jobs
  const textFilter = normalizedInspectorFilter(filters.text)
  const sessionFilter = normalizedInspectorFilter(filters.session)
  const runFilter = normalizedInspectorFilter(filters.run)
  const rows = [...inspectorPanel.querySelectorAll<HTMLElement>("[data-job-row]")]
  let visible = 0
  for (const row of rows) {
    const matches = (!textFilter || normalizedInspectorFilter(row.textContent ?? "").includes(textFilter)) &&
      (!filters.kind || row.dataset.jobKind === filters.kind) &&
      (!sessionFilter || normalizedInspectorFilter(row.dataset.jobSessionId ?? "").includes(sessionFilter)) &&
      (!runFilter || normalizedInspectorFilter(row.dataset.jobRunId ?? "").includes(runFilter))
    row.hidden = !matches
    if (matches) visible += 1
  }
  for (const group of inspectorPanel.querySelectorAll<HTMLElement>("[data-job-group]")) {
    const visibleRows = group.querySelectorAll<HTMLElement>("[data-job-row]:not([hidden])")
    group.hidden = visibleRows.length === 0
    const count = group.querySelector<HTMLElement>("[data-job-group-count]")
    if (count) count.textContent = String(visibleRows.length)
  }
  const message = `Showing ${visible} of ${rows.length} job${rows.length === 1 ? "" : "s"}.`
  const filterStatus = inspectorPanel.querySelector<HTMLElement>("[data-job-filter-status]")
  if (filterStatus) filterStatus.textContent = message
  if (announceChange) announce(message)
}

function restoreLocalInspectorFilters(): void {
  if (inspectorTab === "review" || inspectorTab === "changes") {
    for (const control of inspectorPanel.querySelectorAll<HTMLSelectElement>("[data-review-filter]")) {
      const key = control.dataset.reviewFilter
      if (!reviewFilterKeys.has(key as ReviewFilterKey)) continue
      const filterKey = key as ReviewFilterKey
      control.value = localInspectorFilters.review[filterKey]
      localInspectorFilters.review[filterKey] = control.value
    }
    applyReviewFilters()
  } else if (inspectorTab === "jobs") {
    for (const control of inspectorPanel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-job-filter]")) {
      const key = control.dataset.jobFilter
      if (!jobFilterKeys.has(key as JobFilterKey)) continue
      const filterKey = key as JobFilterKey
      control.value = localInspectorFilters.jobs[filterKey]
      localInspectorFilters.jobs[filterKey] = control.value
    }
    applyJobFilters()
  }
}

function updateLocalInspectorFilter(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return false
  const reviewKey = target.dataset.reviewFilter
  if (reviewFilterKeys.has(reviewKey as ReviewFilterKey)) {
    localInspectorFilters.review[reviewKey as ReviewFilterKey] = target.value
    applyReviewFilters(true)
    return true
  }
  const jobKey = target.dataset.jobFilter
  if (jobFilterKeys.has(jobKey as JobFilterKey)) {
    localInspectorFilters.jobs[jobKey as JobFilterKey] = target.value
    applyJobFilters(true)
    return true
  }
  return false
}

function setComparisonSort(
  artifactID: string,
  key: RunComparisonSortKey,
  direction: RunComparisonSort["direction"],
): void {
  if (!(snapshot.runComparisons ?? []).some((comparison) => comparison.artifactID === artifactID)) return
  comparisonSorts = { ...comparisonSorts, [artifactID]: { key, direction } }
  inspectorSignature = ""
  renderInspector()
  announce(`Run comparison sorted by ${key} ${direction}`)
}
inspectorClose.addEventListener("click", () => {
  inspectorShell.close()
  inspectorOpen = inspectorShell.open
  persistInspector()
  renderInspector()
  focusSessionWorkTrigger()
})
inspectorPanel.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : undefined
  const comparisonSort = target?.closest<HTMLButtonElement>("[data-comparison-sort]")
  if (
    comparisonSort?.dataset.comparisonArtifactId &&
    comparisonSortKeys.has(comparisonSort.dataset.comparisonSort as RunComparisonSortKey)
  ) {
    const artifactID = comparisonSort.dataset.comparisonArtifactId
    const key = comparisonSort.dataset.comparisonSort as RunComparisonSortKey
    const current = comparisonSorts[artifactID]
    const direction = current?.key === key && current.direction === "ascending" ? "descending" : "ascending"
    setComparisonSort(artifactID, key, direction)
    return
  }
  const comparisonDirection = target?.closest<HTMLButtonElement>("[data-comparison-sort-direction]")
  if (comparisonDirection?.dataset.comparisonArtifactId) {
    const current = comparisonSorts[comparisonDirection.dataset.comparisonArtifactId] ??
      { key: "model", direction: "ascending" }
    setComparisonSort(
      comparisonDirection.dataset.comparisonArtifactId,
      current.key,
      current.direction === "ascending" ? "descending" : "ascending",
    )
    return
  }
  const preset = target?.closest<HTMLButtonElement>("[data-goal-preset]")?.dataset.goalPreset
  if (preset && ["quick", "bounded", "thorough"].includes(preset) && goalFormDraft) {
    goalFormDraft = applyGoalFormPreset(readGoalFormDraft() ?? goalFormDraft, preset as GoalFormPreset)
    inspectorSignature = ""
    renderInspector()
    return
  }
  const criterionAction = target?.closest<HTMLButtonElement>("[data-goal-criterion-action]")?.dataset
    .goalCriterionAction
  if (criterionAction && goalFormDraft) {
    const current = readGoalFormDraft() ?? goalFormDraft
    const id = target?.closest<HTMLElement>("[data-goal-criterion-id]")?.dataset.goalCriterionId
    goalFormDraft = criterionAction === "add"
      ? addGoalCriterion(current)
      : criterionAction === "remove" && id
      ? removeGoalCriterion(current, id)
      : criterionAction === "up" && id
      ? moveGoalCriterion(current, id, -1)
      : criterionAction === "down" && id
      ? moveGoalCriterion(current, id, 1)
      : current
    inspectorSignature = ""
    renderInspector()
    return
  }
  const goalFormAction = target?.closest<HTMLButtonElement>("[data-goal-form-action]")?.dataset.goalFormAction
  if (goalFormAction === "reset") {
    goalFormDraft = undefined
    goalFormSourceSignature = ""
    inspectorSignature = ""
    renderInspector()
    return
  }
  if (goalFormAction === "verify" && snapshot.session) {
    post({ type: "goalAction", sessionID: snapshot.session.id, action: "verify" })
    return
  }
  const receiptSource = target?.closest<HTMLButtonElement>("[data-context-receipt-id][data-context-receipt-item-id]")
  if (receiptSource?.dataset.contextReceiptId && receiptSource.dataset.contextReceiptItemId && snapshot.session) {
    post({
      type: "contextReceiptAction",
      sessionID: snapshot.session.id,
      receiptID: receiptSource.dataset.contextReceiptId,
      itemID: receiptSource.dataset.contextReceiptItemId,
      action: "open-source",
    })
    return
  }
  const file = target?.closest<HTMLButtonElement>("[data-inspector-file]")?.dataset.inspectorFile
  if (file && snapshot.session) post({ type: "openFile", sessionID: snapshot.session.id, file })
  const patch = target?.closest<HTMLButtonElement>("[data-inspector-patch]")?.dataset.inspectorPatch
  if (patch && snapshot.session) post({ type: "openPatch", sessionID: snapshot.session.id, file: patch })
  const reviewAction = target?.closest<HTMLButtonElement>(
    "[data-change-review-action]",
  )
  if (reviewAction?.dataset.changeReviewAction && snapshot.session) {
    post({
      type: "changeReviewAction",
      sessionID: snapshot.session.id,
      action: reviewAction.dataset.changeReviewAction as Extract<
        WebviewToHostMessage,
        { type: "changeReviewAction" }
      >["action"],
      file: reviewAction.dataset.changeReviewFile,
    })
  }
  const walkthrough = target?.closest<HTMLButtonElement>("[data-walkthrough-document][data-walkthrough-stop]")
  if (walkthrough?.dataset.walkthroughDocument && walkthrough.dataset.walkthroughStop) {
    post({
      type: "walkthroughAction",
      documentID: walkthrough.dataset.walkthroughDocument,
      stopID: walkthrough.dataset.walkthroughStop,
    })
  }
  const run = target?.closest<HTMLButtonElement>("[data-run-action]")
  const action = run?.dataset.runAction
  if (run?.dataset.runGroup && action === "export-comparison" && run.dataset.comparisonArtifactId) {
    const revision = Number(run.dataset.comparisonRevision)
    if (Number.isSafeInteger(revision) && revision > 0) {
      post({
        type: "runAction",
        groupID: run.dataset.runGroup,
        action: "export-comparison",
        comparisonArtifactID: run.dataset.comparisonArtifactId,
        comparisonRevision: revision,
      })
    }
  } else if (
    run?.dataset.runGroup && action &&
    ["open", "cancel", "retry", "refresh", "compare", "fuse", "diff", "review", "keep", "discard"].includes(action)
  ) {
    if (["refresh", "compare", "fuse"].includes(action)) {
      post({ type: "runAction", groupID: run.dataset.runGroup, action: action as "refresh" | "compare" | "fuse" })
    } else if (run.dataset.runId) {
      post({
        type: "runAction",
        groupID: run.dataset.runGroup,
        runID: run.dataset.runId,
        action: action as "open" | "cancel" | "retry" | "diff" | "review" | "keep" | "discard",
      })
    }
  }
  const jobSession = target?.closest<HTMLButtonElement>("[data-job-session]:not([data-job-action])")?.dataset.jobSession
  if (jobSession) post({ type: "selectSession", sessionID: jobSession })
  const jobActionButton = target?.closest<HTMLButtonElement>("[data-job-action]")
  if (jobActionButton?.dataset.jobSession && ["open", "background"].includes(jobActionButton.dataset.jobAction ?? "")) {
    post({
      type: "jobAction",
      sessionID: jobActionButton.dataset.jobSession,
      action: jobActionButton.dataset.jobAction as "open" | "background",
    })
  }
  const pty = target?.closest<HTMLButtonElement>("[data-pty-action]")
  if (pty?.dataset.ptyId && pty.dataset.ptyAction === "cancel") {
    post({ type: "ptyAction", id: pty.dataset.ptyId, action: "cancel" })
  }
  const artifact = target?.closest<HTMLButtonElement>("[data-artifact-action]")
  const artifactAction = artifact?.dataset.artifactAction
  const artifactID = artifact?.dataset.artifactId
  const artifactRevision = Number(artifact?.dataset.artifactRevision)
  if (
    snapshot.session && artifactID && artifactAction &&
    ["open", "approve", "handoff", "archive", "delete", "open-finding", "set-finding-disposition", "regenerate"]
      .includes(artifactAction)
  ) {
    post({
      type: "artifactAction",
      sessionID: snapshot.session.id,
      artifactID,
      action: artifactAction as
        | "open"
        | "approve"
        | "handoff"
        | "archive"
        | "delete"
        | "open-finding"
        | "set-finding-disposition"
        | "regenerate",
      expectedRevision: Number.isSafeInteger(artifactRevision) && artifactRevision > 0 ? artifactRevision : undefined,
      findingID: artifact.dataset.findingId,
      disposition: artifact.dataset.findingDisposition as "open" | "fixed" | "dismissed" | "accepted-risk" | undefined,
    })
  }
  const healthAction = target?.closest<HTMLButtonElement>("[data-health-action]")?.dataset.healthAction
  if (healthAction && ["refresh", "reconnect", "logs", "trace", "copy"].includes(healthAction)) {
    post({ type: "healthAction", action: healthAction as "refresh" | "reconnect" | "logs" | "trace" | "copy" })
  }
  const browserAction = target?.closest<HTMLButtonElement>("[data-browser-action]")?.dataset.browserAction
  if (browserAction === "capture" && snapshot.session) {
    post({ type: "browserContextAction", sessionID: snapshot.session.id, action: "capture" })
  }
  const evidenceAction = target?.closest<HTMLButtonElement>("[data-evidence-action]")?.dataset.evidenceAction
  if (evidenceAction === "capture") post({ type: "evidenceAction", action: "capture" })
  const workbenchAction = target?.closest<HTMLButtonElement>("[data-workbench-action]")?.dataset.workbenchAction
  if (workbenchAction === "plan") post({ type: "planTask" })
  else if (workbenchAction === "start-goal") {
    insertComposerText("/goal ")
    draft.focus()
  } else if (
    snapshot.session && ["refresh-session", "review", "walkthrough", "compare-models"].includes(workbenchAction ?? "")
  ) {
    post({
      type: "workbenchAction",
      sessionID: snapshot.session.id,
      action: workbenchAction as "refresh-session" | "review" | "walkthrough" | "compare-models",
    })
  }
})
inspectorPanel.addEventListener("input", (event) => {
  if (updateLocalInspectorFilter(event.target)) return
  if (inspectorTab === "goal") goalFormDraft = readGoalFormDraft()
})
inspectorPanel.addEventListener("change", (event) => {
  if (updateLocalInspectorFilter(event.target)) return
  const comparisonSort =
    event.target instanceof HTMLSelectElement && event.target.matches("[data-comparison-sort-select]")
      ? event.target
      : undefined
  if (
    comparisonSort?.dataset.comparisonArtifactId && comparisonSortKeys.has(comparisonSort.value as RunComparisonSortKey)
  ) {
    setComparisonSort(
      comparisonSort.dataset.comparisonArtifactId,
      comparisonSort.value as RunComparisonSortKey,
      "ascending",
    )
    return
  }
  if (inspectorTab !== "goal") return
  goalFormDraft = readGoalFormDraft()
  const input = event.target instanceof HTMLInputElement ? event.target : undefined
  const toggle = input?.dataset.goalUnlimited
  if (toggle) inspectorPanel.querySelector<HTMLInputElement>(`[name="${CSS.escape(toggle)}"]`)!.disabled = input.checked
})
inspectorPanel.addEventListener("submit", (event) => {
  const browserForm = event.target instanceof HTMLFormElement && event.target.matches("[data-browser-context-form]")
    ? event.target
    : undefined
  if (browserForm) {
    event.preventDefault()
    if (!snapshot.session) return
    const values = new FormData(browserForm)
    const task = String(values.get("task") ?? "").trim()
    const sources = [...values.getAll("source"), ...values.getAll("clipboard-source")].filter((
      value,
    ): value is string => typeof value === "string") as Array<
      "selection" | "console" | "element" | "terminal-task" | "diagnostics" | "debug" | "url" | "screenshot"
    >
    const approvedUrl = String(values.get("approvedUrl") ?? "").trim() || undefined
    if (!task || !sources.length) {
      status.textContent = !task ? "Enter a browser/debug task" : "Select at least one context source"
      browserForm.querySelector<HTMLElement>(!task ? "[name='task']" : "input")?.focus()
      return
    }
    if (sources.includes("url") && !approvedUrl) {
      status.textContent = "Enter the approved URL"
      browserForm.querySelector<HTMLElement>("[name='approvedUrl']")?.focus()
      return
    }
    post({
      type: "browserContextAction",
      sessionID: snapshot.session.id,
      action: "capture",
      task,
      sources,
      approvedUrl: sources.includes("url") ? approvedUrl : undefined,
    })
    return
  }
  const form = event.target instanceof HTMLFormElement && event.target.matches("[data-goal-form]")
    ? event.target
    : undefined
  if (!form || !snapshot.session) return
  event.preventDefault()
  goalFormDraft = readGoalFormDraft()
  if (!goalFormDraft) return
  try {
    const { expectedSettlementGeneration, ...configuration } = serializeGoalFormDraft(goalFormDraft)
    post({ type: "configureGoal", sessionID: snapshot.session.id, expectedSettlementGeneration, configuration })
  } catch {
    inspectorSignature = ""
    renderInspector()
    inspectorPanel.querySelector<HTMLElement>("[aria-invalid=true]")?.focus()
  }
})
turnNavigation.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-marker-target]")
    : undefined
  const target = markerTargetElement(button?.dataset.markerTarget)
  if (!target) return
  const reduceMotion = document.body.classList.contains("vscode-reduce-motion") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" })
  target.querySelector<HTMLElement>("button, input, summary")?.focus()
})
function showTurnNavigationPreview(button: HTMLButtonElement): void {
  turnNavigationPreview.textContent = button.dataset.markerLabel ?? button.getAttribute("aria-label") ??
    "Conversation turn"
  const columnRect = turnNavigation.parentElement?.getBoundingClientRect()
  const buttonRect = button.getBoundingClientRect()
  const columnHeight = columnRect?.height ?? 0
  turnNavigationPreview.style.top = `${
    Math.max(20, Math.min(columnHeight - 20, buttonRect.top - (columnRect?.top ?? 0) + buttonRect.height / 2))
  }px`
  turnNavigationPreview.hidden = false
  button.setAttribute("aria-describedby", "turn-navigation-preview")
}
function hideTurnNavigationPreview(button?: HTMLButtonElement): void {
  button?.removeAttribute("aria-describedby")
  turnNavigationPreview.hidden = true
}
turnNavigation.addEventListener("pointerover", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-marker-target]")
    : undefined
  if (button) showTurnNavigationPreview(button)
})
turnNavigation.addEventListener("pointerout", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-marker-target]")
    : undefined
  if (button && !(event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) {
    hideTurnNavigationPreview(button)
  }
})
turnNavigation.addEventListener("focusin", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-marker-target]")
    : undefined
  if (button) showTurnNavigationPreview(button)
})
turnNavigation.addEventListener("focusout", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-marker-target]")
    : undefined
  if (button) hideTurnNavigationPreview(button)
})
turnNavigation.addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
  const buttons = [...turnNavigation.querySelectorAll<HTMLButtonElement>("button")]
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
    ? buttons.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
  event.preventDefault()
  buttons.forEach((button, index) => button.tabIndex = index === next ? 0 : -1)
  buttons[next]?.focus()
})
messages.addEventListener("load", () => scheduleViewportLayout(true), true)
historyLoadOlder.addEventListener("click", () => beginHistoryLoad("page"))
historyLoadAll.addEventListener("click", () => {
  if (historyController.sessionID && historyController.mode === "all") {
    historyController.cancel()
    renderHistoryBoundary(snapshot.session)
    conversationView.restorePrependAnchor(historyController.anchor)
    return
  }
  beginHistoryLoad("all")
})
createEmpty.addEventListener("click", () => post({ type: "createSession" }))
planTask.addEventListener("click", () => post({ type: "planTask" }))
empty.addEventListener("click", (event) => {
  const command = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-empty-command]")?.dataset.emptyCommand
    : undefined
  if (command === "help") post({ type: "openHelp" })
  else if (command === "health") post({ type: "openInEditor", tab: "health" })
})
surfaceToggle.addEventListener("click", () => {
  flushPendingDraft()
  post({ type: document.body.dataset.mode === "editor" ? "openInSidebar" : "openInEditor" })
})
backParent.addEventListener("click", () => {
  flushPendingDraft()
  const parentID = snapshot.session?.parentID
  if (!parentID) {
    post({ type: "navigateBack" })
    return
  }
  if ((history.state as { delegation?: string } | null)?.delegation) history.back()
  else requestSessionSelection(parentID)
})
sessionMenuToggle.addEventListener("click", () => {
  const open = sessionMenu.hidden
  sessionMenu.hidden = !open
  sessionMenuToggle.setAttribute("aria-expanded", String(open))
  if (open) {
    syncSessionMenuItems()
    sessionMenuSearch.focus()
  }
})
sessionMenuSearch.addEventListener("input", () => {
  syncSessionMenuItems()
})
sessionMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    closeSessionMenu()
    sessionMenuToggle.focus()
    return
  }
  navigateMenu(sessionMenu, event, 'button[role="menuitem"]:not([disabled])')
})
sessionMenu.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-session-action]")
    : undefined
  const sessionID = snapshot.session?.id
  const action = button?.dataset.sessionAction
  if (
    !button || !sessionID || !action ||
    !["rename", "delete", "fork", "undo", "redo", "compact", "share", "unshare", "export", "copyLast", "copyTranscript"]
      .includes(action)
  ) return
  closeSessionMenu()
  sessionMenuToggle.focus()
  post({
    type: "sessionAction",
    sessionID,
    action: action as Extract<WebviewToHostMessage, { type: "sessionAction" }>["action"],
  })
})
sessionMenu.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-menu-command]")
    : undefined
  const command = button?.dataset.menuCommand
  const sessionID = snapshot.session?.id
  if (!button || !command) return
  closeSessionMenu()
  if (command === "create") {
    flushPendingDraft()
    post({ type: "createSession" })
  } else if (command === "refresh") post({ type: "refresh" })
  else if (command === "sessions") openHistory()
  else if (command === "agent") {
    agent.focus()
    try {
      ;(agent as HTMLSelectElement & { showPicker?: () => void }).showPicker?.()
    } catch { /* The focused select remains keyboard-accessible. */ }
  } else if (command === "model") openModelPicker()
  else if (command === "variant" && (selectedModelOption()?.variants?.length ?? 0) > 0) openModelPicker(true)
  else if (command === "surface") {
    post({ type: document.body.dataset.mode === "editor" ? "openInSidebar" : "openInEditor" })
  } else if (command === "copyShare" && snapshot.session?.shareUrl) {
    post({ type: "copyText", text: snapshot.session.shareUrl })
  } else if (command === "skills" && sessionID) {
    draft.value = "/"
    postDraftNow(sessionID, draft.value)
    draft.focus()
    renderCommandSuggestions()
  } else if (command === "stash" && sessionID && draft.value) {
    stashedDrafts.set(sessionID, draft.value)
    draft.value = ""
    postDraftNow(sessionID, "")
    resizeDraft()
  } else if (command === "restore" && sessionID) {
    const value = stashedDrafts.get(sessionID)
    if (value !== undefined) {
      draft.value = value
      postDraftNow(sessionID, value)
      stashedDrafts.delete(sessionID)
      resizeDraft()
      draft.focus()
    }
  } else if (command === "latest") messages.scrollTop = messages.scrollHeight
  else if (command === "expand-thinking") {
    reasoningExpanded = true
    messages.querySelectorAll<HTMLDetailsElement>("details.reasoning").forEach((detail) => detail.open = true)
  } else if (command === "collapse-thinking") {
    reasoningExpanded = false
    messages.querySelectorAll<HTMLDetailsElement>("details.reasoning").forEach((detail) => detail.open = false)
  } else if (command === "expand-tools") {
    messages.querySelectorAll<HTMLDetailsElement>("details.activity").forEach((detail) => detail.open = true)
  } else if (command === "collapse-tools") {
    messages.querySelectorAll<HTMLDetailsElement>("details.activity").forEach((detail) => detail.open = false)
  } else if (command === "timestamps") document.body.classList.toggle("show-timestamps")
  else if (command === "scrollbar") document.body.classList.toggle("hide-scrollbars")
})
sessionCurrent.addEventListener("click", openHistory)
historySearch.addEventListener("input", renderSessionLists)
railSessionSearch.addEventListener("input", renderSessionLists)
for (const [input, list] of [[historySearch, historyList], [railSessionSearch, railSessionList]] as const) {
  input.addEventListener("keydown", (event) => {
    const first = list.querySelector<HTMLButtonElement>("[data-session-id][tabindex='0']") ??
      list.querySelector<HTMLButtonElement>("[data-session-id]")
    if (event.key === "ArrowDown" && first) {
      event.preventDefault()
      first.focus()
    } else if (event.key === "Enter" && first) {
      event.preventDefault()
      first.click()
    }
  })
  list.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const rows = Array.from(list.querySelectorAll<HTMLButtonElement>("[data-session-id]"))
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
      ? rows.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length
    rows.forEach((row, rowIndex) => row.tabIndex = rowIndex === next ? 0 : -1)
    rows[next]?.focus()
  })
}
document.querySelectorAll<HTMLElement>("[data-close-overlay]").forEach((button) =>
  button.addEventListener("click", closeHistory)
)
agent.addEventListener("change", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "setPreference", sessionID, agent: agent.value, model: "", variant: "" })
})
model.addEventListener("change", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "setPreference", sessionID, agent: agent.value, model: model.value })
})
variant.addEventListener("change", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) {
    post({ type: "setPreference", sessionID, agent: agent.value, model: model.value, variant: variant.value })
  }
})
approvalToggle.addEventListener("click", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "setAutoApproval", sessionID, enabled: snapshot.autoApproval !== true })
})
queueDock.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-queue-action]")
    : undefined
  const session = snapshot.session
  const promptID = button?.dataset.promptId
  if (!session || !button || !promptID) return
  if (button.dataset.queueAction === "remove") post({ type: "removeQueued", sessionID: session.id, promptID })
  else if (button.dataset.queueAction === "edit") post({ type: "editQueued", sessionID: session.id, promptID })
  else if (button.dataset.queueAction === "now") post({ type: "sendQueuedNow", sessionID: session.id, promptID })
  else {
    const ids = (session.queue ?? []).map((prompt) => prompt.id)
    const index = ids.indexOf(promptID)
    const target = button.dataset.queueAction === "up" ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    post({ type: "reorderQueue", sessionID: session.id, promptIDs: ids })
  }
})
permissionDock.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-permission]")
    : undefined
  const card = button?.closest<HTMLElement>("[data-request-id]")
  const sessionID = card?.dataset.requestSession
  const protocol = card?.dataset.requestProtocol
  const response = button?.dataset.permission
  if (
    button && sessionID && card?.dataset.requestId &&
    (protocol === "legacy" || protocol === "current" || protocol === "v2") &&
    (response === "once" || response === "exact" || response === "scope" || response === "reject")
  ) {
    const feedback = response === "reject"
      ? card.querySelector<HTMLInputElement>("[data-permission-feedback]")?.value.trim() || undefined
      : undefined
    const scope = response === "scope" ? button.dataset.permissionScope : undefined
    if (response === "scope" && !scope) return
    let requests: Array<{ id: string; sessionID: string; protocol: "legacy" | "current" | "v2" }> = [{
      id: card.dataset.requestId,
      sessionID,
      protocol,
    }]
    try {
      const parsed = JSON.parse(card.dataset.requestGroup ?? "[]")
      if (
        Array.isArray(parsed) && parsed.length &&
        parsed.every((item) =>
          item && typeof item.id === "string" &&
          typeof item.sessionID === "string" &&
          ["legacy", "current", "v2"].includes(item.protocol)
        )
      ) {
        requests = parsed
      }
    } catch { /* Fall back to the representative request. */ }
    for (const request of requests) {
      post({
        type: "respondPermission",
        sessionID: request.sessionID,
        requestID: request.id,
        protocol: request.protocol,
        response,
        scope,
        feedback,
      })
    }
  }
})
questionDock.addEventListener("submit", (event) => {
  event.preventDefault()
  const form = event.target instanceof HTMLFormElement ? event.target : undefined
  const sessionID = form?.dataset.requestSession
  const requestID = form?.dataset.questionRequest
  const request = snapshot.session?.questions?.find((candidate) => candidate.id === requestID)
  if (!form || !sessionID || !requestID || !request) return
  const answers = request.questions.map((question, index) => {
    const fieldset = form.querySelector<HTMLFieldSetElement>(`fieldset[data-question-index="${index}"]`)
    const custom = fieldset?.querySelector<HTMLInputElement>("[data-custom-answer]")?.value ?? ""
    const checked = Array.from(
      fieldset?.querySelectorAll<HTMLInputElement>("input[type='radio']:checked, input[type='checkbox']:checked") ?? [],
      (input) => input.value,
    )
    return questionAnswerValues(checked, custom, question.multiple === true)
  })
  if (answers.some((answer) => answer.length === 0)) {
    status.textContent = "Answer every question"
    return
  }
  post({ type: "respondQuestion", sessionID, requestID, answers })
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) {
    control.disabled = true
  }
})
questionDock.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-question-action='reject']")
    : undefined
  const form = button?.closest<HTMLFormElement>("[data-question-request]")
  const sessionID = form?.dataset.requestSession
  if (button && form?.dataset.questionRequest && sessionID) {
    post({ type: "rejectQuestion", sessionID, requestID: form.dataset.questionRequest })
    button.disabled = true
  }
})
function closeSessionContextMenu(restoreFocus = false): void {
  const returnSessionID = contextReturnSessionID
  const returnList = contextReturnList
  sessionContextMenu.hidden = true
  contextSessionID = undefined
  contextReturnSessionID = undefined
  contextReturnList = undefined
  if (restoreFocus && returnSessionID && returnList) {
    Array.from(returnList.querySelectorAll<HTMLButtonElement>("[data-session-id]"))
      .find((row) => row.dataset.sessionId === returnSessionID)?.focus()
  }
}

function openSessionContextMenu(row: HTMLButtonElement, x?: number, y?: number): void {
  const sessionID = row.dataset.sessionId
  if (!sessionID) return
  contextSessionID = sessionID
  contextReturnSessionID = sessionID
  contextReturnList = row.closest<HTMLElement>("#history-list, #rail-session-list") ?? undefined
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionID)
  const pin = sessionContextMenu.querySelector<HTMLButtonElement>("[data-context-action='pin']")
  if (pin) pin.textContent = session?.pinned ? "Unpin" : "Pin"
  const archive = sessionContextMenu.querySelector<HTMLButtonElement>("[data-context-action='archive']")
  if (archive) {
    archive.disabled = Boolean(session?.archived)
    archive.textContent = session?.archived ? "Archived" : "Archive"
  }
  sessionContextMenu.hidden = false
  const bounds = row.getBoundingClientRect()
  const left = x ?? bounds.left + 16
  const top = y ?? bounds.top + Math.min(bounds.height, 24)
  const menuBounds = sessionContextMenu.getBoundingClientRect()
  sessionContextMenu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - menuBounds.width - 4))}px`
  sessionContextMenu.style.top = `${Math.max(4, Math.min(top, window.innerHeight - menuBounds.height - 4))}px`
  sessionContextMenu.querySelector<HTMLButtonElement>("button")?.focus()
}

for (const container of [historyList, railSessions]) {
  container.addEventListener("click", (event) => {
    const more = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-session-more]")
      : undefined
    if (more) {
      sessionRenderLimit += 200
      sessionListSignature = ""
      renderSessionLists()
      return
    }
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-session-id]")
      : undefined
    if (!button?.dataset.sessionId) return
    closeSessionContextMenu()
    flushPendingDraft()
    requestSessionSelection(button.dataset.sessionId)
    if (!historyOverlay.hidden) closeHistory()
  })
}
for (const container of [historyList, railSessions]) {
  container.addEventListener("contextmenu", (event) => {
    const row = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-session-id]")
      : undefined
    if (!row) return
    event.preventDefault()
    openSessionContextMenu(row, event.clientX, event.clientY)
  })
  container.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
    const row = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-session-id]")
      : undefined
    if (!row) return
    event.preventDefault()
    openSessionContextMenu(row)
  })
}
sessionContextMenu.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-context-action]")
    : undefined
  const action = button?.dataset.contextAction
  const sessionID = contextSessionID
  if (!button || !action || !sessionID) return
  closeSessionContextMenu()
  if (action === "open") {
    flushPendingDraft()
    requestSessionSelection(sessionID)
    if (!historyOverlay.hidden) closeHistory()
  } else if (["rename", "fork", "delete"].includes(action)) {
    post({ type: "sessionAction", sessionID, action: action as "rename" | "fork" | "delete" })
  } else if (action === "pin") {
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionID)
    post({ type: "sessionPresentation", sessionID, action: session?.pinned ? "unpin" : "pin" })
  } else if (action === "archive") {
    post({ type: "sessionPresentation", sessionID, action: "archive" })
  }
})
sessionContextMenu.addEventListener("keydown", (event) => {
  const buttons = Array.from(sessionContextMenu.querySelectorAll<HTMLButtonElement>("button:not([disabled])"))
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    closeSessionContextMenu(true)
    return
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !buttons.length) return
  event.preventDefault()
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
    ? buttons.length - 1
    : (Math.max(index, 0) + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
  buttons[next]?.focus()
})
workspaceStrip.addEventListener("click", (event) => {
  const sessionID = snapshot.session?.id
  if (!sessionID) return
  const target = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-goal-action]")
    : undefined
  const action = target?.dataset.goalAction
  if (action === "edit" || action === "configure") {
    const details = target?.closest<HTMLDetailsElement>(".workspace-goal")
    if (details) details.open = false
    selectInspectorTab("goal")
    return
  }
  if (["verify", "pause", "resume", "cancel"].includes(action ?? "")) {
    post({ type: "goalAction", sessionID, action: action as "verify" | "pause" | "resume" | "cancel" })
  }
})
sessionTaskDock.addEventListener("click", (event) => {
  const route = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-session-detail]")?.dataset.sessionDetail
    : undefined
  if (route && INSPECTOR_TABS.has(route as InspectorTab)) selectInspectorTab(route)
})
todoDock.addEventListener("click", (event) => {
  const header = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>(".todo-dock-header")
    : undefined
  if (!header) return
  todoExpanded = !todoExpanded
  todoDock.classList.toggle("collapsed", !todoExpanded)
  header.setAttribute("aria-expanded", String(todoExpanded))
  header.title = todoExpanded ? "Collapse todos" : "Expand todos"
  const list = todoDock.querySelector<HTMLOListElement>(".todo-dock-list")
  if (list) list.hidden = !todoExpanded
  vscode.setState({ ...(vscode.getState() ?? {}), todoExpanded })
})
function detailsPopover(owner: HTMLDetailsElement): HTMLElement | undefined {
  return owner.querySelector<HTMLElement>(":scope > [popover]") ?? undefined
}

function positionDetailsPopover(owner: HTMLDetailsElement, popover: HTMLElement): void {
  const anchor = owner.querySelector<HTMLElement>(":scope > summary")
  if (!anchor) return
  const anchorRect = anchor.getBoundingClientRect()
  const popoverRect = popover.getBoundingClientRect()
  const edge = 8
  const gap = 6
  const alignEnd = owner === sendOptions || owner.classList.contains("permission-allow-menu") ||
    owner.closest(".workspace-right") !== null
  const desiredLeft = alignEnd ? anchorRect.right - popoverRect.width : anchorRect.left
  const above = anchorRect.top - popoverRect.height - gap
  const below = anchorRect.bottom + gap
  const desiredTop = above >= edge || anchorRect.top >= window.innerHeight - anchorRect.bottom ? above : below
  popover.style.left = `${Math.max(edge, Math.min(desiredLeft, window.innerWidth - popoverRect.width - edge))}px`
  popover.style.top = `${Math.max(edge, Math.min(desiredTop, window.innerHeight - popoverRect.height - edge))}px`
}

function syncDetailsPopover(owner: HTMLDetailsElement): void {
  const popover = detailsPopover(owner)
  if (!popover || typeof popover.showPopover !== "function") return
  const visible = popover.matches(":popover-open")
  if (owner.open && !visible) popover.showPopover()
  else if (!owner.open && visible) popover.hidePopover()
  if (owner.open) positionDetailsPopover(owner, popover)
}

let viewportLayoutFrame: number | undefined
let viewportLayoutNeedsTurnNavigation = false

function scheduleViewportLayout(syncTurnNavigation = false): void {
  viewportLayoutNeedsTurnNavigation ||= syncTurnNavigation
  if (viewportLayoutFrame !== undefined) return
  viewportLayoutFrame = requestAnimationFrame(() => {
    viewportLayoutFrame = undefined
    const syncNavigation = viewportLayoutNeedsTurnNavigation
    viewportLayoutNeedsTurnNavigation = false
    const followedLatest = conversationView.maintainLatest()
    if (syncNavigation) syncTurnNavigationVisibility()
    if (followedLatest || syncNavigation) scheduleVisibleTurnMarkerSync()
    for (const owner of document.querySelectorAll<HTMLDetailsElement>("details[open]")) {
      const popover = detailsPopover(owner)
      if (popover?.matches(":popover-open")) positionDetailsPopover(owner, popover)
    }
  })
}

document.addEventListener("toggle", (event) => {
  const target = event.target
  if (target instanceof HTMLDetailsElement && target.closest("#messages")) scheduleViewportLayout(true)
  if (target instanceof HTMLDetailsElement && detailsPopover(target)) {
    syncDetailsPopover(target)
    return
  }
  if (!(target instanceof HTMLElement) || !target.matches("[popover]")) return
  const owner = target.closest<HTMLDetailsElement>("details")
  if (owner?.open && !target.matches(":popover-open")) owner.open = false
}, true)
interactionRegion.addEventListener("scroll", () => scheduleViewportLayout(), { passive: true })
window.addEventListener("resize", () => scheduleViewportLayout(true))
window.setInterval(() => {
  if (snapshot.session) renderWorkspaceStrip(snapshot.session)
}, 60_000)
railToggle.addEventListener("click", () => {
  if (document.body.classList.contains("rail-open")) closeRail()
  else showRail()
})
railClose.addEventListener("click", () => closeRail())
document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) =>
  button.addEventListener("click", () => {
    const prompt = button.dataset.prompt || ""
    if (!snapshot.session) post({ type: "createSession", draft: prompt })
    else {
      draft.value = prompt
      resizeDraft()
      postDraftNow(snapshot.session.id, prompt)
      draft.focus()
    }
  })
)
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-copy-block]")
    : undefined
  if (!button) return
  event.preventDefault()
  event.stopPropagation()
  const block = button.closest<HTMLElement>(".code-block")
  const diffLines = [...(block?.querySelectorAll<HTMLElement>(".diff-line") ?? [])]
  const text = diffLines.length
    ? diffLines.map((line) =>
      `${line.classList.contains("diff-add") ? "+" : line.classList.contains("diff-remove") ? "-" : ""}${
        line.querySelector<HTMLElement>(".diff-line-code")?.textContent ?? ""
      }`
    ).join("\n")
    : block?.querySelector("pre")?.textContent
  if (text === undefined) return
  post({ type: "copyText", text })
  announce("Copied to clipboard")
  button.classList.add("copied")
  button.title = "Copied"
  button.setAttribute("aria-label", "Copied")
  window.setTimeout(() => {
    button.classList.remove("copied")
    button.title = "Copy"
    button.setAttribute("aria-label", "Copy")
  }, 1_500)
})
messages.addEventListener("click", (event) => {
  const transcriptPreview = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-transcript-preview]")
    : undefined
  if (transcriptPreview?.dataset.transcriptPreview) {
    const messageID = transcriptPreview.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
    const preview = messageID
      ? sentAttachmentPreviews.get(messageID)?.attachments.find((item) =>
        item.label === transcriptPreview.dataset.transcriptPreview
      )
      : undefined
    if (!preview?.thumbnail) return
    openAttachmentPreview(
      `${preview.label} · ${preview.name}`,
      preview.thumbnail,
      `Preview of ${preview.name}`,
      preview.mime,
      transcriptPreview,
    )
    return
  }
  const messageAction = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-message-action]")
    : undefined
  if (messageAction) {
    const article = messageAction.closest<HTMLElement>("[data-message-id]")
    const message = snapshot.session?.messages.find((value) => value.info.id === article?.dataset.messageId)
    const sessionID = snapshot.session?.id
    if (!message || !sessionID) return
    const text = message.parts.filter((part) => !part.synthetic && part.type === "text" && part.text).map((part) =>
      part.text
    ).join("\n")
    if (messageAction.dataset.messageAction === "copy") {
      post({ type: "copyText", text })
      announce("Message copied to clipboard")
      const originalTitle = messageAction.title
      messageAction.classList.add("copied")
      messageAction.title = "Copied"
      messageAction.setAttribute("aria-label", "Copied")
      window.setTimeout(() => {
        messageAction.classList.remove("copied")
        messageAction.title = originalTitle || "Copy message"
        messageAction.setAttribute("aria-label", "Copy message")
      }, 1_500)
    } else if (messageAction.dataset.messageAction === "edit") {
      draft.value = text
      postDraftNow(sessionID, text)
      resizeDraft()
      draft.focus()
      if (message.parts.some((part) => part.type === "file")) {
        status.textContent = "Text restored"
        status.title = "Historical attachments cannot be restored automatically. Add them again before sending."
      }
    } else if (messageAction.dataset.messageAction === "fork") {
      post({ type: "sessionAction", sessionID, action: "fork", messageID: message.info.id })
    } else if (messageAction.dataset.messageAction === "retry") {
      post({ type: "sessionAction", sessionID, action: "retry", messageID: message.info.id })
    }
    return
  }
  const activityToggle = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-turn-activity]")
    : undefined
  if (activityToggle) {
    if (activityToggle.dataset.working === "true") return
    const turn = activityToggle.closest<HTMLElement>(".turn")
    if (!turn) return
    turn.classList.toggle("activity-collapsed")
    const expanded = !turn.classList.contains("activity-collapsed")
    if (activityToggle.dataset.activityKey) {
      conversationView.rememberActivityCollapsed(activityToggle.dataset.activityKey, !expanded)
    }
    if (expanded) {
      turn.classList.add("activity-expanding")
      window.setTimeout(() => turn.classList.remove("activity-expanding"), 220)
    }
    activityToggle.setAttribute("aria-expanded", String(expanded))
    activityToggle.title = expanded ? "Hide work activity" : "Show work activity"
    return
  }
  const delegated = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-delegation-session]")
    : undefined
  if (delegated?.dataset.delegationSession) {
    flushPendingDraft()
    history.pushState({ delegation: delegated.dataset.delegationSession }, "")
    requestSessionSelection(delegated.dataset.delegationSession)
    return
  }
  const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-url]") : undefined
  if (anchor?.dataset.url) {
    post({ type: "openLink", url: anchor.dataset.url })
    return
  }
  const patch = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-open-patch]")
    : undefined
  if (patch?.dataset.openPatch && snapshot.session) {
    post({
      type: "openPatch",
      sessionID: patch.dataset.patchSession ?? snapshot.session.id,
      file: patch.dataset.openPatch,
      messageID: patch.dataset.patchMessage,
      partID: patch.dataset.patchPart,
      requestID: patch.dataset.patchRequest,
    })
    return
  }
  const file = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-file]") : undefined
  const sessionID = snapshot.session?.id
  if (file?.dataset.file && sessionID) {
    if (file.classList.contains("edit-file")) {
      event.preventDefault()
      event.stopPropagation()
    }
    const line = file.dataset.line ? Number(file.dataset.line) : undefined
    const column = file.dataset.column ? Number(file.dataset.column) : undefined
    const endLine = file.dataset.endLine ? Number(file.dataset.endLine) : undefined
    const endColumn = file.dataset.endColumn ? Number(file.dataset.endColumn) : undefined
    post({
      type: "openFile",
      sessionID,
      file: file.dataset.file,
      line,
      column,
      endLine,
      endColumn,
      messageID: file.dataset.fileMessage,
      partID: file.dataset.filePart,
    })
    return
  }
})
jumpLatest.addEventListener("click", () => {
  conversationView.jumpToLatest()
  scheduleVisibleTurnMarkerSync()
})
sessionChangeSummary.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : undefined
  if (target?.closest("[data-session-changes-review]") && snapshot.session) {
    post({
      type: "changeReviewAction",
      sessionID: snapshot.session.id,
      action: "review-session",
    })
    return
  }
  const file = target?.closest<HTMLButtonElement>(
    "[data-session-change-review]",
  )?.dataset.sessionChangeReview
  if (file && snapshot.session) post({ type: "openPatch", sessionID: snapshot.session.id, file })
})
messages.addEventListener("scroll", scheduleConversationScrollSync, { passive: true })
document.addEventListener("keydown", (event) => {
  if (
    focusController.trapTab(event, recoveryOverlay) || focusController.trapTab(event, keyboardHelpOverlay) ||
    focusController.trapTab(event, attentionOverlay) ||
    focusController.trapTab(event, attachmentPreview, "button:not([disabled]), [tabindex]:not([tabindex='-1'])") ||
    focusController.trapTab(event, historyOverlay) ||
    focusController.trapTab(
      event,
      multiModelPicker,
      "input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ) ||
    focusController.trapTab(
      event,
      modelPicker,
      "input:not([disabled]), button:not([disabled]):not([tabindex='-1']), [tabindex]:not([tabindex='-1'])",
    ) ||
    (narrowWorkbench() && document.body.classList.contains("rail-open") && focusController.trapTab(event, rightRail))
  ) return
  if (event.key === "Escape") {
    if (!recoveryOverlay.hidden) {
      closeRecoveryPreview()
    } else if (!keyboardHelpOverlay.hidden) {
      keyboardHelpController.close()
    } else if (!attentionOverlay.hidden) {
      attentionOverlayController.close()
    } else if (!attachmentPreview.hidden) {
      closeAttachmentPreview()
    } else if (!sessionContextMenu.hidden) closeSessionContextMenu(true)
    else if (!historyOverlay.hidden) closeHistory()
    else if (!multiModelPicker.hidden) {
      closeMultiModelPicker()
    } else if (!modelPicker.hidden) {
      closeModelPicker()
    } else if (narrowWorkbench() && document.body.classList.contains("rail-open")) closeRail()
    else if (inspectorOpen) {
      inspectorShell.close()
      inspectorOpen = inspectorShell.open
      persistInspector()
      renderInspector()
      focusSessionWorkTrigger()
    } else if (!sessionMenu.hidden) {
      closeSessionMenu()
      sessionMenuToggle.focus()
    } else if (sendOptions.open) {
      sendOptions.open = false
      send.focus()
    } else if (permissionDock.querySelector<HTMLDetailsElement>(".permission-allow-menu[open]")) {
      permissionDock.querySelector<HTMLDetailsElement>(".permission-allow-menu[open]")!.open = false
    } else if (workspaceStrip.querySelector<HTMLDetailsElement>(".workspace-detail[open]")) {
      const detail = workspaceStrip.querySelector<HTMLDetailsElement>(".workspace-detail[open]")!
      detail.open = false
      detail.querySelector<HTMLElement>("summary")?.focus()
    } else if (document.body.dataset.mode === "sidebar" && document.body.classList.contains("rail-open")) closeRail()
    else if (snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry") {
      event.preventDefault()
      requestStop()
    } else if (snapshot.session?.parentID) backParent.click()
  }
})
window.addEventListener("popstate", () => {
  const parentID = snapshot.session?.parentID
  if (parentID) {
    flushPendingDraft()
    requestSessionSelection(parentID)
  }
})
document.addEventListener("pointerdown", (event) => {
  if (multiRunController.containPointer(event)) return
  if (!sessionContextMenu.hidden && event.target instanceof Node && !sessionContextMenu.contains(event.target)) {
    closeSessionContextMenu()
  }
  if (
    !sessionMenu.hidden && event.target instanceof Node && !sessionMenu.contains(event.target) &&
    !sessionMenuToggle.contains(event.target)
  ) closeSessionMenu()
  if (
    !modelPicker.hidden && event.target instanceof Node && !modelPicker.contains(event.target) &&
    !modelToggle.contains(event.target)
  ) closeModelPicker(false)
  if (event.target instanceof Node && !workspaceStrip.contains(event.target)) {
    for (const detail of workspaceStrip.querySelectorAll<HTMLDetailsElement>(".workspace-detail[open]")) {
      detail.open = false
    }
  }
})
transport.listen((message) => {
  if (message.type === "error") {
    if (creatingSession) {
      creatingSession = false
      updatePrimaryAction()
    }
    if (stoppingSessionID) {
      stoppingSessionID = undefined
      updatePrimaryAction()
    }
    if (pendingSessionID) {
      pendingSessionID = undefined
      render()
    }
    if (historyController.loading) {
      const anchor = historyController.anchor
      const flushDeferred = historyController.mode === "all" && snapshot.session?.id === historyController.sessionID
      resetHistoryLoading()
      renderHistoryBoundary(snapshot.session)
      if (flushDeferred && snapshot.session) {
        const active = snapshot.session.status.type === "busy" || snapshot.session.status.type === "retry"
        renderTranscript(snapshot.session, active, anchor)
        renderTurnNavigation(snapshot.session)
        syncTurnNavigationVisibility(snapshot.session)
      }
    }
    status.textContent = message.message
    status.title = message.message
    showNotice(
      "error",
      message.message.startsWith("Workbench protocol:")
        ? "Workbench UI synchronization failed"
        : "OpenCode request failed",
      message.message,
    )
    permissionSignature = ""
    questionSignature = ""
    if (snapshot.session) {
      renderPermissions(snapshot.session)
      renderQuestions(snapshot.session)
    }
    return
  }
  if (message.type === "insertText") {
    if (message.sessionID === snapshot.session?.id) insertComposerText(message.text)
    return
  }
  if (message.type === "navigateWorkbench") {
    selectInspectorTab(message.tab)
    if (message.itemID) {
      requestAnimationFrame(() =>
        inspectorPanel.querySelector<HTMLElement>(
          `[data-artifact-id="${CSS.escape(message.itemID!)}"], [data-run-id="${
            CSS.escape(message.itemID!)
          }"], [data-worktree-id="${CSS.escape(message.itemID!)}"]`,
        )?.focus()
      )
    }
    return
  }
  if (message.type === "workbenchControl") {
    if (message.target === "sessions") {
      if (message.action === "toggle" && document.body.classList.contains("rail-open")) closeRail()
      else showRail()
    } else if (message.target === "jobs") {
      if (message.action === "toggle" && inspectorOpen && inspectorTab === "jobs") {
        inspectorShell.close()
        inspectorOpen = inspectorShell.open
        persistInspector()
        renderInspector()
        focusSessionWorkTrigger()
      } else selectInspectorTab("jobs")
    } else {
      const initialFocus = attentionList.querySelector<HTMLElement>("button") ??
        attentionOverlay.querySelector<HTMLElement>(".attention-panel [data-close-attention]") ?? undefined
      attentionOverlayController.show(initialFocus)
    }
    return
  }
  if (message.type === "recoveryPreview") {
    openRecoveryPreview(message.preview)
    return
  }
  if (message.type === "fileSuggestions") {
    if (message.sessionID !== snapshot.session?.id || message.requestID !== fileRequestID) return
    suggestedFiles = message.files
    renderFileSuggestions()
    return
  }
  if (message.type === "editorContextChanged") {
    editorContext = message.context
    renderAttachments()
    return
  }
  if (message.type === "contextAttachmentsChanged") {
    if (message.attachments.length) contextAttachments.set(message.sessionID, message.attachments)
    else contextAttachments.delete(message.sessionID)
    if (message.sessionID === snapshot.session?.id) {
      renderAttachments()
      updatePrimaryAction()
    }
    return
  }
  if (message.type === "composerPayloadChanged") {
    const localRevision = composerPayloadRevisions.get(message.sessionID) ?? 0
    if (!message.conflict && message.revision < localRevision) return
    const remote = { attachments: message.attachments, pastedText: message.pastedText }
    const pending = pendingComposerPayloads.get(message.sessionID)
    if (pending && message.mutationID !== pending.mutationID) return
    if (message.conflict && pending) {
      const previousLabels = [...pending.base.attachments, ...pending.attachments, ...remote.attachments].map((
        attachment,
      ) => attachment.label)
        .concat([...pending.base.pastedText, ...pending.pastedText, ...remote.pastedText].map((block) => block.label))
      const merged = normalizeComposerLabels({
        attachments: mergeRevisionValues(remote.attachments, pending.base.attachments, pending.attachments),
        pastedText: mergeRevisionValues(remote.pastedText, pending.base.pastedText, pending.pastedText),
      })
      composerPayloadRevisions.set(message.sessionID, message.revision)
      acknowledgedComposerPayloads.set(message.sessionID, remote)
      pendingComposerPayloads.delete(message.sessionID)
      if (merged.attachments.length) attachments.set(message.sessionID, merged.attachments)
      else attachments.delete(message.sessionID)
      if (merged.pastedText.length) pastedText.set(message.sessionID, merged.pastedText)
      else pastedText.delete(message.sessionID)
      reconcileComposerReferences(message.sessionID, previousLabels, merged)
      if (composerPayloadCanSync(merged)) syncComposerPayload(message.sessionID)
      if (message.sessionID === snapshot.session?.id) {
        const syncable = composerPayloadCanSync(merged)
        status.textContent = syncable ? "Merged concurrent composer changes" : "Merged composer exceeds limits"
        status.title = syncable
          ? "Attachments and pasted text from both chat views were preserved."
          : "Remove attachments or pasted text before sending."
        if (!syncable) {
          showNotice(
            "error",
            "Merged composer exceeds limits",
            "Changes from both chat views were preserved locally. Remove attachments or pasted text before sending.",
          )
        }
        renderAttachments()
        updatePrimaryAction()
      }
      return
    }
    composerPayloadRevisions.set(message.sessionID, message.revision)
    acknowledgedComposerPayloads.set(message.sessionID, remote)
    if (pending?.revision === message.revision) pendingComposerPayloads.delete(message.sessionID)
    const previous = attachments.get(message.sessionID) ?? []
    if (message.attachments.length) attachments.set(message.sessionID, message.attachments)
    else attachments.delete(message.sessionID)
    const retained = new Set(message.attachments.map((attachment) => attachment.id))
    for (const attachment of previous) if (!retained.has(attachment.id)) attachmentThumbnails.delete(attachment.id)
    if (message.attachments.length) {
      void cacheAttachmentThumbnails(message.attachments).then(() => {
        if (message.sessionID === snapshot.session?.id) renderAttachments()
      })
    }
    if (message.pastedText.length) pastedText.set(message.sessionID, message.pastedText)
    else pastedText.delete(message.sessionID)
    if (message.sessionID === snapshot.session?.id) {
      if (message.conflict) {
        showNotice(
          "error",
          "Composer changed in another view",
          "The synchronized composer was updated before this view had a pending local change.",
        )
      }
      renderAttachments()
      updatePrimaryAction()
    }
    return
  }
  if (message.type === "draftChanged") {
    const previous = draftRevisions.get(message.sessionID) ?? -1
    if (message.revision <= previous) return
    draftRevisions.set(message.sessionID, message.revision)
    if (pendingDraft?.sessionID === message.sessionID && pendingDraft.value !== message.draft) return
    localDrafts.delete(message.sessionID)
    if (message.sessionID === snapshot.session?.id) {
      draft.value = message.draft
      resizeDraft()
      updatePrimaryAction()
    }
    return
  }
  if (message.type === "sessionRemoved") {
    localDrafts.delete(message.sessionID)
    draftRevisions.delete(message.sessionID)
    submittedDrafts.delete(message.sessionID)
    for (const [messageID, previews] of sentAttachmentPreviews) {
      if (previews.sessionID === message.sessionID) sentAttachmentPreviews.delete(messageID)
    }
    for (const attachment of attachments.get(message.sessionID) ?? []) attachmentThumbnails.delete(attachment.id)
    attachments.delete(message.sessionID)
    pastedText.delete(message.sessionID)
    contextAttachments.delete(message.sessionID)
    composerPayloadRevisions.delete(message.sessionID)
    acknowledgedComposerPayloads.delete(message.sessionID)
    pendingComposerPayloads.delete(message.sessionID)
    stashedDrafts.delete(message.sessionID)
    historyController.deleteSession(message.sessionID)
    if (pendingDraft?.sessionID === message.sessionID) cancelPendingDraft()
    return
  }
  if (message.type === "historyPage") {
    const session = snapshot.session
    const loadingThisSession = historyController.sessionID === message.page.sessionID
    const loadingAll = loadingThisSession && historyController.mode === "all"
    if (!session || session.id !== message.page.sessionID) {
      if (loadingThisSession) resetHistoryLoading()
      return
    }
    const anchor = historyController.anchor
    const historyControlHadFocus = historyBoundary.contains(
      document.activeElement,
    )
    const merged = mergeHistoryPage(session, message.page)
    snapshot = store.replace({ ...snapshot, session: merged })
    const previousPage = historyController.expandedPage(merged.id)
    const newPageIDs = new Set(message.page.messages.map((entry) => entry.info.id))
    historyController.setExpandedPage(merged.id, {
      ...message.page,
      messages: [
        ...message.page.messages,
        ...(previousPage?.messages ?? []).filter((entry) => !newPageIDs.has(entry.info.id)),
      ],
      messageRevisions: { ...previousPage?.messageRevisions, ...message.page.messageRevisions },
      hasOlder: merged.history?.hasOlder ?? false,
      totalMessages: merged.history?.totalMessages ?? message.page.totalMessages,
      sourceMayBeTruncated: merged.history?.sourceMayBeTruncated,
    })
    if (loadingAll) historyController.recordPage(message.page.messages.length)
    const continueLoadingAll = loadingAll && !historyController.cancelled && Boolean(merged.history?.hasOlder) &&
      message.page.messages.length > 0
    const renderThisPage = !loadingAll || !continueLoadingAll ||
      historyController.pagesSinceRender >= 3
    const cancelled = historyController.cancelled
    const loadedAllCount = historyController.loaded
    const safetyLimited = !merged.history?.hasOlder &&
      merged.history?.sourceMayBeTruncated === true &&
      message.page.messages.length === 0
    if (!continueLoadingAll) resetHistoryLoading()
    const active = merged.status.type === "busy" || merged.status.type === "retry"
    renderHistoryBoundary(merged)
    const restoreHistoryFocus = historyControlHadFocus &&
      historyBoundary.hidden
    if (renderThisPage) {
      renderTranscript(merged, active, anchor)
      renderTurnNavigation(merged)
      syncTurnNavigationVisibility(merged)
      historyController.pagesSinceRender = 0
    } else conversationView.restorePrependAnchor(anchor)
    if (restoreHistoryFocus) {
      focusAttentionElement(
        messages.querySelector<HTMLElement>("[data-message-id]") ?? undefined,
      )
    }
    if (continueLoadingAll) {
      const beforeMessageID = merged.messages[0]?.info.id
      post({ type: "loadOlderHistory", sessionID: merged.id, beforeMessageID })
      return
    }
    announce(
      loadingAll
        ? cancelled
          ? `Stopped after loading ${loadedAllCount.toLocaleString()} older messages`
          : safetyLimited
          ? `Stopped at the transcript safety limit after adding ${loadedAllCount.toLocaleString()} older messages`
          : `Loaded all available older messages, ${loadedAllCount.toLocaleString()} messages added`
        : message.page.messages.length
        ? `${message.page.messages.length} older messages loaded`
        : "No additional older messages are available",
    )
    return
  }
  if (message.type === "messagePatches") {
    if (pendingSessionID) return
    const session = snapshot.session
    if (!session) return
    let active = session.status.type === "busy" || session.status.type === "retry"
    const wasNearBottom = transcriptNearBottom()
    const previousTurnNavigation = JSON.stringify(turnNavigationMarkers(session))
    let changed = false
    let addedMessages = 0
    let historyDelta = 0
    for (const patch of message.patches) {
      if (patch.sessionID !== session.id) continue
      const currentRevision = session.messageRevisions[patch.messageID] ?? -1
      if (patch.revision <= currentRevision) continue
      active = patch.active
      const index = session.messages.findIndex((entry) => entry.info.id === patch.messageID)
      if (patch.message) {
        if (patch.message.info.role === "assistant") {
          const text = patch.message.parts.filter((part) => !part.synthetic && part.type === "text" && part.text).map((
            part,
          ) => part.text).join("\n")
          const previous = announcedAssistantText.get(patch.messageID) ?? ""
          if (text.length > previous.length && text.startsWith(previous)) announce(text.slice(previous.length))
          announcedAssistantText.set(patch.messageID, text)
        }
        if (index < 0) {
          const previous = patch.afterMessageID
            ? session.messages.findIndex((entry) => entry.info.id === patch.afterMessageID)
            : -1
          if (previous >= 0) session.messages.splice(previous + 1, 0, patch.message)
          else if (patch.append) session.messages.push(patch.message)
          else continue
          addedMessages += 1
          historyDelta += 1
        } else session.messages[index] = patch.message
        session.messageRevisions[patch.messageID] = patch.revision
      } else if (index >= 0) {
        session.messages.splice(index, 1)
        delete session.messageRevisions[patch.messageID]
        historyDelta -= 1
      }
      changed = true
    }
    if (changed) {
      if (session.history) {
        session.history = {
          ...session.history,
          totalMessages: Math.max(session.messages.length, session.history.totalMessages + historyDelta),
          visibleMessages: session.messages.length,
        }
      }
      const cached = historyController.expandedPage(session.id)
      if (cached) {
        const currentMessages = new Map(session.messages.map((entry) => [entry.info.id, entry]))
        const retained = cached.messages.flatMap((entry) => currentMessages.get(entry.info.id) ?? [])
        historyController.setExpandedPage(session.id, {
          ...cached,
          messages: retained,
          messageRevisions: Object.fromEntries(
            retained.map((
              entry,
            ) => [
              entry.info.id,
              session.messageRevisions[entry.info.id] ?? cached.messageRevisions[entry.info.id] ?? 0,
            ]),
          ),
          totalMessages: session.history?.totalMessages ?? cached.totalMessages,
        })
      }
      if (!wasNearBottom) conversationView.addUnseen(addedMessages)
      renderTranscript(session, active)
      if (JSON.stringify(turnNavigationMarkers(session)) !== previousTurnNavigation) {
        renderTurnNavigation(session)
        syncTurnNavigationVisibility(session)
      } else syncTurnNavigationVisibility(session)
      renderHistoryBoundary(session)
      updatePrimaryAction()
      syncAnimationTimers(active)
    }
    return
  }
  let incomingSnapshot = message.snapshot
  const incomingSession = incomingSnapshot.session
  const cachedHistory = incomingSession ? historyController.expandedPage(incomingSession.id) : undefined
  if (incomingSession && cachedHistory) {
    if ((incomingSession.history?.totalMessages ?? 0) < cachedHistory.totalMessages) {
      historyController.deleteSession(incomingSession.id)
    } else {incomingSnapshot = {
        ...incomingSnapshot,
        session: mergeHistoryPage(incomingSession, {
          ...cachedHistory,
          totalMessages: incomingSession.history?.totalMessages ?? cachedHistory.totalMessages,
          sourceMayBeTruncated: incomingSession.history?.sourceMayBeTruncated ?? cachedHistory.sourceMayBeTruncated,
        }),
      }}
  }
  if (pendingSessionID && incomingSnapshot.session?.id !== pendingSessionID) return
  if (pendingSessionID === incomingSnapshot.session?.id) pendingSessionID = undefined
  const previousSession = snapshot.session
  const nextSession = incomingSnapshot.session
  if (creatingSession && nextSession) creatingSession = false
  if (
    previousSession && nextSession && previousSession.id === nextSession.id &&
    (previousSession.status.type === "busy" || previousSession.status.type === "retry") &&
    nextSession.status.type === "idle"
  ) {
    announce("OpenCode response complete")
  }
  snapshot = store.replace(incomingSnapshot)
  const comparisonIDs = new Set((snapshot.runComparisons ?? []).map((comparison) => comparison.artifactID))
  comparisonSorts = Object.fromEntries(
    Object.entries(comparisonSorts).filter(([artifactID]) => comparisonIDs.has(artifactID)),
  )
  render()
})

if (document.body.dataset.mode === "editor") {
  splitPanes = new SplitPaneController({
    root: document.body,
    panes: [
      {
        key: "sessionsWidth",
        separator: sessionsSplitter,
        cssProperty: "--sessions-pane-width",
        initialWidth: storedState?.layout?.sessionsWidth ?? 320,
        minimumWidth: 280,
        maximumWidth: 520,
        availableWidth: () => Math.max(280, Math.floor(window.innerWidth * 0.42)),
        edge: "right",
      },
    ],
    persist: (widths) => {
      const current = vscode.getState() ?? {}
      vscode.setState({ ...current, layout: { ...current.layout, sessionsWidth: widths.sessionsWidth } })
    },
  })
  const restoreRail = storedState?.layout?.sessionsOpen
  if (restoreRail === true || (restoreRail === undefined && window.innerWidth > 1120)) showRail(false)
  else {
    closeRail(false, false)
  }
}
if (initialWorkbenchControl) {
  requestAnimationFrame(() => {
    document.body.removeAttribute("data-initial-control")
    if (initialWorkbenchControl === "composer-focus") draft.focus()
    else if (initialWorkbenchControl === "sessions-toggle") {
      if (document.body.classList.contains("rail-open")) closeRail()
      else showRail()
    } else if (initialWorkbenchControl === "sessions-show") showRail()
    else {
      const initialFocus = attentionList.querySelector<HTMLElement>("button") ??
        attentionOverlay.querySelector<HTMLElement>(".attention-panel [data-close-attention]") ?? undefined
      attentionOverlayController.show(initialFocus)
    }
  })
}
window.addEventListener("resize", () => {
  if (!document.body.classList.contains("rail-open")) return
  if (narrowWorkbench()) {
    rightRail.setAttribute("role", "dialog")
    rightRail.setAttribute("aria-modal", "true")
    conversationColumn.inert = true
  } else {
    rightRail.removeAttribute("role")
    rightRail.removeAttribute("aria-modal")
    conversationColumn.inert = false
  }
})
document.addEventListener("visibilitychange", () => {
  const active = snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry"
  syncAnimationTimers(Boolean(active))
})
window.addEventListener("beforeunload", () => {
  flushPendingDraft()
  cancelVisibleTurnMarkerSync()
  if (conversationScrollFrame !== undefined) cancelAnimationFrame(conversationScrollFrame)
  if (viewportLayoutFrame !== undefined) cancelAnimationFrame(viewportLayoutFrame)
  turnNavigationResizeObserver?.disconnect()
  splitPanes?.dispose()
  transport.dispose()
})
resizeDraft()
post({ type: "ready" })
