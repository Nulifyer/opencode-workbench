import { createOpenCodeMessageID, parseHostMessage } from "@opencode-workbench/shared"
import { PROMPT_ATTACHMENT_COUNT_LIMIT, PROMPT_TEXT_CHARACTER_LIMIT, reusablePermissionScopes, type ChatSnapshot, type ContextAttachmentSummary, type EditorContextSummary, type InlineAttachment, type MessageBundle, type MessagePart, type PastedTextBlock, type PermissionRequest, type RuntimeService, type WebviewToHostMessage } from "@opencode-workbench/shared"
import { activityCollapsed, activityVisualState, activityWorking, applyPatchFiles, applyPatchSection, attachmentDisplay, attachmentReference, commandActivityLabel, connectionPresentation, currentTodoContent, delegationCompletionSummary, diffLineKind, fileReference, fileUriFromPath, formatDuration, isCompactionMessage, isGoalContinuationMessage, mergeRevisionValues, pastedTextReference, patchActivityLabel, permissionPresentation, questionAnswerValues, reasoningDetail, reasoningSummary, runtimeServicePresentation, sessionGroup, sessionLoadPhase, shouldCollapsePaste, shouldSubmitComposerKey, stripTerminalSequences, toolKind, turnContent, workspaceMentionReference } from "./presentation.js"
import { renderMarkdown } from "./markdown.js"

interface WebviewState {
  todoExpanded?: boolean
}

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHostMessage): void; getState(): WebviewState | undefined; setState(state: WebviewState): void }

const vscode = acquireVsCodeApi()
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const messages = element<HTMLElement>("messages")
const jumpLatest = element<HTMLButtonElement>("jump-latest")
const jumpLatestCount = element<HTMLElement>("jump-latest-count")
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
const surfaceToggle = element<HTMLButtonElement>("surface-toggle")
const backParent = element<HTMLButtonElement>("back-parent")
const sessionCurrent = element<HTMLButtonElement>("session-current")
const sessionTitle = element<HTMLElement>("session-title")
const sessionState = element<HTMLElement>("session-state")
const status = element<HTMLElement>("status")
const connection = element<HTMLElement>("connection")
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
const goalDock = element<HTMLElement>("goal-dock")
const todoDock = element<HTMLElement>("todo-dock")
const workspaceStrip = element<HTMLElement>("workspace-strip")
const historyOverlay = element<HTMLElement>("history-overlay")
const historySearch = element<HTMLInputElement>("history-search")
const historyList = element<HTMLElement>("history-list")
const railToggle = element<HTMLButtonElement>("rail-toggle")
const railClose = element<HTMLButtonElement>("rail-close")
const sessionMenuToggle = element<HTMLButtonElement>("session-menu-toggle")
const sessionMenu = element<HTMLElement>("session-menu")
const sessionMenuSearch = element<HTMLInputElement>("session-menu-search")
const sessionContextMenu = element<HTMLElement>("session-context-menu")
const railSessions = element<HTMLElement>("rail-sessions")
const railSessionCount = element<HTMLElement>("rail-session-count")
const railSessionSearch = element<HTMLInputElement>("rail-session-search")
const railSessionList = element<HTMLElement>("rail-session-list")
let snapshot: ChatSnapshot = { connected: false, connectionState: "connecting", sessions: [], agents: [], models: [] }
const storedState = vscode.getState()
let todoExpanded = storedState?.todoExpanded ?? true
let overlayReturnFocus: HTMLElement | undefined
let railReturnFocus: HTMLElement | undefined
let contextSessionID: string | undefined
let contextReturnSessionID: string | undefined
let contextReturnList: HTMLElement | undefined
let renderedTranscriptSessionID: string | undefined
let queueSignature = ""
let permissionSignature = ""
let questionSignature = ""
let sessionListSignature = ""
let catalogSignature = ""
let modelPickerSignature = ""
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
let unseenMessages = 0
let attachmentPreviewReturnFocus: HTMLElement | undefined
let reasoningExpanded = false
let noticeKind: "error" | "offline" | undefined
let noticeDetail = ""
const localDrafts = new Map<string, string>()
const draftRevisions = new Map<string, number>()
const submittedDrafts = new Map<string, string>()
const attachments = new Map<string, InlineAttachment[]>()
const attachmentThumbnails = new Map<string, string>()
const composerPayloadRevisions = new Map<string, number>()
type ComposerPayloadState = { attachments: InlineAttachment[]; pastedText: PastedTextBlock[] }
type PendingComposerPayload = ComposerPayloadState & { revision: number; mutationID: string; base: ComposerPayloadState }
const acknowledgedComposerPayloads = new Map<string, ComposerPayloadState>()
const pendingComposerPayloads = new Map<string, PendingComposerPayload>()
type SentAttachmentPreview = { label: string; name: string; mime: string; thumbnail?: string }
const sentAttachmentPreviews = new Map<string, { sessionID: string; attachments: SentAttachmentPreview[] }>()
const pastedText = new Map<string, PastedTextBlock[]>()
const contextAttachments = new Map<string, ContextAttachmentSummary[]>()
const stashedDrafts = new Map<string, string>()
const INLINE_ATTACHMENT_COUNT_LIMIT = 10
const renderedTurns = new Map<string, HTMLElement>()
const renderedMessages = new Map<string, { node: HTMLElement; signature: string }>()
const turnClassifications = new Map<string, { signature: string; hasActivity: boolean; finalTextPartKeys: string[] }>()
const activityCollapsePreferences = new Map<string, boolean>()
const announcedAssistantText = new Map<string, string>()
let announcementTimer: number | undefined
let pendingAnnouncement = ""
const PRIMARY_ICONS = {
  send: send.innerHTML,
  queue: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 2.4 11.5 7 1.8 11.6 2.9 8 7.4 7 2.9 6 1.8 2.4Zm10.7 7.1h1.2v1.8h1.8v1.2h-1.8v1.8h-1.2v-1.8h-1.8v-1.2h1.8V9.5Z"/></svg>`,
  stop: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4h8v8H4V4Z"/></svg>`,
  sent: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.2 3 3L13 4.8l1 1-8 7.4-4-4 1-1Z"/></svg>`,
  stopping: `<svg class="stopping-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4h8v8H4V4Z"/></svg>`,
}
const FILE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.8h6l4 4V14H3V1.8Zm1.2 1.4v9.6h7.6V6.4H8.4V3.2H4.2Zm5.4.5v1.5h1.5L9.6 3.7Z"/></svg>`
const FOLDER_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 3h5l1.4 1.6h6V13h-12.4V3Zm1.3 1.3v7.4h9.8V5.9H7.6L6.2 4.3H3.1Z"/></svg>`
const COPY_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2h8v9h-2V9.8h.8V3.2H6.2V4H5V2Zm-2 3h8v9H3V5Zm1.2 1.2v6.6h5.6V6.2H4.2Z"/></svg>`
const EDIT_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m11.7 1.8 2.5 2.5-8.1 8.1-3.3.8.8-3.3 8.1-8.1Zm0 1.7-7 7-.3 1.1 1.1-.3 7-7-.8-.8Z"/></svg>`
const OPEN_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5h-1.3V4.2L7.4 9.5l-.9-.9 5.3-5.3H9V2ZM3.2 3.2h4.1v1.3H4.5v7h7V8.7h1.3v4.1H3.2V3.2Z"/></svg>`
const CHEVRON_DOWN_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.2 5.2 4.8 4.7 4.8-4.7.9.9L8 11.8 2.3 6.1l.9-.9Z"/></svg>`
const SESSION_ICONS = {
  question: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 13A5 5 0 1 1 8 3a5 5 0 0 1 0 10Zm-.7-3h1.4v1.4H7.3V10Zm.8-5.7c1.4 0 2.4.8 2.4 2 0 .9-.5 1.4-1.3 1.9-.6.3-.7.5-.7 1H7.2c0-1.1.3-1.5 1.2-2 .6-.4.8-.6.8-1 0-.5-.4-.8-1.1-.8-.6 0-1 .3-1.4.8l-1-.8c.6-.7 1.3-1.1 2.4-1.1Z"/></svg>`,
  permission: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.3 13 3v3.8c0 3.2-2 5.9-5 7.5-3-1.6-5-4.3-5-7.5V3l5-1.7Zm0 1.5L4.3 4v2.8c0 2.5 1.4 4.6 3.7 6 2.3-1.4 3.7-3.5 3.7-6V4L8 2.8Zm-.7 2h1.4v4H7.3v-4Zm0 5.1h1.4v1.4H7.3V9.9Z"/></svg>`,
  error: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 13A5 5 0 1 1 8 3a5 5 0 0 1 0 10ZM7.3 4.7h1.4v4.2H7.3V4.7Zm0 5.3h1.4v1.4H7.3V10Z"/></svg>`,
  retry: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.3 4V1.8h1.3v4.4H9.2V4.9h2.1A4.7 4.7 0 1 0 12.5 9h1.4A6.1 6.1 0 1 1 12.3 4Z"/></svg>`,
  completed: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 13A5 5 0 1 1 8 3a5 5 0 0 1 0 10Zm2.7-7.6 1 1-4.3 4.2-2.2-2.2 1-1 1.2 1.2 3.3-3.3Z"/></svg>`,
  queued: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h8v1.3H2V3Zm0 4h8v1.3H2V7Zm0 4h8v1.3H2V11Zm10-5h1.3v2H15v1.3h-1.7V11H12V9.3h-1.7V8H12V6Z"/></svg>`,
}

type UnknownRecord = Record<string, unknown>
type Delegation = NonNullable<NonNullable<ChatSnapshot["session"]>["delegations"]>[number]
type Change = NonNullable<NonNullable<ChatSnapshot["session"]>["changes"]>[number]
type SessionOption = ChatSnapshot["sessions"][number]

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character)
}

function showNotice(kind: "error" | "offline", title: string, message: string, retryLabel?: string): void {
  noticeKind = kind
  noticeDetail = message
  notice.classList.toggle("offline", kind === "offline")
  noticeTitle.textContent = title
  noticeMessage.textContent = message
  noticeRetry.textContent = retryLabel ?? ""
  noticeRetry.hidden = !retryLabel
  notice.hidden = false
}

function clearNotice(kind?: "error" | "offline"): void {
  if (kind && noticeKind !== kind) return
  noticeKind = undefined
  noticeDetail = ""
  notice.hidden = true
}

function fileTooltip(reference: string | NonNullable<ReturnType<typeof fileReference>>): string {
  const file = typeof reference === "string" ? reference : reference.file
  const suffix = typeof reference === "string" || !reference.line
    ? ""
    : `:${reference.line}${reference.column ? `:${reference.column}` : ""}${reference.endLine ? `-${reference.endLine}${reference.endColumn ? `:${reference.endColumn}` : ""}` : ""}`
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(file)) return `${file}${suffix}`
  const directory = snapshot.session?.directory?.replace(/[\\/]$/, "")
  return `${directory ? `${directory}/${file}` : file}${suffix}`
}

function fileName(file: string): string {
  return file.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || file
}

function fileButton(reference: NonNullable<ReturnType<typeof fileReference>>, label = fileName(reference.file)): string {
  return `<button type="button" class="inline-file" title="${escapeHtml(fileTooltip(reference))}" data-file="${escapeHtml(reference.file)}"${reference.line ? ` data-line="${reference.line}"` : ""}${reference.column ? ` data-column="${reference.column}"` : ""}${reference.endLine ? ` data-end-line="${reference.endLine}"` : ""}${reference.endColumn ? ` data-end-column="${reference.endColumn}"` : ""}>${FILE_ICON}<span>${escapeHtml(label)}</span></button>`
}

function codeBlock(content: string, language = "", extraClass = ""): string {
  return `<div class="code-block${extraClass ? ` ${extraClass}` : ""}"><div class="code-block-header"><span>${escapeHtml(language)}</span><button type="button" class="copy-block" data-copy-block title="Copy code" aria-label="Copy code">${COPY_ICON}</button></div><pre><code${language ? ` data-language="${escapeHtml(language)}"` : ""}>${escapeHtml(content)}</code></pre></div>`
}

function shellBlock(content: string, kind: "command" | "output" | "error"): string {
  const label = kind === "command" ? "Command" : kind === "output" ? "Output" : "Error"
  const clean = stripTerminalSequences(content)
  return `<div class="code-block shell-block shell-${kind}"><div class="code-block-header"><span>${label}</span><button type="button" class="copy-block" data-copy-block title="Copy ${label.toLowerCase()}" aria-label="Copy ${label.toLowerCase()}">${COPY_ICON}</button></div><pre aria-label="${label}"><code>${escapeHtml(clean)}</code></pre></div>`
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

function detailFields(value: UnknownRecord, excluded: ReadonlySet<string> = new Set()): string {
  return Object.entries(value)
    .filter(([key]) => !excluded.has(key))
    .map(([key, item]) => codeBlock(stringify(item), fieldLabel(key), "tool-field-block"))
    .join("")
}

function detailBody(part: MessagePart): string {
  const state = stateRecord(part)
  if (!state) return ""
  const input = record(state.input) ? state.input : undefined
  const command = toolKind(part) === "bash" && typeof input?.command === "string" ? input.command : undefined
  if (command) {
    const output = state.output === undefined || state.output === "" ? "" : shellBlock(stringify(state.output), "output")
    const error = state.error === undefined || state.error === "" ? "" : shellBlock(stringify(state.error), "error")
    return `<div class="tool-detail shell-detail">${shellBlock(command, "command")}${output}${error}</div>`
  }
  const inputBody = input ? detailFields(input) : state.input === undefined ? "" : codeBlock(stringify(state.input), "Input", "tool-input-block")
  const output = state.output === undefined || state.output === "" ? "" : codeBlock(stringify(state.output), "Output", "tool-output-block")
  const error = state.error === undefined || state.error === "" ? "" : codeBlock(stringify(state.error), "Error", "tool-error-block")
  const metadata = state.metadata === undefined ? "" : `<details class="tool-metadata"><summary>Metadata</summary>${codeBlock(stringify(state.metadata), "Metadata")}</details>`
  const body = `${inputBody}${output}${error}${metadata}`
  return body ? `<div class="tool-detail">${body}</div>` : ""
}

function toolSubject(part: MessagePart): string {
  const state = stateRecord(part)
  const input = record(state?.input) ? state.input : undefined
  const metadata = record(state?.metadata) ? state.metadata : undefined
  const subject = input?.filePath ?? input?.path ?? input?.pattern ?? input?.name ?? metadata?.name ?? part.state?.title
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
  const labels = {
    skill: stateful("Loading skill", "Loaded skill", "Failed to load skill", "Stopped loading skill"),
    explore: stateful("Exploring item", "Explored item", "Failed to explore item", "Stopped exploring item"),
    edit: patch ? patchActivityLabel(state) : stateful("Editing file", "Edited file", "Failed to edit file", "Stopped editing file"),
    todo: stateful("Updating todos", "Updated todos", "Failed to update todos", "Stopped updating todos"),
    task: stateful("Delegating task", "Delegated task", "Failed to delegate task", "Stopped delegating task"),
    patch: patchActivityLabel(state),
    unknown: part.state?.title || part.tool || "Tool call",
  }
  const label = labels[kind]
  return subject && !label.includes(subject) ? `${label}: ${subject}` : label
}

function matchingChange(file: string): Change | undefined {
  const normalized = file.replace(/\\/g, "/")
  return snapshot.session?.changes?.find((change) => {
    const candidate = change.file.replace(/\\/g, "/")
    return candidate === normalized || normalized.endsWith(`/${candidate}`) || candidate.endsWith(`/${normalized}`)
  })
}

function editPatch(part: MessagePart): string {
  const state = stateRecord(part)
  const input = record(state?.input) ? state.input : undefined
  const candidates = [input?.patchText, input?.patch, input?.diff, state?.output]
  return candidates.find((value) => typeof value === "string" && (/^\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/m.test(value) || /^@@/m.test(value))) as string | undefined ?? ""
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
  return patch.split("\n").map((line) => {
    const kind = diffLineKind(line)
    return `<span class="diff-${kind}">${escapeHtml(line || " ")}</span>`
  }).join("\n")
}

function editPatchBlock(patch: string): string {
  const preview = patch.length > 50_000 ? `${patch.slice(0, 50_000)}\n\n[Preview truncated; open the patch for complete output.]` : patch
  return `<div class="code-block diff-block edit-patch-block"><button type="button" class="copy-block" data-copy-block title="Copy diff" aria-label="Copy diff">${COPY_ICON}</button><pre><code>${diffMarkup(preview)}</code></pre></div>`
}

interface EditEntry {
  file: string
  patch: string
  additions: number
  deletions: number
  key: string
}

function editEntries(part: MessagePart, key: string): EditEntry[] {
  const patch = editPatch(part)
  const subject = toolSubject(part)
  const files = applyPatchFiles(patch)
  if (!files.length && Array.isArray(part.files)) files.push(...part.files.filter((file): file is string => typeof file === "string").slice(0, 100))
  if (!files.length && subject) files.push(subject)
  return files.map((file, index) => {
    const change = matchingChange(file)
    const detail = change?.patch || applyPatchSection(patch, file)
    const stats = change ?? diffStats(detail)
    return { file: change?.file || file, patch: detail, additions: stats.additions, deletions: stats.deletions, key: `${key}:${index}` }
  })
}

function editEntryHtml(entry: EditEntry): string {
  const stats = `<span class="edit-stats"><b>+${entry.additions}</b> <i>−${entry.deletions}</i></span>`
  const openLabel = `Open ${fileName(entry.file)} in VS Code`
  return `<details class="edit-entry" data-detail-key="${escapeHtml(entry.key)}"><summary>${EDIT_ICON}<button type="button" class="edit-file" data-file="${escapeHtml(entry.file)}" title="${escapeHtml(openLabel)}" aria-label="${escapeHtml(openLabel)}">${escapeHtml(fileName(entry.file))}</button>${stats}</summary>${entry.patch ? editPatchBlock(entry.patch) : `<p class="placeholder">No patch preview available.</p>`}</details>`
}

function groupedEditsHtml(parts: MessagePart[], key: string, active: boolean): string {
  const entries = parts.flatMap((part, index) => editEntries(part, `${key}:${index}`))
  if (!entries.length) return parts.map((part, index) => toolHtml(part, `${key}:${index}`, active, false)).join("")
  if (entries.length === 1) return editEntryHtml(entries[0]!)
  return `<details class="activity edit-group" data-detail-key="${escapeHtml(key)}"><summary>${EDIT_ICON}<span class="activity-title">Edited files</span></summary><div class="edit-list">${entries.map(editEntryHtml).join("")}</div></details>`
}

function activityMetaHtml(part: MessagePart, state: string): string {
  const start = partTime(part, "start")
  const end = partTime(part, "end")
  const failed = ["error", "failed", "rejected"].includes(state)
  if (failed) return `<span class="activity-status">Failed</span>`
  if (state === "stopped") return `<span class="activity-status">Stopped</span>`
  if (start !== undefined && end !== undefined) return `<span class="activity-status">${escapeHtml(formatDuration(Math.max(0, end - start)))}</span>`
  if (start !== undefined && ["running", "pending"].includes(state)) {
    return `<span class="activity-status"><span class="activity-timer" data-start-time="${start}">${formatDuration(Math.max(0, Date.now() - start))}</span></span>`
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
        actions.push({ label: `Thought: ${reasoningSummary(part.text) || "Reasoning"}`, detail: `<div class="markdown">${markdown(part.text)}</div>`, state: "completed", kind: "reasoning" })
      } else if (part.type === "tool") {
        const state = String(part.state?.status || "pending").toLowerCase()
        actions.push({ label: toolLabel(part, state), detail: detailBody(part), state, kind: "tool", tool: part })
      } else if (part.type === "text" && part.text?.trim()) {
        actions.push({ label: "Assistant output", detail: `<div class="markdown">${markdown(part.text)}</div>`, state: "completed", kind: "output" })
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
    ? `<details class="delegation-action tool-${state}" data-detail-key="${escapeHtml(key)}"><summary>${summary}</summary>${action.detail}</details>`
    : `<div class="delegation-action delegation-action-static tool-${state}">${summary}</div>`
}

function delegationRequestHtml(part: MessagePart, key: string): string {
  const state = stateRecord(part)
  const input = record(state?.input) ? state.input : undefined
  if (!input) return ""
  const prompt = typeof input.prompt === "string" ? input.prompt : undefined
  const fields = detailFields(input, new Set(["prompt"]))
  return `<details class="delegation-raw" data-detail-key="${escapeHtml(`${key}:request`)}"><summary>Task request</summary><div class="delegation-request-body">${fields}${prompt ? `<details class="task-prompt" data-detail-key="${escapeHtml(`${key}:prompt`)}"><summary>Full prompt</summary>${codeBlock(prompt, "Prompt")}</details>` : ""}</div></details>`
}

function delegationHtml(part: MessagePart, key: string, delegation: Delegation, parentActive: boolean): string {
  const state = delegation.status.type === "busy" || delegation.status.type === "retry" ? activityVisualState("running", parentActive) : delegation.status.type === "error" ? "error" : "completed"
  const actions = delegationActions(delegation)
  const recent = actions.slice(-4)
  const latest = actions.at(-1)
  const current = actions.slice().reverse().find((action) => ["running", "pending"].includes(action.state)) ?? latest
  const request = delegationRequestHtml(part, key)
  const active = state === "running"
  const completion = delegationCompletionSummary(actions, state === "error")
  const progress = active ? current?.label ?? "Starting subagent…" : state === "stopped" ? completion === "Completed" ? "Stopped" : `Stopped · ${completion}` : completion
  return `<details class="activity delegation tool-${state}" data-detail-key="${escapeHtml(key)}">
    <summary><span class="activity-dot" aria-hidden="true"></span><span class="delegation-summary"><span class="activity-title">${escapeHtml(delegation.title)}</span><span class="delegation-progress"><span>${escapeHtml(progress)}</span>${activityMetaHtml(part, state)}</span></span></summary>
    <div class="delegation-body">
      ${recent.length ? `<div class="delegation-recent"><div class="picker-heading">Recent activity</div>${recent.map((action, index) => delegationActionHtml(action, `${key}:recent:${actions.length - recent.length + index}`, active)).join("")}</div>` : `<p class="placeholder">Waiting for delegated activity.</p>`}
      ${actions.length > recent.length ? `<details class="delegation-history" data-detail-key="${escapeHtml(`${key}:history`)}"><summary>All activity (${actions.length})</summary><div>${actions.map((action, index) => delegationActionHtml(action, `${key}:history:${index}`, active)).join("")}</div></details>` : ""}
      ${request}
      <button type="button" class="text-action delegated-session-action" data-delegation-session="${escapeHtml(delegation.sessionID)}"><span>Open delegated session</span>${OPEN_ICON}</button>
    </div>
  </details>`
}

function toolHtml(part: MessagePart, key: string, active: boolean, specialize = true): string {
  const state = activityVisualState(String(part.state?.status || "pending"), active)
  const delegation = part.tool === "task" ? snapshot.session?.delegations?.find((item) => item.partID === part.id) : undefined
  if (delegation) return delegationHtml(part, key, delegation, active)
  if (specialize && ["edit", "patch"].includes(toolKind(part))) return groupedEditsHtml([part], key, active)
  const detail = detailBody(part)
  return `<details class="activity tool-${escapeHtml(state)}" data-detail-key="${escapeHtml(key)}"><summary><span class="activity-dot" aria-hidden="true"></span><span class="activity-title">${escapeHtml(toolLabel(part, state))}</span>${activityMetaHtml(part, state)}</summary>${detail}</details>`
}

function groupedToolsHtml(parts: MessagePart[], kind: "skill" | "explore", key: string): string {
  const title = kind === "skill" ? `Loaded ${parts.length} skill${parts.length === 1 ? "" : "s"}` : `Explored ${parts.length} item${parts.length === 1 ? "" : "s"}`
  const lines = parts.map((part) => toolSubject(part) || part.state?.title || part.tool || "item")
  const starts = parts.map((part) => partTime(part, "start")).filter((value): value is number => value !== undefined)
  const ends = parts.map((part) => partTime(part, "end")).filter((value): value is number => value !== undefined)
  const timing = starts.length && ends.length ? formatDuration(Math.max(0, Math.max(...ends) - Math.min(...starts))) : ""
  return `<details class="activity compact-activity" data-detail-key="${escapeHtml(key)}"><summary><span class="activity-dot" aria-hidden="true"></span><span class="activity-title">${escapeHtml(title)}</span>${timing ? `<span class="activity-status">${escapeHtml(timing)}</span>` : ""}</summary><pre>${escapeHtml(lines.join("\n"))}</pre></details>`
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
  const starts = assistants.flatMap(({ message }) => message.parts.map((part) => partTime(part, "start"))).filter((value): value is number => value !== undefined)
  const ends = assistants.flatMap(({ message }) => message.parts.map((part) => partTime(part, "end"))).filter((value): value is number => value !== undefined)
  const start = starts.length ? Math.min(...starts) : assistants.map((entry) => entry.message.info.time?.created).find((value): value is number => typeof value === "number")
  const end = ends.length ? Math.max(...ends) : assistants.map((entry) => entry.message.info.time?.completed).filter((value): value is number => typeof value === "number").at(-1)
  if (typeof start !== "number") return live ? `<span>Working</span><span class="activity-chevron" aria-hidden="true">›</span>` : ""
  if (!live && typeof end !== "number") return ""
  const duration = Math.max(0, (typeof end === "number" ? end : Date.now()) - start)
  return `<span>${live ? "Working" : "Worked"} for ${formatDuration(duration)}</span><span class="activity-chevron" aria-hidden="true">›</span>`
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
    }
    else if (part.type === "reasoning" && part.text?.trim()) {
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
        ? `<div class="reasoning-list">${grouped.map((item) => {
            const text = item.text!.trim()
            const itemDetail = reasoningDetail(text)
            return `<section><strong>${escapeHtml(reasoningSummary(text) || "Thought")}</strong>${itemDetail ? `<div class="markdown">${markdown(itemDetail)}</div>` : ""}</section>`
          }).join("")}</div>`
        : detail
      const detailed = grouped.length > 1 || Boolean(detail)
      processBody += !detailed
        ? `<div class="reasoning reasoning-static"><span>${label}:</span>${latestSummary ? `<span class="reasoning-summary">${escapeHtml(latestSummary)}</span>` : ""}</div>`
        : `<details class="reasoning${grouped.length > 1 ? " reasoning-group" : ""}" data-detail-key="${escapeHtml(`${message.info.id}:${part.id}`)}"${reasoningExpanded ? " open" : ""}><summary><span>${label}:</span>${latestSummary ? `<span class="reasoning-summary">${escapeHtml(latestSummary)}</span>` : ""}</summary>${grouped.length > 1 ? content : `<div class="markdown">${markdown(content as string)}</div>`}</details>`
    } else if (part.type === "tool") {
      const kind = toolKind(part)
      if ((kind === "edit" || kind === "patch") && completed(part)) {
        const grouped = [part]
        while (index + 1 < message.parts.length) {
          const next = message.parts[index + 1]!
          if (next.synthetic || next.type !== "tool" || !completed(next) || !["edit", "patch"].includes(toolKind(next))) break
          grouped.push(next)
          index += 1
        }
        processBody += groupedEditsHtml(grouped, `${message.info.id}:${part.id}`, live)
      } else if (kind === "edit" || kind === "patch") {
        processBody += toolHtml(part, `${message.info.id}:${part.id}`, live, false)
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
  if (message.info.error !== undefined) error = `<pre class="message-error">${escapeHtml(stringify(message.info.error))}</pre>`
  if (!processBody && !responseBody && live) processBody = `<span class="pending">Thinking</span>`
  const timestamp = message.info.time?.created ? new Date(message.info.time.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""
  const processOnly = processBody && !responseBody && !error ? " process-only" : ""
  const actions = !live && (responseBody || error) ? messageActions("assistant") : ""
  return `<article class="message assistant${processOnly}" data-message-id="${escapeHtml(message.info.id)}">${timestamp ? `<time class="message-time">${escapeHtml(timestamp)}</time>` : ""}<div class="content">${processBody ? `<div class="assistant-process">${processBody}</div>` : ""}${responseBody ? `<div class="assistant-response">${responseBody}</div>` : ""}${error}</div>${actions}</article>`
}

function messageActions(role: "user" | "assistant"): string {
  const action = (name: string, label: string, icon: string) => `<button type="button" data-message-action="${name}" title="${label}" aria-label="${label}">${icon}</button>`
  const retry = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.3 4V1.8h1.3v4.4H9.2V4.9h2.1A4.7 4.7 0 1 0 12.5 9h1.4A6.1 6.1 0 1 1 12.3 4Z"/></svg>`
  const fork = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.8a2.2 2.2 0 1 1-1.3 4v2.1c0 .8.6 1.4 1.4 1.4h4.2V5.8a2.2 2.2 0 1 1 1.4 0v4.9H5.1a2.8 2.8 0 0 1-2.8-2.8V5.8A2.2 2.2 0 0 1 5 1.8Zm0 1.4a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Zm5 0a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6ZM10 10.2a2.2 2.2 0 1 1-.7 4.3 2.2 2.2 0 0 1 .7-4.3Zm0 1.4a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z"/></svg>`
  return `<div class="message-actions" aria-label="Message actions">${action("copy", role === "user" ? "Copy message" : "Copy response", COPY_ICON)}${role === "user" ? action("edit", "Edit message", EDIT_ICON) : action("retry", "Retry response", retry)}${action("fork", "Fork from this message", fork)}</div>`
}

function attachmentPreviewsFor(message: MessageBundle): SentAttachmentPreview[] {
  const existing = sentAttachmentPreviews.get(message.info.id)
  return existing?.attachments ?? []
}

function userHtml(message: MessageBundle): string {
  if (isCompactionMessage(message)) {
    return `<div class="compaction-divider" data-message-id="${escapeHtml(message.info.id)}" role="separator"><span>Session compacted</span></div>`
  }
  if (isGoalContinuationMessage(message)) {
    return `<div class="compaction-divider goal-continuation-divider" data-message-id="${escapeHtml(message.info.id)}" role="separator"><span>Goal continued automatically</span></div>`
  }
  const textParts = message.parts.filter((part) => !part.synthetic && part.type === "text" && part.text)
  const text = textParts.map((part) => part.text).join("\n")
  const body = textParts.map((part) => `<div class="markdown">${markdown(part.text!)}</div>`).join("")
  const previews = attachmentPreviewsFor(message)
  const files = message.parts.filter((part) => part.type === "file" && typeof part.filename === "string").map((part) => {
    const filename = part.filename as string
    const display = attachmentDisplay(filename)
    const preview = display.label ? previews.find((item) => item.label === display.label) : undefined
    const thumbnail = preview?.thumbnail ? `<button type="button" class="transcript-attachment-thumbnail" data-transcript-preview="${escapeHtml(display.label!)}" aria-label="Preview ${escapeHtml(display.name)}"><img src="${preview.thumbnail}" alt=""></button>` : FILE_ICON
    return `<span class="attachment-chip transcript-attachment" title="${escapeHtml(typeof part.mime === "string" ? part.mime : "Attachment")}">${thumbnail}<span>${escapeHtml(display.name)}</span></span>`
  }).join("")
  const timestamp = message.info.time?.created ? new Date(message.info.time.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""
  const latest = snapshot.session?.messages.at(-1)?.info.id === message.info.id
  const active = latest && (snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry")
  const empty = !body && !files
    ? active
      ? "<span class=\"pending\">Saving message…</span>"
      : `<span class="message-failure" title="${escapeHtml(snapshot.session?.status.type === "error" ? snapshot.session.status.message || "OpenCode failed before saving this message." : "OpenCode did not persist any content for this message.")}">Message failed before its content was saved</span>`
    : ""
  return `<article class="message user" data-message-id="${escapeHtml(message.info.id)}"><div class="message-heading">You${timestamp ? `<time class="message-time">${escapeHtml(timestamp)}</time>` : ""}</div><div class="content">${body}${files ? `<div class="transcript-attachments">${files}</div>` : ""}${empty}</div>${messageActions("user")}</article>`
}

function htmlNode(html: string): HTMLElement {
  const template = document.createElement("template")
  template.innerHTML = html
  const node = template.content.firstElementChild
  if (!(node instanceof HTMLElement)) throw new Error("Could not render OpenCode message")
  return node
}

function replaceMessage(node: HTMLElement, html: string): HTMLElement {
  const detailStates = new Map(Array.from(node.querySelectorAll<HTMLDetailsElement>("details[data-detail-key]"), (detail) => [detail.dataset.detailKey || "", detail.open]))
  const active = document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? document.activeElement : undefined
  const focusedDetail = active?.closest<HTMLDetailsElement>("details[data-detail-key]")?.dataset.detailKey
  const focusedUrl = active?.closest<HTMLElement>("[data-url]")?.dataset.url
  const replacement = htmlNode(html)
  for (const detail of replacement.querySelectorAll<HTMLDetailsElement>("details[data-detail-key]")) {
    const open = detailStates.get(detail.dataset.detailKey || "")
    if (open !== undefined) detail.open = open
  }
  node.replaceWith(replacement)
  if (focusedDetail) replacement.querySelector<HTMLDetailsElement>(`details[data-detail-key="${CSS.escape(focusedDetail)}"]`)?.querySelector("summary")?.focus()
  else if (focusedUrl) Array.from(replacement.querySelectorAll<HTMLElement>("[data-url]")).find((candidate) => candidate.dataset.url === focusedUrl)?.focus()
  return replacement
}

function clearTranscript(): void {
  messages.replaceChildren()
  renderedTurns.clear()
  renderedMessages.clear()
  turnClassifications.clear()
  renderedTranscriptSessionID = undefined
  unseenMessages = 0
  updateJumpLatest()
}

function transcriptNearBottom(): boolean {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
}

function updateJumpLatest(): void {
  const show = !messages.hidden && !transcriptNearBottom()
  jumpLatest.hidden = !show
  jumpLatestCount.textContent = show && unseenMessages ? String(unseenMessages) : ""
  jumpLatest.setAttribute("aria-label", unseenMessages ? `Jump to latest message, ${unseenMessages} new` : "Jump to latest message")
}

function renderTranscript(session: NonNullable<ChatSnapshot["session"]>, active: boolean): void {
  if (renderedTranscriptSessionID !== session.id) {
    clearTranscript()
    renderedTranscriptSessionID = session.id
  }
  const nearBottom = transcriptNearBottom()
  const expectedMessages = new Set<string>()
  const expectedTurns = new Set<string>()
  const changeRevision = JSON.stringify(session.changes ?? [])
  const turnMessages = new Map<string, Array<{ message: MessageBundle; live: boolean }>>()
  const turnOrder: string[] = []
  let lastAssistantID: string | undefined
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index]?.info.role !== "assistant") continue
    lastAssistantID = session.messages[index]!.info.id
    break
  }
  let turnKey: string | undefined
  session.messages.forEach((message) => {
    if (message.info.role === "user") {
      turnKey = `user:${message.info.id}`
      turnOrder.push(turnKey)
      turnMessages.set(turnKey, [])
    } else if (!turnKey) {
      turnKey = `assistant:${message.info.id}`
      turnOrder.push(turnKey)
      turnMessages.set(turnKey, [])
    }
    const live = message.info.role === "assistant" && active && !message.info.time?.completed && message.info.id === lastAssistantID
    turnMessages.get(turnKey!)!.push({ message, live })
  })

  turnOrder.forEach((key, turnIndex) => {
    expectedTurns.add(key)
    let turn = renderedTurns.get(key)
    if (!turn) {
      turn = document.createElement("section")
      turn.className = `turn${key.startsWith("assistant:") ? " assistant-only" : ""}`
      renderedTurns.set(key, turn)
    }
    const expectedPosition = messages.children.item(turnIndex)
    if (expectedPosition !== turn) messages.insertBefore(turn, expectedPosition)
    const entries = turnMessages.get(key)!
    const displayEntries: Array<{ message: MessageBundle; live: boolean; revisionKey: string }> = []
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      const visible = entry.message.parts.filter((part) => !part.synthetic && part.type !== "step-start" && part.type !== "step-finish")
      if (entry.message.info.role !== "assistant" || !visible.length || !visible.every((part) => part.type === "reasoning")) {
        displayEntries.push({ ...entry, revisionKey: `${entry.message.info.id}:${session.messageRevisions[entry.message.info.id] ?? 0}` })
        continue
      }
      const run = [entry]
      while (index + 1 < entries.length) {
        const next = entries[index + 1]!
        const nextVisible = next.message.parts.filter((part) => !part.synthetic && part.type !== "step-start" && part.type !== "step-finish")
        if (next.message.info.role !== "assistant" || !nextVisible.length || !nextVisible.every((part) => part.type === "reasoning")) break
        run.push(next)
        index += 1
      }
      if (run.length === 1) {
        displayEntries.push({ ...entry, revisionKey: `${entry.message.info.id}:${session.messageRevisions[entry.message.info.id] ?? 0}` })
        continue
      }
      const first = run[0]!.message
      const last = run.at(-1)!.message
      displayEntries.push({
        message: {
          info: {
            id: `thoughts:${first.info.id}:${last.info.id}:${run.length}`,
            sessionID: first.info.sessionID,
            role: "assistant",
            time: { created: first.info.time?.created, completed: last.info.time?.completed },
          },
          parts: run.flatMap((item) => item.message.parts.filter((part) => !part.synthetic && part.type === "reasoning")),
        },
        live: run.some((item) => item.live),
        revisionKey: run.map((item) => `${item.message.info.id}:${session.messageRevisions[item.message.info.id] ?? 0}`).join(","),
      })
    }
    const firstAssistant = displayEntries.findIndex((entry) => entry.message.info.role === "assistant")
    const contentSignature = displayEntries.map((entry) => entry.revisionKey).join("|")
    const cachedContent = turnClassifications.get(key)
    const content = cachedContent?.signature === contentSignature
      ? cachedContent
      : { signature: contentSignature, ...turnContent(displayEntries.map((entry) => entry.message)) }
    if (cachedContent !== content) turnClassifications.set(key, content)
    const finalTextParts = new Set(content.finalTextPartKeys)
    const hasActivity = content.hasActivity
    const working = activityWorking(active, lastAssistantID, entries.filter((entry) => entry.message.info.role === "assistant").map((entry) => entry.message.info.id))
    const turnTiming = timingHtml(entries, working)
    const activityKey = `${session.id}:${key}`
    let activityHeader = turn.querySelector<HTMLElement>(":scope > .turn-activity-header")
    let activityToggle = activityHeader?.querySelector<HTMLButtonElement>(".turn-activity-toggle") ?? null
    if (hasActivity) {
      const wasWorking = activityToggle?.dataset.working === "true"
      const existingCollapse = activityToggle ? turn.classList.contains("activity-collapsed") : undefined
      if (working) activityCollapsePreferences.delete(activityKey)
      if (!activityToggle) {
        activityHeader = document.createElement("div")
        activityHeader.className = "turn-activity-header"
        activityToggle = document.createElement("button")
        activityToggle.type = "button"
        activityToggle.className = "turn-activity-toggle"
        activityToggle.dataset.turnActivity = "true"
        const divider = document.createElement("div")
        divider.className = "turn-activity-divider"
        activityHeader.append(activityToggle, divider)
      }
      turn.classList.toggle("activity-collapsed", activityCollapsed(working, wasWorking, activityCollapsePreferences.get(activityKey), existingCollapse))
      activityToggle.dataset.activityKey = activityKey
      activityToggle.dataset.working = String(working)
      activityToggle.setAttribute("aria-disabled", String(working))
      activityToggle.classList.toggle("working", working)
      activityToggle.innerHTML = turnTiming || `<span>Activity</span><span class="activity-chevron" aria-hidden="true">›</span>`
      activityToggle.setAttribute("aria-expanded", String(!turn.classList.contains("activity-collapsed")))
      activityToggle.title = working ? "Work activity stays expanded while OpenCode is working" : turn.classList.contains("activity-collapsed") ? "Show work activity" : "Hide work activity"
      const expectedHeader = turn.children.item(firstAssistant)
      if (expectedHeader !== activityHeader) turn.insertBefore(activityHeader!, expectedHeader)
    } else {
      activityHeader?.remove()
      turn.classList.remove("activity-collapsed")
      activityToggle = null
    }
    const classificationSignature = `${hasActivity}:${Array.from(finalTextParts).join(",")}`
    displayEntries.forEach(({ message, live, revisionKey }, messageIndex) => {
      expectedMessages.add(message.info.id)
      const delegationSignature = message.parts.flatMap((part) => {
        const delegation = session.delegations?.find((item) => item.partID === part.id)
        return delegation ? [`${part.id}:${delegation.revision}:${delegation.status.type}`] : []
      }).join(",")
      const signature = `${revisionKey}:${message.info.time?.completed ?? ""}:${live}:${classificationSignature}:${delegationSignature}:${changeRevision}`
      let rendered = renderedMessages.get(message.info.id)
      if (!rendered) {
        const html = message.info.role === "user" ? userHtml(message) : assistantHtml(message, live, finalTextParts)
        rendered = { node: htmlNode(html), signature }
        renderedMessages.set(message.info.id, rendered)
      } else if (rendered.signature !== signature) {
        const html = message.info.role === "user" ? userHtml(message) : assistantHtml(message, live, finalTextParts)
        rendered = { node: replaceMessage(rendered.node, html), signature }
        renderedMessages.set(message.info.id, rendered)
      }
      const offset = hasActivity && messageIndex >= firstAssistant ? 1 : 0
      const expectedMessage = turn.children.item(messageIndex + offset)
      if (expectedMessage !== rendered.node) turn.insertBefore(rendered.node, expectedMessage)
    })
  })
  for (const [messageID, rendered] of renderedMessages) {
    if (expectedMessages.has(messageID)) continue
    rendered.node.remove()
    renderedMessages.delete(messageID)
  }
  for (const [key, turn] of renderedTurns) {
    if (expectedTurns.has(key)) continue
    turn.remove()
    renderedTurns.delete(key)
    turnClassifications.delete(key)
  }
  if (nearBottom) {
    messages.scrollTop = messages.scrollHeight
    unseenMessages = 0
  }
  updateJumpLatest()
}

function fillSelect(select: HTMLSelectElement, defaultLabel: string, options: Array<{ value: string; label: string }>, selected?: string): void {
  const html = [`<option value="">${escapeHtml(defaultLabel)}</option>`, ...options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)].join("")
  if (select.dataset.options !== html) {
    select.innerHTML = html
    select.dataset.options = html
  }
  if (select.value !== (selected || "")) select.value = selected || ""
}

function variantLabel(value: string): string {
  return ({ none: "None", low: "Light", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" } as Record<string, string>)[value.toLowerCase()] ?? value
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
    ? `${selected.name} · ${snapshot.providers?.find((provider) => provider.id === selected.providerID)?.name ?? selected.providerID}${variant.value ? ` · ${variantLabel(variant.value)}` : ""}`
    : "Model and reasoning"
  if (modelPicker.hidden) return
  const signature = JSON.stringify([snapshot.models, model.value, variant.value, modelSearch.value])
  if (signature === modelPickerSignature) return
  modelPickerSignature = signature
  reasoningOptions.hidden = variants.length === 0
  const variantHeading = selected?.capabilities?.reasoning ? "Reasoning" : "Model variant"
  reasoningOptions.innerHTML = variants.length ? `<div class="picker-heading">${variantHeading}</div><button type="button" data-variant-value="" aria-pressed="${!variant.value}">Provider default</button>${variants.map((value) => `<button type="button" data-variant-value="${escapeHtml(value)}" aria-pressed="${variant.value === value}">${escapeHtml(variantLabel(value))}</button>`).join("")}` : ""
  const query = modelSearch.value.trim().toLowerCase()
  const matchingModels = snapshot.models
    .filter((item) => !query || `${item.name}\n${item.providerID}\n${item.id}`.toLowerCase().includes(query))
    .sort((left, right) => left.providerID.localeCompare(right.providerID, undefined, { numeric: true }) || left.name.localeCompare(right.name, undefined, { numeric: true }))
  const selectedMatch = matchingModels.find((item) => `${item.providerID}/${item.id}` === model.value)
  const models = [selectedMatch, ...matchingModels.filter((item) => item !== selectedMatch)].filter((item): item is typeof matchingModels[number] => Boolean(item)).slice(0, 120)
  const selectedModels = models.filter((item) => `${item.providerID}/${item.id}` === model.value)
  const groupedModels = models.filter((item) => `${item.providerID}/${item.id}` !== model.value)
  const modelButton = (item: typeof models[number]) => {
    const value = `${item.providerID}/${item.id}`
    return `<button type="button" data-model-value="${escapeHtml(value)}" aria-pressed="${model.value === value}"><span>${escapeHtml(item.name)}</span><small>${item.contextLimit ? `${Math.round(item.contextLimit / 1_000)}k` : ""}</small></button>`
  }
  let provider = ""
  const grouped = groupedModels.map((item) => {
    const providerInfo = snapshot.providers?.find((candidate) => candidate.id === item.providerID)
    const heading = provider === item.providerID ? "" : `<div class="picker-heading picker-provider">${escapeHtml(providerInfo?.name ?? item.providerID)}</div>`
    provider = item.providerID
    return `${heading}${modelButton(item)}`
  }).join("")
  modelOptions.innerHTML = models.length
    ? `${selectedModels.length ? `<div class="picker-heading picker-provider">Selected</div>${selectedModels.map(modelButton).join("")}` : ""}${grouped}`
    : `<p class="placeholder">No matching models.</p>`
  const limits = selected
    ? [selected.contextLimit ? `context ${selected.contextLimit.toLocaleString()}` : "context unknown", selected.inputLimit ? `input ${selected.inputLimit.toLocaleString()}` : "", selected.outputLimit ? `output ${selected.outputLimit.toLocaleString()}` : ""].filter(Boolean).join(" · ")
    : "Context limit unavailable"
  const abilities = selected ? [selected.capabilities?.reasoning ? "reasoning" : "", selected.capabilities?.toolcall ? "tools" : "", selected.capabilities?.input?.image ? "images" : "", selected.capabilities?.input?.pdf ? "PDF" : ""].filter(Boolean).join(", ") : ""
  const freshness = snapshot.catalog?.status === "stale" ? " · stale catalog" : snapshot.catalog?.status === "error" ? " · catalog unavailable" : ""
  const providerSource = selected ? snapshot.providers?.find((provider) => provider.id === selected.providerID)?.source : undefined
  modelMeta.textContent = `${limits}${abilities ? ` · ${abilities}` : ""}${providerSource ? ` · configured via ${providerSource}` : ""}${selected?.status && selected.status !== "active" ? ` · ${selected.status}` : ""}${freshness}`
  modelMeta.title = snapshot.catalog?.error || "Models are resolved by OpenCode for this workspace. OpenCode does not report provider subscription tier."
}

function openModelPicker(focusReasoning = false): void {
  commandSuggestions.hidden = true
  modelPicker.hidden = false
  modelToggle.setAttribute("aria-expanded", "true")
  renderModelPicker()
  requestAnimationFrame(() => focusReasoning && !reasoningOptions.hidden
    ? reasoningOptions.querySelector<HTMLButtonElement>("button[aria-pressed='true']")?.focus()
    : modelSearch.focus())
}

function closeModelPicker(): void {
  modelPicker.hidden = true
  modelToggle.setAttribute("aria-expanded", "false")
  modelSearch.value = ""
  modelPickerSignature = ""
}

const SESSION_GROUPS = ["Needs input", "Working", "Completed", "Today", "Yesterday", "Previous 7 days", "Older"] as const

function statusLabel(value: SessionOption): string {
  if (value.status.type === "error") return "Error"
  if ((value.questionCount ?? 0) > 0) return value.questionCount === 1 ? "Question pending" : `${value.questionCount} questions pending`
  if ((value.permissionCount ?? 0) > 0) return value.permissionCount === 1 ? "Permission pending" : `${value.permissionCount} permissions pending`
  if ((value.attention ?? 0) > 0) return "Input needed"
  if (value.status.type === "retry") return "Retrying"
  if (value.status.type === "busy") return "Working"
  if (value.unread > 0) return "Completed"
  if ((value.queued ?? 0) > 0) return `${value.queued} queued`
  return ""
}

function sessionIndicator(value: SessionOption): string {
  let kind = ""
  let label = ""
  let icon = ""
  if (value.status.type === "error") [kind, label, icon] = ["error", "Session error", SESSION_ICONS.error]
  else if ((value.questionCount ?? 0) > 0) [kind, label, icon] = ["question", statusLabel(value), SESSION_ICONS.question]
  else if ((value.permissionCount ?? 0) > 0 || (value.attention ?? 0) > 0) [kind, label, icon] = ["permission", statusLabel(value), SESSION_ICONS.permission]
  else if (value.status.type === "retry") [kind, label, icon] = ["retry", "Retrying", SESSION_ICONS.retry]
  else if (value.status.type === "busy") [kind, label] = ["working", "Working"]
  else if (value.unread > 0) [kind, label, icon] = ["completed", "Completed; not reviewed", SESSION_ICONS.completed]
  else if ((value.queued ?? 0) > 0) [kind, label, icon] = ["queued", `${value.queued} queued`, SESSION_ICONS.queued]
  return kind
    ? `<span class="session-row-icon state-${kind}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon}</span>`
    : `<span class="session-row-icon state-idle" aria-hidden="true"></span>`
}

function relativeSessionTime(updatedAt = 0): string {
  const elapsed = Math.max(0, Date.now() - updatedAt)
  if (elapsed < 60_000) return "now"
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h`
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}d`
}

function workspaceName(directory?: string): string {
  return directory?.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || ""
}

function sessionButton(value: SessionOption, selected?: string): string {
  const detail = [workspaceName(value.directory), value.changeCount ? `${value.changeCount} changed` : "", value.todo?.total ? `${value.todo.completed}/${value.todo.total} todos` : "", value.queued ? `${value.queued} queued` : ""].filter(Boolean).join(" · ")
  const status = statusLabel(value)
  return `<button type="button" class="session-row ${value.id === selected ? "selected" : ""}" data-session-id="${escapeHtml(value.id)}"${status ? ` title="${escapeHtml(status)}"` : ""}>${sessionIndicator(value)}<span class="session-row-copy"><span class="session-row-heading"><span class="session-row-title">${escapeHtml(value.title)}</span><time>${escapeHtml(relativeSessionTime(value.updatedAt))}</time></span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span></button>`
}

function sortedSessions(values: SessionOption[], group?: typeof SESSION_GROUPS[number]): SessionOption[] {
  return [...values].sort((left, right) => {
    if (!group) {
      const priority = SESSION_GROUPS.indexOf(sessionGroup(left)) - SESSION_GROUPS.indexOf(sessionGroup(right))
      if (priority) return priority
    }
    if (!group || ["Needs input", "Working", "Completed", "Today", "Yesterday"].includes(group)) return left.title.localeCompare(right.title)
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.title.localeCompare(right.title)
  })
}

function sessionSearchText(value: SessionOption): string {
  const group = sessionGroup(value)
  const aliases = value.unread > 0 ? "done unread" : ""
  return `${value.title}\n${value.directory ?? ""}\n${statusLabel(value)}\n${group}\n${aliases}`.toLowerCase()
}

function sessionListMarkup(values: SessionOption[], query: string, empty: string): string {
  const filtered = values.filter((value) => !query || sessionSearchText(value).includes(query))
  if (!filtered.length) return `<p class="placeholder">${escapeHtml(empty)}</p>`
  const ordered = query ? sortedSessions(filtered) : SESSION_GROUPS.flatMap((group) => sortedSessions(filtered.filter((value) => sessionGroup(value) === group), group))
  const visible = ordered.slice(0, sessionRenderLimit)
  const more = ordered.length > visible.length ? `<button type="button" class="text-action" data-session-more>Show ${Math.min(200, ordered.length - visible.length)} more</button>` : ""
  if (query) return `<section class="history-group"><h2>Results</h2>${visible.map((value) => sessionButton(value, snapshot.session?.id)).join("")}${more}</section>`
  return SESSION_GROUPS.map((group) => {
    const grouped = visible.filter((value) => sessionGroup(value) === group)
    return grouped.length ? `<section class="history-group"><h2>${group} <span>${grouped.length}</span></h2>${grouped.map((value) => sessionButton(value, snapshot.session?.id)).join("")}</section>` : ""
  }).join("") + more
}

function renderSessionLists(): void {
  const signature = JSON.stringify([snapshot.sessions, snapshot.session?.id, historySearch.value, railSessionSearch.value])
  if (signature === sessionListSignature) return
  sessionListSignature = signature
  historyList.innerHTML = sessionListMarkup(snapshot.sessions, historySearch.value.trim().toLowerCase(), "No matching sessions.")
  railSessionCount.textContent = String(snapshot.sessions.length)
  railSessionList.innerHTML = sessionListMarkup(snapshot.sessions, railSessionSearch.value.trim().toLowerCase(), railSessionSearch.value ? "No matching sessions." : "No sessions yet.")
}

function renderQueue(session: NonNullable<ChatSnapshot["session"]>): void {
  const queue = session.queue ?? []
  const running = queue.find((prompt) => prompt.id === session.inFlightPromptID)
  const pending = queue.filter((prompt) => prompt.id !== session.inFlightPromptID)
  const signature = JSON.stringify([session.id, queue, session.inFlightPromptID, session.status.type])
  if (signature === queueSignature) return
  queueSignature = signature
  queueDock.hidden = queue.length === 0
  const preview = (prompt: typeof queue[number]) => escapeHtml(prompt.text.replace(/\s+/g, " ").trim() || prompt.attachments?.map((attachment) => attachment.name).join(", ") || "Attachment")
  const active = session.status.type === "busy" || session.status.type === "retry"
  queueDock.innerHTML = queue.length ? `${running ? `<div class="dock-heading"><strong>Running</strong></div><ol><li class="queue-running"><span class="queue-preview">${preview(running)}</span><small>Command is executing</small></li></ol>` : ""}${pending.length ? `<div class="dock-heading"><strong>Queue</strong><span>${pending.length}</span></div><ol>${pending.map((prompt, index) => `<li><span class="queue-preview">${preview(prompt)}</span><span class="queue-actions"><button type="button" data-queue-action="now" data-prompt-id="${escapeHtml(prompt.id)}" title="${active ? "Cancel the current response and send this message" : "Send this message now"}" ${running ? "disabled" : ""}>${active ? "Stop and send" : "Send now"}</button><button type="button" data-queue-action="edit" data-prompt-id="${escapeHtml(prompt.id)}">Edit</button><button type="button" data-queue-action="up" data-prompt-id="${escapeHtml(prompt.id)}" ${index === 0 ? "disabled" : ""}>Up</button><button type="button" data-queue-action="down" data-prompt-id="${escapeHtml(prompt.id)}" ${index === pending.length - 1 ? "disabled" : ""}>Down</button><button type="button" data-queue-action="remove" data-prompt-id="${escapeHtml(prompt.id)}">Remove from queue</button></span></li>`).join("")}</ol>` : ""}` : ""
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
  permissionDock.innerHTML = permissions.map((request) => {
    const incomplete = request.truncated === true
    const disabled = incomplete ? ` disabled title="Unavailable because the request details were truncated"` : ""
    const delegated = request.sessionID !== session.id
    const delegation = delegated ? session.delegations?.find((item) => item.sessionID === request.sessionID) : undefined
    const origin = delegated ? `Requested by subagent${delegation ? `: ${delegation.title}` : ""}` : "Permission required"
    const presentation = permissionPresentation(request)
    const exactPatterns = typeof request.pattern === "string" ? [request.pattern] : request.pattern ?? []
    const reusableScopes = reusablePermissionScopes(request)
    const canReuseExact = exactPatterns.length > 0 && request.type !== "vscode.reload_opencode"
    const summaryText = presentation.lines.join("\n")
    const summary = summaryText ? `<pre class="permission-summary-lines" title="${escapeHtml(summaryText)}">${escapeHtml(summaryText)}</pre>` : ""
    const changes = presentation.diff ? `<details class="permission-changes"><summary>Review proposed changes</summary>${codeBlock(presentation.diff, "diff", "permission-diff")}</details>` : ""
    const exactAction = canReuseExact ? `<button type="button" role="menuitem" data-permission="exact">Allow Exact ${request.type === "bash" || request.type === "shell" ? "Command Line" : "Scope"} in this Session</button>` : ""
    const scopeActions = reusableScopes.map((candidate) => candidate === "*"
      ? `<button type="button" role="menuitem" data-permission="scope" data-permission-scope="*">Allow All Shell Commands in this Session</button>`
      : `<button type="button" role="menuitem" data-permission="scope" data-permission-scope="${escapeHtml(candidate)}">Allow <code>${escapeHtml(candidate.replace(/ \*$/, " …"))}</code> in this Session</button>`).join("")
    const allowMenu = !incomplete && (exactAction || scopeActions) ? `<details class="permission-allow-menu"><summary aria-label="More allow options" title="More allow options">${CHEVRON_DOWN_ICON}</summary><div class="permission-allow-options" role="menu">${exactAction}${scopeActions}</div></details>` : ""
    const incompleteDetails = incomplete ? `<details class="permission-raw"><summary>Available request data</summary><pre>${escapeHtml(incompletePermissionDetails(request))}</pre></details><p class="permission-warning">Some request metadata was truncated. Review the available data and reject this request.</p>` : ""
    return `<article class="permission-card${incomplete ? " permission-incomplete" : ""}" data-request-id="${escapeHtml(request.id)}" data-request-session="${escapeHtml(request.sessionID)}" data-request-protocol="${request.protocol}"><div class="permission-heading"><span class="permission-request-icon" aria-hidden="true">${escapeHtml(presentation.icon)}</span><span class="permission-heading-copy"><strong>${escapeHtml(presentation.title)}</strong><small>${escapeHtml(origin)}</small></span></div>${summary}${changes}${incompleteDetails}<details class="permission-feedback"><summary>Explain rejection <small>(optional)</small></summary><label class="custom-answer"><span>Feedback</span><input type="text" data-permission-feedback maxlength="20000" autocomplete="off"></label></details><div class="permission-actions"><button type="button" data-permission="reject">Reject</button><div class="permission-allow-group"><button type="button" data-permission="once" class="primary-action" title="Allow once"${disabled}>Allow</button>${allowMenu}</div></div></article>`
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
    return `<form class="question-card" data-question-request="${escapeHtml(request.id)}" data-request-session="${escapeHtml(request.sessionID)}">
    <div class="permission-heading"><strong>${delegated ? "Subagent needs input" : "OpenCode needs input"}</strong><span>${request.questions.length === 1 ? escapeHtml(request.questions[0]!.header) : `${request.questions.length} questions`}</span>${delegated ? `<small>Requested by subagent${delegation ? `: ${escapeHtml(delegation.title)}` : ""}</small>` : ""}</div>
    ${request.questions.map((question, questionIndex) => `<fieldset data-question-index="${questionIndex}"><legend>${escapeHtml(question.header)}</legend><p>${escapeHtml(question.question)}</p><div class="question-options">${question.options.map((option, optionIndex) => `<label><input type="${question.multiple ? "checkbox" : "radio"}" name="question-${escapeHtml(request.id)}-${questionIndex}" value="${escapeHtml(option.label)}"><span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("")}</div>${question.custom !== false ? `<label class="custom-answer"><span>Custom answer</span><input type="text" data-custom-answer maxlength="20000" autocomplete="off"></label>` : ""}</fieldset>`).join("")}
    <div class="permission-actions"><button type="button" data-question-action="reject">Reject</button><button type="submit" class="primary-action">Submit answer</button></div>
  </form>`
  }).join("")
}

function renderSummaries(session: NonNullable<ChatSnapshot["session"]>, active: boolean): void {
  const goal = session.goal
  const signature = JSON.stringify([session.id, goal, session.todos, active])
  if (signature === summarySignature) return
  summarySignature = signature
  goalDock.hidden = !goal
  if (goal) {
    const state = goal.status ? `${goal.status.charAt(0).toUpperCase()}${goal.status.slice(1)}` : "Active"
    const elapsed = goal.timeUsedSeconds === undefined ? "" : formatDuration(goal.timeUsedSeconds * 1_000)
    const turns = goal.autoTurns === undefined ? "" : goal.maxAutoTurns === undefined ? `Auto ${goal.autoTurns}` : `Auto ${goal.autoTurns}/${goal.maxAutoTurns}`
    const toggle = goal.status === "active" ? "pause" : goal.status === "paused" ? "resume" : undefined
    goalDock.innerHTML = `<button type="button" class="goal-open" data-goal-action="edit" title="Edit goal"><span class="goal-icon" aria-hidden="true">◎</span><span class="goal-state">${escapeHtml(state)}</span><strong>${escapeHtml(goal.objective || "Goal active")}</strong>${elapsed ? `<small>${escapeHtml(elapsed)}</small>` : ""}${turns ? `<small>${escapeHtml(turns)}</small>` : ""}</button><div class="goal-actions">${toggle ? `<button type="button" class="goal-action" data-goal-action="${toggle}">${toggle === "pause" ? "Pause" : "Resume"}</button>` : ""}<button type="button" class="goal-action" data-goal-action="cancel">Cancel</button></div>`
  } else goalDock.innerHTML = ""
  const todos = session.todos ?? []
  const completed = todos.filter((todo) => todo.status === "completed").length
  const currentTodo = currentTodoContent(todos)
  todoDock.hidden = todos.length === 0
  todoDock.classList.toggle("collapsed", !todoExpanded)
  todoDock.innerHTML = todos.length ? `<button type="button" class="todo-dock-header" aria-expanded="${todoExpanded}" title="${todoExpanded ? "Collapse todos" : "Expand todos"}"><span class="todo-dock-title">Todos</span><span class="todo-dock-current" title="${escapeHtml(currentTodo)}">${escapeHtml(currentTodo)}</span><small>${completed}/${todos.length}</small><span class="todo-dock-chevron" aria-hidden="true">›</span></button><ol class="todo-dock-list"${todoExpanded ? "" : " hidden"}>${todos.map((todo) => {
    const status = activityVisualState(todo.status, active)
    const kind = status === "completed" ? "completed" : ["in_progress", "in-progress", "active"].includes(status) ? "working" : ["cancelled", "canceled", "skipped"].includes(status) ? "cancelled" : "pending"
    const visualKind = status === "stopped" ? "stopped" : kind
    const label = visualKind === "completed" ? "Completed" : visualKind === "working" ? "In progress" : visualKind === "cancelled" ? "Cancelled" : visualKind === "stopped" ? "Stopped" : "Pending"
    const indicator = visualKind === "completed" ? SESSION_ICONS.completed : visualKind === "working" ? "" : visualKind === "cancelled" ? "−" : visualKind === "stopped" ? "·" : ""
    return `<li class="todo-dock-item todo-${visualKind}"><span class="todo-state" role="img" aria-label="${label}" title="${label}">${indicator}</span><span>${escapeHtml(todo.content)}</span>${todo.priority ? `<small>${escapeHtml(todo.priority)}</small>` : ""}</li>`
  }).join("")}</ol>` : ""
}

function serviceLabel(service: RuntimeService): string {
  return `${service.name || service.id}: ${service.error || service.status || "available"}${service.root ? ` · ${service.root}` : ""}`
}

function serviceList(services: RuntimeService[], kind: "lsp" | "formatter" | "mcp"): string {
  return `<ul class="workspace-service-list">${services.map((service) => {
    const name = escapeHtml(service.name || service.id)
    const presentation = runtimeServicePresentation(service, kind)
    const detail = presentation.detail ? `<code>${escapeHtml(presentation.detail)}</code>` : ""
    const error = service.error && service.error !== presentation.status ? `<small class="service-error">${escapeHtml(service.error)}</small>` : ""
    return `<li><span>${name}</span><small class="service-${presentation.tone}">${escapeHtml(presentation.status)}</small>${error}${detail}</li>`
  }).join("")}</ul>`
}

function workspaceDetail(kind: string, label: string, title: string, content: string, tooltip: string): string {
  return `<details class="workspace-detail workspace-${kind}"><summary title="${escapeHtml(tooltip)}">${escapeHtml(label)}</summary><div class="workspace-detail-popover"><strong>${escapeHtml(title)}</strong>${content}</div></details>`
}

function contextDetails(context: NonNullable<NonNullable<ChatSnapshot["session"]>["context"]>): string {
  const rows = [
    ["Model", context.model ?? "Unknown"],
    ["Total tokens", context.totalTokens.toLocaleString()],
    ["Input", context.inputTokens.toLocaleString()],
    ["Output", context.outputTokens.toLocaleString()],
    ["Reasoning", context.reasoningTokens.toLocaleString()],
    ["Cache read", context.cacheReadTokens.toLocaleString()],
    ["Cache write", context.cacheWriteTokens.toLocaleString()],
    ["Context limit", context.contextLimit?.toLocaleString() ?? "Unknown"],
    ["Input limit", context.inputLimit?.toLocaleString() ?? "Unknown"],
    ["Output limit", context.outputLimit?.toLocaleString() ?? "Unknown"],
    ["Session cost", `$${context.cost.toFixed(4)}`],
  ]
  return `<dl class="workspace-context-list">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label!)}</dt><dd>${escapeHtml(value!)}</dd></div>`).join("")}</dl>`
}

function renderWorkspaceStrip(session?: NonNullable<ChatSnapshot["session"]>): void {
  const runtime = snapshot.runtime
  const signature = JSON.stringify([runtime?.vcs, runtime?.lsp, runtime?.formatters, runtime?.mcp, session?.context])
  if (signature === workspaceSignature) return
  workspaceSignature = signature
  const lspHealthy = runtime?.lsp.filter((service) => runtimeServicePresentation(service, "lsp").healthy).length ?? 0
  const formatterHealthy = runtime?.formatters.filter((service) => runtimeServicePresentation(service, "formatter").healthy).length ?? 0
  const mcpHealthy = runtime?.mcp.filter((service) => runtimeServicePresentation(service, "mcp").healthy).length ?? 0
  const context = session?.context
  const left = runtime?.vcs?.branch ? `<span class="branch">${escapeHtml(runtime.vcs.branch)}</span>` : ""
  const lsp = runtime?.lsp ?? []
  const formatters = runtime?.formatters ?? []
  const mcp = runtime?.mcp ?? []
  const lspTooltip = lsp.map(serviceLabel).join("\n")
  const formatterTooltip = formatters.map((formatter) => `${formatter.name || formatter.id}: ${formatter.enabled ? "available" : "executable not found"}`).join("\n")
  const mcpTooltip = mcp.map(serviceLabel).join("\n")
  const right = [
    lsp.length ? workspaceDetail("lsp", `LSP ${lspHealthy}/${lsp.length}`, "Language servers", serviceList(lsp, "lsp"), lspTooltip) : `<span>LSP 0/0</span>`,
    formatters.length ? workspaceDetail("formatter", `Fmt ${formatterHealthy}/${formatters.length}`, "Formatters", serviceList(formatters, "formatter"), formatterTooltip) : `<span>Fmt 0/0</span>`,
    mcp.length ? workspaceDetail("mcp", `MCP ${mcpHealthy}/${mcp.length}`, "MCP servers", serviceList(mcp, "mcp"), mcpTooltip) : `<span>MCP 0/0</span>`,
    context ? workspaceDetail("context", `Context ${context.usagePercent === undefined ? "--" : `${Math.round(context.usagePercent)}%`}`, "Context usage", contextDetails(context), context.model ?? "Context usage") : `<span>Context --</span>`,
  ].filter(Boolean).join("")
  workspaceStrip.innerHTML = `<span class="workspace-left">${left}</span><div class="workspace-right">${right}</div>`
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
    label: attachment.mime === "application/pdf" ? attachmentReference("PDF", pdf++) : attachmentReference("Image", image++),
  }))
  const normalizedPastes = payload.pastedText.map((block, index) => ({ ...block, label: pastedTextReference(index + 1, block.lineCount) }))
  return { attachments: normalizedAttachments, pastedText: normalizedPastes }
}

function composerPayloadCanSync(payload: ComposerPayloadState): boolean {
  const attachmentCharacters = payload.attachments.reduce((total, attachment) =>
    total + attachment.id.length + attachment.label.length + attachment.name.length + attachment.mime.length + attachment.data.length, 0)
  const pastedCharacters = payload.pastedText.reduce((total, block) => total + block.id.length + block.label.length + block.text.length, 0)
  return payload.attachments.length <= INLINE_ATTACHMENT_COUNT_LIMIT && payload.attachments.length + payload.pastedText.length <= PROMPT_ATTACHMENT_COUNT_LIMIT &&
    attachmentCharacters <= 20_000_000 && pastedCharacters <= PROMPT_TEXT_CHARACTER_LIMIT
}

function reconcileComposerReferences(sessionID: string, previousLabels: string[], payload: ComposerPayloadState): void {
  if (sessionID !== snapshot.session?.id) return
  let value = draft.value
  for (const label of new Set(previousLabels)) value = value.replaceAll(label, "")
  value = value.replace(/[ \t]{2,}/g, " ").trim()
  const labels = [...payload.attachments.map((attachment) => attachment.label), ...payload.pastedText.map((block) => block.label)]
  draft.value = [value, labels.join(" ")].filter(Boolean).join(" ")
  postDraftNow(sessionID, draft.value)
  resizeDraft()
}

function renderAttachments(): void {
  const sessionID = snapshot.session?.id
  const inline = sessionAttachments(sessionID)
  const pasted = sessionPastedText(sessionID)
  const context = sessionContextAttachments(sessionID)
  attachmentDock.hidden = Boolean(pendingSessionID) || !sessionID || (!editorContext && !context.length && !inline.length && !pasted.length)
  attachmentDock.innerHTML = sessionID ? [
    editorContext && !editorContext.attached ? `<button type="button" class="attachment-chip implicit-context" data-add-editor-context title="Add ${escapeHtml(editorContext.name)}${editorContext.detail ? ` · ${escapeHtml(editorContext.detail)}` : ""}"><b>+</b><span>${escapeHtml(editorContext.name)}</span></button>` : "",
    ...context.map((attachment) => `<span class="attachment-chip context-chip context-${escapeHtml(attachment.kind)}" title="${escapeHtml(`${attachment.name}${attachment.detail ? ` · ${attachment.detail}` : ""}`)}">${attachment.kind === "folder" ? FOLDER_ICON : FILE_ICON}<button type="button" class="context-chip-copy" data-open-context="${escapeHtml(attachment.id)}" aria-label="Open ${escapeHtml(attachment.name)}"><strong>${escapeHtml(attachment.name)}</strong></button><button type="button" data-remove-context="${escapeHtml(attachment.id)}" title="Remove from context" aria-label="Remove ${escapeHtml(attachment.name)} from context">×</button></span>`),
    ...inline.map((attachment) => {
      const metadata = `${attachment.name} · ${attachment.mime} · ${formatBytes(attachment.size)}${attachment.width && attachment.height ? ` · ${attachment.width}×${attachment.height}` : ""}`
      const thumbnail = attachmentThumbnails.get(attachment.id)
      return `<span class="attachment-card" title="${escapeHtml(metadata)}">${attachment.mime.startsWith("image/") && thumbnail ? `<button type="button" class="attachment-thumbnail" data-preview-attachment="${escapeHtml(attachment.id)}" aria-label="Preview ${escapeHtml(attachment.label)}"><img src="${thumbnail}" alt=""></button>` : `<span class="attachment-file-icon" aria-hidden="true">${attachment.mime === "application/pdf" ? "PDF" : "IMG"}</span>`}<span class="attachment-card-copy"><strong>${escapeHtml(attachment.label)}</strong></span><button type="button" class="attachment-remove" data-remove-attachment="${escapeHtml(attachment.id)}" title="Remove attachment" aria-label="Remove ${escapeHtml(attachment.label)}">×</button></span>`
    }),
    ...pasted.map((block) => `<details class="attachment-card pasted-text-card"><summary><span class="attachment-file-icon" aria-hidden="true">TXT</span><span class="attachment-card-copy"><strong>${escapeHtml(block.label)}</strong><small>${block.text.length.toLocaleString()} characters</small></span></summary><div class="pasted-text-detail"><pre>${escapeHtml(block.text)}</pre><div class="permission-actions"><button type="button" data-copy-paste="${escapeHtml(block.id)}">Copy</button><button type="button" data-remove-paste="${escapeHtml(block.id)}">Remove</button></div></div></details>`),
  ].join("") : ""
}

function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`
  if (value < 1_000_000) return `${Math.round(value / 100) / 10} KB`
  return `${Math.round(value / 100_000) / 10} MB`
}

function openAttachmentPreview(title: string, source: string, alt: string, metadata: string, returnFocus: HTMLElement): void {
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
  return values.reduce((maximum, block) => Math.max(maximum, Number(/^\[Pasted text (\d+)/.exec(block.label)?.[1] ?? 0)), 0) + 1
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
  await Promise.all(values.filter((attachment) => attachment.mime.startsWith("image/") && !attachmentThumbnails.has(attachment.id)).map(async (attachment) => {
    const thumbnail = await imageThumbnail(`data:${attachment.mime};base64,${attachment.data}`)
    if (thumbnail) attachmentThumbnails.set(attachment.id, thumbnail)
  }))
}

async function inlineAttachment(file: File, label: string): Promise<InlineAttachment> {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type
  if (!["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mime)) throw new Error(`Unsupported attachment type: ${mime || file.name}`)
  const maxBytes = mime === "application/pdf" ? 10_000_000 : 3_900_000
  if (file.size > maxBytes) throw new Error(`${file.name} exceeds ${mime === "application/pdf" ? "10 MB" : "3.9 MB"}`)
  const result = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read attachment"))
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment"))
    reader.readAsDataURL(file)
  })
  const data = result.slice(result.indexOf(",") + 1)
  const dimensions = mime.startsWith("image/") ? await imageDimensions(result) : {}
  const id = crypto.randomUUID()
  return { id, label, name: file.name.slice(0, 255) || "attachment", mime: mime as InlineAttachment["mime"], data, size: file.size, ...dimensions }
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
    const remaining = Math.max(0, Math.min(INLINE_ATTACHMENT_COUNT_LIMIT - current.length, PROMPT_ATTACHMENT_COUNT_LIMIT - current.length - sessionPastedText(sessionID).length))
    if (!remaining) throw new Error(current.length >= INLINE_ATTACHMENT_COUNT_LIMIT
      ? `This prompt already has ${INLINE_ATTACHMENT_COUNT_LIMIT} image or PDF attachments`
      : `This prompt already has ${PROMPT_ATTACHMENT_COUNT_LIMIT} file and pasted-text attachments`)
    let image = attachmentOrdinal("Image", current)
    let pdf = attachmentOrdinal("PDF", current)
    const added = await Promise.all(files.slice(0, remaining).map((file) => inlineAttachment(file, file.type === "application/pdf" ? attachmentReference("PDF", pdf++) : attachmentReference("Image", image++))))
    const unique = added.filter((attachment) => !current.some((value) => value.mime === attachment.mime && value.data === attachment.data))
    if (!unique.length) {
      status.textContent = "Already attached"
      status.title = "This attachment is already in the prompt."
      return
    }
    const combined = [...current, ...unique]
    const characters = combined.reduce((total, attachment) => total + attachment.id.length + attachment.label.length + attachment.name.length + attachment.mime.length + attachment.data.length, 0)
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
  if (current.length + sessionAttachments(sessionID).length >= PROMPT_ATTACHMENT_COUNT_LIMIT || current.reduce((total, block) => total + block.text.length, 0) + normalized.length > PROMPT_TEXT_CHARACTER_LIMIT) {
    const message = `Pasted text exceeds the ${PROMPT_TEXT_CHARACTER_LIMIT.toLocaleString()}-character or ${PROMPT_ATTACHMENT_COUNT_LIMIT}-attachment prompt limit`
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
  if (!text) return
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
  sendOptions.hidden = true
  sendOptions.open = false
  sendGroup.classList.remove("split")
  if (creatingSession) {
    send.dataset.action = "idle"
    send.disabled = true
    send.classList.remove("stop-action", "queue-action")
    send.innerHTML = PRIMARY_ICONS.send
    send.title = "Starting new session…"
    send.setAttribute("aria-label", "Starting new session")
    return
  }
  if (pendingSessionID) {
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
    send.dataset.action = "idle"
    send.disabled = true
    send.classList.remove("stop-action", "queue-action")
    send.innerHTML = PRIMARY_ICONS.send
    send.title = "Loading session"
    send.setAttribute("aria-label", "Loading session")
    return
  }
  const hasDraft = Boolean(draft.value.trim() || sessionAttachments(session?.id).length || sessionPastedText(session?.id).length || sessionContextAttachments(session?.id).length)
  if (!session) {
    send.dataset.action = hasDraft ? "send" : "idle"
    send.disabled = !snapshot.connected || !hasDraft
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
  send.disabled = !session || !snapshot.connected || action === "idle" || action === "stopping"
  send.classList.toggle("stop-action", action === "stop" || action === "stopping")
  send.classList.toggle("queue-action", action === "queue")
  sendOptions.hidden = action !== "queue"
  sendGroup.classList.toggle("split", action === "queue")
  send.innerHTML = PRIMARY_ICONS[action === "idle" ? "send" : action as keyof typeof PRIMARY_ICONS]
  const label = action === "stopping" ? "Stopping response…" : action === "stop" ? "Stop response (Esc)" : action === "queue" ? "Add to Queue (Enter)" : "Send message"
  send.title = label
  send.setAttribute("aria-label", label)
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
  commandSuggestions.innerHTML = commands.map((command, index) => `<button id="command-option-${index}" type="button" role="option" aria-selected="${index === selectedCommandIndex}" data-command-name="${escapeHtml(command.name)}"><strong>/${escapeHtml(command.name)}</strong><span>${escapeHtml(command.description || command.source || "OpenCode command")}</span></button>`).join("")
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
    .filter((item) => /^[A-Za-z0-9._-]+$/.test(item.name) && (!query || `${item.name}\n${item.description ?? ""}`.toLowerCase().includes(query)))
    .map((item) => ({ kind: "agent", value: item.name, label: `@${item.name}`, detail: item.description || "OpenCode agent" }))
  const resources: MentionSuggestion[] = (snapshot.resources ?? [])
    .filter((item) => !query || `${item.name}\n${item.client}\n${item.description ?? ""}`.toLowerCase().includes(query))
    .map((item) => ({ kind: "resource", value: item.uri, label: item.name, detail: `${item.client} · MCP resource` }))
  const files: MentionSuggestion[] = suggestedFiles.map((file) => ({ kind: "file", value: file, label: fileName(file), detail: file }))
  return [...agents, ...resources, ...files].slice(0, 24)
}

function renderFileSuggestions(): void {
  const suggestions = currentMentionSuggestions()
  selectedFileIndex = Math.min(selectedFileIndex, Math.max(0, suggestions.length - 1))
  fileSuggestionList.hidden = suggestions.length === 0
  fileSuggestionList.innerHTML = suggestions.map((item, index) => `<button id="mention-option-${index}" type="button" role="option" aria-selected="${index === selectedFileIndex}" data-mention-index="${index}"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></button>`).join("")
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
  const replacement = suggestion.kind === "agent" ? `@${suggestion.value} ` : suggestion.kind === "file" ? `@<${suggestion.value}> ` : ""
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
  return `<span class="active-throbber" aria-label="OpenCode is working">${Array.from({ length: 8 }, () => `<i aria-hidden="true"></i>`).join("")}</span>`
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
    fillSelect(agent, "Default agent", snapshot.agents.map((item) => ({ value: item.name, label: item.name })), session?.agent)
    fillSelect(model, "Default model", snapshot.models.map((item) => ({ value: `${item.providerID}/${item.id}`, label: `${item.name} · ${item.providerID}` })), session?.model)
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

function render(): void {
  const session = snapshot.session
  const active = session?.status.type === "busy" || session?.status.type === "retry"
  const loadPhase = sessionLoadPhase(session)
  const loading = loadPhase === "initial"
  const refreshing = loadPhase === "refreshing"
  const connectionUnavailable = syncConnectionNotice()
  const connecting = snapshot.connectionState === "connecting"
  sessionTitle.textContent = session?.title || "No session"
  backParent.hidden = !session?.parentID && document.body.dataset.mode !== "editor"
  const backLabel = session?.parentID ? "Back to parent session" : "Go back"
  backParent.title = backLabel
  backParent.setAttribute("aria-label", backLabel)
  const sessionOption = session ? snapshot.sessions.find((value) => value.id === session.id) ?? { id: session.id, title: session.title, status: session.status, unread: 0 } : undefined
  sessionState.innerHTML = connecting
    ? `<span class="header-active-indicator" title="Connecting to OpenCode" aria-label="Connecting to OpenCode"></span>`
    : sessionOption && (sessionOption.status.type === "busy" || sessionOption.status.type === "retry" || refreshing)
    ? `<span class="header-active-indicator" title="${refreshing && !active ? "Refreshing session" : "Working"}" aria-label="${refreshing && !active ? "Refreshing session" : "Working"}"></span>`
    : sessionOption ? escapeHtml(statusLabel(sessionOption)) : ""
  sessionCurrent.disabled = snapshot.sessions.length === 0
  sessionMenuToggle.disabled = !session
  createHeader.disabled = !snapshot.connected
  createEmpty.disabled = !snapshot.connected
  const emptyConversation = Boolean(session && session.messages.length === 0)
  empty.hidden = loading || Boolean(session && !emptyConversation)
  sessionLoading.hidden = !loading
  messages.hidden = loading || !session || emptyConversation
  createEmpty.hidden = Boolean(session)
  draft.disabled = loading || !snapshot.connected || creatingSession
  composer.setAttribute("aria-busy", String(Boolean(active)))
  messages.setAttribute("aria-busy", String(Boolean(active)))
  updatePrimaryAction()
  const statusError = session?.status.type === "error" ? session.status.message || "Session failed" : undefined
  status.classList.toggle("error", Boolean(statusError))
  status.innerHTML = session ? loading ? "Loading session…" : stoppingSessionID === session.id ? "Stopping…" : active ? activeThrobberHtml() : session.loadState === "error" ? "Transcript unavailable" : statusError ? `Error: ${escapeHtml(statusError)}` : "" : connecting ? "Connecting…" : connectionUnavailable ? snapshot.connectionState === "reconnecting" ? "Reconnecting…" : "Offline" : ""
  status.title = session?.status.type === "error" ? session.status.message || "Session error" : ""
  renderCatalogs(session)
  const selectedModel = snapshot.models.find((item) => `${item.providerID}/${item.id}` === session?.model)
  const variants = selectedModel?.variants ?? []
  fillSelect(variant, "Default reasoning", variants.map((value) => ({ value, label: variantLabel(value) })), variants.includes(session?.variant ?? "") ? session?.variant : undefined)
  variant.disabled = !session || variants.length === 0
  agent.disabled = !session
  model.disabled = !session
  modelToggle.disabled = !session
  renderModelPicker()
  const auto = snapshot.autoApproval === true
  approvalToggle.setAttribute("aria-checked", String(auto))
  approvalToggle.classList.toggle("auto", auto)
  approvalMode.textContent = auto ? "Auto" : "Ask"
  approvalToggle.title = auto ? "Warning: permission requests are automatically allowed once. Activate to require approval." : "Ask before OpenCode performs permission-gated actions. Activate to auto-allow once."
  if (!session) {
    clearTranscript()
    syncDraft()
    queueSignature = ""
    permissionSignature = ""
    questionSignature = ""
    queueDock.replaceChildren()
    permissionDock.replaceChildren()
    questionDock.replaceChildren()
    attachmentDock.replaceChildren()
    queueDock.hidden = permissionDock.hidden = questionDock.hidden = goalDock.hidden = todoDock.hidden = true
  } else {
    renderTranscript(session, Boolean(active))
    syncDraft(session)
    renderAttachments()
    renderQueue(session)
    renderPermissions(session)
    renderQuestions(session)
    renderSummaries(session, Boolean(active))
  }
  renderSessionLists()
  renderWorkspaceStrip(session)
  renderCommandSuggestions()
  resizeDraft()
  updatePrimaryAction()
  syncAnimationTimers(Boolean(active))
}

function post(message: WebviewToHostMessage): void {
  vscode.postMessage(message)
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

function showRail(): void {
  if (!document.body.classList.contains("rail-open")) {
    railReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  }
  document.body.classList.add("rail-open")
  railToggle.setAttribute("aria-expanded", "true")
}

function closeRail(): void {
  document.body.classList.remove("rail-open")
  railToggle.setAttribute("aria-expanded", "false")
  const target = railReturnFocus
  railReturnFocus = undefined
  if (target?.isConnected) target.focus()
}

function closeSessionMenu(): void {
  sessionMenu.hidden = true
  sessionMenuToggle.setAttribute("aria-expanded", "false")
  sessionMenuSearch.value = ""
  sessionMenu.querySelectorAll<HTMLElement>("button, hr").forEach((item) => item.hidden = false)
}

function requestSessionSelection(sessionID: string): void {
  if (!sessionID || sessionID === snapshot.session?.id) return
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
  for (const dock of [queueDock, permissionDock, questionDock, todoDock, goalDock]) {
    dock.hidden = true
    dock.replaceChildren()
  }
  queueSignature = permissionSignature = questionSignature = summarySignature = ""
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
    selectedCommandIndex = (selectedCommandIndex + (event.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length
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
  if (shouldSubmitComposerKey(event)) {
    event.preventDefault()
    const active = snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry"
    if (active && event.altKey) submitMessage("steer")
    else send.click()
  }
})
commandSuggestions.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-command-name]") : undefined
  if (!button) return
  const commands = matchingCommands()
  const index = commands.findIndex((command) => command.name === button.dataset.commandName)
  if (index >= 0) chooseCommand(index)
})
fileSuggestionList.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-mention-index]") : undefined
  const index = Number(button?.dataset.mentionIndex)
  if (index >= 0) chooseFile(index)
})
modelToggle.addEventListener("click", () => modelPicker.hidden ? openModelPicker() : closeModelPicker())
modelSearch.addEventListener("input", renderModelPicker)
modelPicker.addEventListener("click", (event) => {
  const modelButton = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-model-value]") : undefined
  const variantButton = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-variant-value]") : undefined
  const sessionID = snapshot.session?.id
  if (!sessionID) return
  if (modelButton?.dataset.modelValue) {
    model.value = modelButton.dataset.modelValue
    variant.value = ""
    const selected = selectedModelOption()
    const variants = selected?.variants ?? []
    fillSelect(variant, "Default reasoning", variants.map((value) => ({ value, label: variantLabel(value) })))
    post({ type: "setPreference", sessionID, agent: agent.value, model: model.value })
    renderModelPicker()
    if (!variants.length) closeModelPicker()
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
  const selected = snapshot.models.find((item) => `${item.providerID}/${item.id}` === (model.value || snapshot.session?.model))
  const needsImages = files.some((file) => file.mime.startsWith("image/"))
  const needsPdf = files.some((file) => file.mime === "application/pdf")
  if ((needsImages && selected?.capabilities?.input?.image === false) || (needsPdf && selected?.capabilities?.input?.pdf === false)) {
    const detail = `${selected?.name ?? "The selected model"} does not support ${needsImages ? "image" : "PDF"} input. Choose a compatible model or remove the attachment.`
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
      sentAttachmentPreviews.set(promptID, { sessionID, attachments: files.map((file) => ({
        label: file.label,
        name: file.name,
        mime: file.mime,
        thumbnail: file.mime.startsWith("image/") ? attachmentThumbnails.get(file.id) : undefined,
      })) })
      while (sentAttachmentPreviews.size > 10) sentAttachmentPreviews.delete(sentAttachmentPreviews.keys().next().value!)
    }
  }
  const active = snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry"
  const effectiveDelivery = active ? delivery ?? "queue" : undefined
  post({ type: "send", sessionID, promptID, composerRevision: composerPayloadRevisions.get(sessionID) ?? 0, delivery: effectiveDelivery, text, agent: agent.value || undefined, model: model.value || undefined, variant: variant.value || undefined, attachments: files.length ? files : undefined, pastedText: pasted.length ? pasted : undefined, contextIDs: contexts.length ? contexts.map((attachment) => attachment.id) : undefined })
  send.dataset.action = "sent"
  send.innerHTML = PRIMARY_ICONS.sent
  send.disabled = true
  send.title = effectiveDelivery === "queue" ? "Queued" : effectiveDelivery === "steer" ? "Steering" : effectiveDelivery === "replace" ? "Stopping and sending" : "Sent"
  sendOptions.open = false
  setTimeout(updatePrimaryAction, 350)
}
send.addEventListener("click", () => submitMessage())
sendOptions.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-send-delivery]") : undefined
  const delivery = button?.dataset.sendDelivery
  if (delivery === "queue" || delivery === "steer" || delivery === "replace") submitMessage(delivery)
})
attachFiles.addEventListener("click", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "pickFiles", sessionID })
})
attachmentDock.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button, [data-remove-context]") : undefined
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
    openAttachmentPreview(`${attachment.label} · ${attachment.name}`, `data:${attachment.mime};base64,${attachment.data}`, `Preview of ${attachment.name}`, `${attachment.mime} · ${formatBytes(attachment.size)}${attachment.width && attachment.height ? ` · ${attachment.width}×${attachment.height}` : ""}`, target)
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
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/") || file.type === "application/pdf")
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
  if (noticeKind === "offline") post({ type: snapshot.connectionError?.startsWith("Open a trusted workspace folder") ? "openFolder" : "reloadWindow" })
  else post({ type: "refresh" })
})
noticeLogs.addEventListener("click", () => post({ type: "openLogs" }))
noticeCopy.addEventListener("click", () => {
  if (noticeDetail) post({ type: "copyText", text: noticeDetail })
})
noticeDismiss.addEventListener("click", () => clearNotice())
composer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer) return
  const types = Array.from(event.dataTransfer.types, (type) => type.toLowerCase())
  if (types.some((type) => ["files", "text/uri-list", "application/vnd.code.uri-list", "resourceurls", "codefiles"].includes(type))) {
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
  const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/") || file.type === "application/pdf")
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
      if (Array.isArray(values)) uris.push(...values.filter((value): value is string => typeof value === "string").map((value) => {
        return fileUriFromPath(value)
      }))
    } catch { /* Ignore malformed private VS Code drag data. */ }
  }
  const uniqueUris = [...new Set(uris)]
  if (uniqueUris.length) post({ type: "resolveDroppedUris", sessionID, uris: uniqueUris.slice(0, 10) })
})
createHeader.addEventListener("click", () => {
  flushPendingDraft()
  post({ type: "createSession" })
})
createEmpty.addEventListener("click", () => post({ type: "createSession" }))
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
  if (open) sessionMenuSearch.focus()
})
sessionMenuSearch.addEventListener("input", () => {
  const query = sessionMenuSearch.value.trim().toLowerCase()
  sessionMenu.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.hidden = Boolean(query) && !button.textContent?.toLowerCase().includes(query)
  })
  sessionMenu.querySelectorAll<HTMLHRElement>("hr").forEach((separator) => separator.hidden = Boolean(query))
})
sessionMenu.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-session-action]") : undefined
  const sessionID = snapshot.session?.id
  const action = button?.dataset.sessionAction
  if (!button || !sessionID || !action || !["rename", "delete", "fork", "undo", "redo", "compact", "share", "unshare", "export", "copyLast", "copyTranscript"].includes(action)) return
  post({ type: "sessionAction", sessionID, action: action as Extract<WebviewToHostMessage, { type: "sessionAction" }>["action"] })
  closeSessionMenu()
})
sessionMenu.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-menu-command]") : undefined
  const command = button?.dataset.menuCommand
  const sessionID = snapshot.session?.id
  if (!button || !command) return
  closeSessionMenu()
  if (command === "create") {
    flushPendingDraft()
    post({ type: "createSession" })
  }
  else if (command === "refresh") post({ type: "refresh" })
  else if (command === "sessions") openHistory()
  else if (command === "agent") {
    agent.focus()
    try { (agent as HTMLSelectElement & { showPicker?: () => void }).showPicker?.() } catch { /* The focused select remains keyboard-accessible. */ }
  } else if (command === "model") openModelPicker()
  else if (command === "variant" && (selectedModelOption()?.variants?.length ?? 0) > 0) openModelPicker(true)
  else if (command === "surface") post({ type: document.body.dataset.mode === "editor" ? "openInSidebar" : "openInEditor" })
  else if (command === "skills" && sessionID) {
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
  }
  else if (command === "expand-tools") messages.querySelectorAll<HTMLDetailsElement>("details.activity").forEach((detail) => detail.open = true)
  else if (command === "collapse-tools") messages.querySelectorAll<HTMLDetailsElement>("details.activity").forEach((detail) => detail.open = false)
  else if (command === "timestamps") document.body.classList.toggle("show-timestamps")
  else if (command === "scrollbar") document.body.classList.toggle("hide-scrollbars")
})
sessionCurrent.addEventListener("click", openHistory)
historySearch.addEventListener("input", renderSessionLists)
railSessionSearch.addEventListener("input", renderSessionLists)
for (const [input, list] of [[historySearch, historyList], [railSessionSearch, railSessionList]] as const) {
  input.addEventListener("keydown", (event) => {
    const first = list.querySelector<HTMLButtonElement>("[data-session-id]")
    if (event.key === "ArrowDown" && first) {
      event.preventDefault()
      first.focus()
    } else if (event.key === "Enter" && first) {
      event.preventDefault()
      first.click()
    }
  })
  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const rows = Array.from(list.querySelectorAll<HTMLButtonElement>("[data-session-id]"))
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus()
  })
}
document.querySelectorAll<HTMLElement>("[data-close-overlay]").forEach((button) => button.addEventListener("click", closeHistory))
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
  if (sessionID) post({ type: "setPreference", sessionID, agent: agent.value, model: model.value, variant: variant.value })
})
approvalToggle.addEventListener("click", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "setAutoApproval", sessionID, enabled: snapshot.autoApproval !== true })
})
queueDock.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-queue-action]") : undefined
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
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-permission]") : undefined
  const card = button?.closest<HTMLElement>("[data-request-id]")
  const sessionID = card?.dataset.requestSession
  const protocol = card?.dataset.requestProtocol
  const response = button?.dataset.permission
  if (button && sessionID && card?.dataset.requestId && (protocol === "legacy" || protocol === "current" || protocol === "v2") && (response === "once" || response === "exact" || response === "scope" || response === "reject")) {
    const feedback = response === "reject" ? card.querySelector<HTMLInputElement>("[data-permission-feedback]")?.value.trim() || undefined : undefined
    const scope = response === "scope" ? button.dataset.permissionScope : undefined
    if (response === "scope" && !scope) return
    post({ type: "respondPermission", sessionID, requestID: card.dataset.requestId, protocol, response, scope, feedback })
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
    const checked = Array.from(fieldset?.querySelectorAll<HTMLInputElement>("input[type='radio']:checked, input[type='checkbox']:checked") ?? [], (input) => input.value)
    return questionAnswerValues(checked, custom, question.multiple === true)
  })
  if (answers.some((answer) => answer.length === 0)) {
    status.textContent = "Answer every question"
    return
  }
  post({ type: "respondQuestion", sessionID, requestID, answers })
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) control.disabled = true
})
questionDock.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-question-action='reject']") : undefined
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
  sessionContextMenu.hidden = false
  const bounds = row.getBoundingClientRect()
  const left = x ?? bounds.left + 16
  const top = y ?? bounds.top + Math.min(bounds.height, 24)
  const menuBounds = sessionContextMenu.getBoundingClientRect()
  sessionContextMenu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - menuBounds.width - 4))}px`
  sessionContextMenu.style.top = `${Math.max(4, Math.min(top, window.innerHeight - menuBounds.height - 4))}px`
  sessionContextMenu.querySelector<HTMLButtonElement>("button")?.focus()
}

for (const container of [historyList, railSessions]) container.addEventListener("click", (event) => {
  const more = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-session-more]") : undefined
  if (more) {
    sessionRenderLimit += 200
    sessionListSignature = ""
    renderSessionLists()
    return
  }
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-session-id]") : undefined
  if (!button?.dataset.sessionId) return
  closeSessionContextMenu()
  flushPendingDraft()
  requestSessionSelection(button.dataset.sessionId)
  if (!historyOverlay.hidden) closeHistory()
})
for (const container of [historyList, railSessions]) {
  container.addEventListener("contextmenu", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-session-id]") : undefined
    if (!row) return
    event.preventDefault()
    openSessionContextMenu(row, event.clientX, event.clientY)
  })
  container.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
    const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-session-id]") : undefined
    if (!row) return
    event.preventDefault()
    openSessionContextMenu(row)
  })
}
sessionContextMenu.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-context-action]") : undefined
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
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (Math.max(index, 0) + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
  buttons[next]?.focus()
})
goalDock.addEventListener("click", (event) => {
  const sessionID = snapshot.session?.id
  if (!sessionID) return
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : undefined
  const action = target?.dataset.goalAction
  if (["edit", "pause", "resume", "cancel"].includes(action ?? "")) post({ type: "goalAction", sessionID, action: action as "edit" | "pause" | "resume" | "cancel" })
})
todoDock.addEventListener("click", (event) => {
  const header = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".todo-dock-header") : undefined
  if (!header) return
  todoExpanded = !todoExpanded
  todoDock.classList.toggle("collapsed", !todoExpanded)
  header.setAttribute("aria-expanded", String(todoExpanded))
  header.title = todoExpanded ? "Collapse todos" : "Expand todos"
  const list = todoDock.querySelector<HTMLOListElement>(".todo-dock-list")
  if (list) list.hidden = !todoExpanded
  vscode.setState({ ...(vscode.getState() ?? {}), todoExpanded })
})
workspaceStrip.addEventListener("toggle", (event) => {
  const opened = event.target instanceof HTMLDetailsElement ? event.target : undefined
  if (!opened?.open || !opened.classList.contains("workspace-detail")) return
  for (const detail of workspaceStrip.querySelectorAll<HTMLDetailsElement>(".workspace-detail[open]")) {
    if (detail !== opened) detail.open = false
  }
}, true)
railToggle.addEventListener("click", () => {
  if (document.body.classList.contains("rail-open")) closeRail()
  else showRail()
})
railClose.addEventListener("click", closeRail)
document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  const prompt = button.dataset.prompt || ""
  if (!snapshot.session) post({ type: "createSession", draft: prompt })
  else {
    draft.value = prompt
    resizeDraft()
    postDraftNow(snapshot.session.id, prompt)
    draft.focus()
  }
}))
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-copy-block]") : undefined
  if (!button) return
  event.preventDefault()
  event.stopPropagation()
  const text = button.closest<HTMLElement>(".code-block")?.querySelector("pre")?.textContent
  if (text === undefined) return
  post({ type: "copyText", text })
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
  const transcriptPreview = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-transcript-preview]") : undefined
  if (transcriptPreview?.dataset.transcriptPreview) {
    const messageID = transcriptPreview.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
    const preview = messageID ? sentAttachmentPreviews.get(messageID)?.attachments.find((item) => item.label === transcriptPreview.dataset.transcriptPreview) : undefined
    if (!preview?.thumbnail) return
    openAttachmentPreview(`${preview.label} · ${preview.name}`, preview.thumbnail, `Preview of ${preview.name}`, preview.mime, transcriptPreview)
    return
  }
  const messageAction = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-message-action]") : undefined
  if (messageAction) {
    const article = messageAction.closest<HTMLElement>("[data-message-id]")
    const message = snapshot.session?.messages.find((value) => value.info.id === article?.dataset.messageId)
    const sessionID = snapshot.session?.id
    if (!message || !sessionID) return
    const text = message.parts.filter((part) => !part.synthetic && part.type === "text" && part.text).map((part) => part.text).join("\n")
    if (messageAction.dataset.messageAction === "copy") post({ type: "copyText", text })
    else if (messageAction.dataset.messageAction === "edit") {
      draft.value = text
      postDraftNow(sessionID, text)
      resizeDraft()
      draft.focus()
      if (message.parts.some((part) => part.type === "file")) {
        status.textContent = "Text restored"
        status.title = "Historical attachments cannot be restored automatically. Add them again before sending."
      }
    } else if (messageAction.dataset.messageAction === "fork") post({ type: "sessionAction", sessionID, action: "fork", messageID: message.info.id })
    else if (messageAction.dataset.messageAction === "retry") post({ type: "sessionAction", sessionID, action: "retry", messageID: message.info.id })
    return
  }
  const activityToggle = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-turn-activity]") : undefined
  if (activityToggle) {
    if (activityToggle.dataset.working === "true") return
    const turn = activityToggle.closest<HTMLElement>(".turn")
    if (!turn) return
    turn.classList.toggle("activity-collapsed")
    const expanded = !turn.classList.contains("activity-collapsed")
    if (activityToggle.dataset.activityKey) activityCollapsePreferences.set(activityToggle.dataset.activityKey, !expanded)
    if (expanded) {
      turn.classList.add("activity-expanding")
      window.setTimeout(() => turn.classList.remove("activity-expanding"), 220)
    }
    activityToggle.setAttribute("aria-expanded", String(expanded))
    activityToggle.title = expanded ? "Hide work activity" : "Show work activity"
    return
  }
  const delegated = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-delegation-session]") : undefined
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
    post({ type: "openFile", sessionID, file: file.dataset.file, line, column, endLine, endColumn })
    return
  }
})
jumpLatest.addEventListener("click", () => {
  messages.scrollTop = messages.scrollHeight
  unseenMessages = 0
  updateJumpLatest()
})
messages.addEventListener("scroll", () => {
  if (transcriptNearBottom()) unseenMessages = 0
  updateJumpLatest()
}, { passive: true })
document.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !attachmentPreview.hidden) {
    const focusable = Array.from(attachmentPreview.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])"))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
    return
  }
  if (event.key === "Tab" && !historyOverlay.hidden) {
    const focusable = Array.from(historyOverlay.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])"))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
    return
  }
  if (event.key === "Escape") {
    if (!attachmentPreview.hidden) {
      closeAttachmentPreview()
    }
    else if (!sessionContextMenu.hidden) closeSessionContextMenu(true)
    else if (!historyOverlay.hidden) closeHistory()
    else if (!modelPicker.hidden) {
      closeModelPicker()
      modelToggle.focus()
    }
    else if (!sessionMenu.hidden) {
      closeSessionMenu()
      sessionMenuToggle.focus()
    }
    else if (sendOptions.open) {
      sendOptions.open = false
      send.focus()
    }
    else if (permissionDock.querySelector<HTMLDetailsElement>(".permission-allow-menu[open]")) {
      permissionDock.querySelector<HTMLDetailsElement>(".permission-allow-menu[open]")!.open = false
    }
    else if (workspaceStrip.querySelector<HTMLDetailsElement>(".workspace-detail[open]")) {
      const detail = workspaceStrip.querySelector<HTMLDetailsElement>(".workspace-detail[open]")!
      detail.open = false
      detail.querySelector<HTMLElement>("summary")?.focus()
    }
    else if (document.body.dataset.mode === "sidebar" && document.body.classList.contains("rail-open")) closeRail()
    else if (snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry") {
      event.preventDefault()
      requestStop()
    }
    else if (snapshot.session?.parentID) backParent.click()
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
  if (!sessionContextMenu.hidden && event.target instanceof Node && !sessionContextMenu.contains(event.target)) closeSessionContextMenu()
  if (!sessionMenu.hidden && event.target instanceof Node && !sessionMenu.contains(event.target) && !sessionMenuToggle.contains(event.target)) closeSessionMenu()
  if (!modelPicker.hidden && event.target instanceof Node && !modelPicker.contains(event.target) && !modelToggle.contains(event.target)) closeModelPicker()
  if (event.target instanceof Node && !workspaceStrip.contains(event.target)) {
    for (const detail of workspaceStrip.querySelectorAll<HTMLDetailsElement>(".workspace-detail[open]")) detail.open = false
  }
})
window.addEventListener("message", (event) => {
  const message = parseHostMessage(event.data)
  if (!message) return
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
    status.textContent = message.message
    status.title = message.message
    showNotice("error", "OpenCode request failed", message.message)
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
      const previousLabels = [...pending.base.attachments, ...pending.attachments, ...remote.attachments].map((attachment) => attachment.label)
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
        status.title = syncable ? "Attachments and pasted text from both chat views were preserved." : "Remove attachments or pasted text before sending."
        if (!syncable) showNotice("error", "Merged composer exceeds limits", "Changes from both chat views were preserved locally. Remove attachments or pasted text before sending.")
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
    if (message.attachments.length) void cacheAttachmentThumbnails(message.attachments).then(() => {
      if (message.sessionID === snapshot.session?.id) renderAttachments()
    })
    if (message.pastedText.length) pastedText.set(message.sessionID, message.pastedText)
    else pastedText.delete(message.sessionID)
    if (message.sessionID === snapshot.session?.id) {
      if (message.conflict) showNotice("error", "Composer changed in another view", "The synchronized composer was updated before this view had a pending local change.")
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
    for (const [messageID, previews] of sentAttachmentPreviews) if (previews.sessionID === message.sessionID) sentAttachmentPreviews.delete(messageID)
    for (const attachment of attachments.get(message.sessionID) ?? []) attachmentThumbnails.delete(attachment.id)
    attachments.delete(message.sessionID)
    pastedText.delete(message.sessionID)
    contextAttachments.delete(message.sessionID)
    composerPayloadRevisions.delete(message.sessionID)
    acknowledgedComposerPayloads.delete(message.sessionID)
    pendingComposerPayloads.delete(message.sessionID)
    stashedDrafts.delete(message.sessionID)
    if (pendingDraft?.sessionID === message.sessionID) cancelPendingDraft()
    return
  }
  if (message.type === "messagePatches") {
    if (pendingSessionID) return
    const session = snapshot.session
    if (!session) return
    let active = session.status.type === "busy" || session.status.type === "retry"
    const wasNearBottom = transcriptNearBottom()
    let changed = false
    let addedMessages = 0
    for (const patch of message.patches) {
      if (patch.sessionID !== session.id) continue
      const currentRevision = session.messageRevisions[patch.messageID] ?? -1
      if (patch.revision <= currentRevision) continue
      active = patch.active
      const index = session.messages.findIndex((entry) => entry.info.id === patch.messageID)
      if (patch.message) {
        if (patch.message.info.role === "assistant") {
          const text = patch.message.parts.filter((part) => !part.synthetic && part.type === "text" && part.text).map((part) => part.text).join("\n")
          const previous = announcedAssistantText.get(patch.messageID) ?? ""
          if (text.length > previous.length && text.startsWith(previous)) announce(text.slice(previous.length))
          announcedAssistantText.set(patch.messageID, text)
        }
        if (index < 0) {
          const previous = patch.afterMessageID ? session.messages.findIndex((entry) => entry.info.id === patch.afterMessageID) : -1
          if (previous >= 0) session.messages.splice(previous + 1, 0, patch.message)
          else if (patch.append) session.messages.push(patch.message)
          else continue
          addedMessages += 1
        } else session.messages[index] = patch.message
        session.messageRevisions[patch.messageID] = patch.revision
      } else if (index >= 0) {
        session.messages.splice(index, 1)
        delete session.messageRevisions[patch.messageID]
      }
      changed = true
    }
    if (changed) {
      if (!wasNearBottom) unseenMessages += addedMessages
      renderTranscript(session, active)
      updatePrimaryAction()
      syncAnimationTimers(active)
    }
    return
  }
  if (pendingSessionID && message.snapshot.session?.id !== pendingSessionID) return
  if (pendingSessionID === message.snapshot.session?.id) pendingSessionID = undefined
  const previousSession = snapshot.session
  const nextSession = message.snapshot.session
  if (creatingSession && nextSession) creatingSession = false
  if (previousSession && nextSession && previousSession.id === nextSession.id && (previousSession.status.type === "busy" || previousSession.status.type === "retry") && nextSession.status.type === "idle") {
    announce("OpenCode response complete")
  }
  snapshot = message.snapshot
  render()
})

if (document.body.dataset.mode === "editor") showRail()
document.addEventListener("visibilitychange", () => {
  const active = snapshot.session?.status.type === "busy" || snapshot.session?.status.type === "retry"
  syncAnimationTimers(Boolean(active))
})
window.addEventListener("beforeunload", flushPendingDraft)
resizeDraft()
post({ type: "ready" })
