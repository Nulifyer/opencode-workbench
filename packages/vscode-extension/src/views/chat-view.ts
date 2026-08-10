import { createHash, randomBytes, randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import * as vscode from "vscode"
import type { AttentionItem, ContextAttachmentSummary, ContextReceiptItem, EditorContextSummary, HostToWebviewMessage, InlineAttachment, PastedTextBlock, RuntimeDescriptor, WebviewToHostMessage, WorkbenchCapability, WorkbenchHealthSummary, WorkbenchInspectorTab, WorkbenchTraceSummary } from "@opencode-workbench/shared"
import { parseHostMessage, parseWebviewMessage, PROMPT_ATTACHMENT_CHARACTER_LIMIT, PROMPT_ATTACHMENT_COUNT_LIMIT, taskArtifactSummary } from "@opencode-workbench/shared"
import type { PromptFilePart } from "../opencode-client.js"
import type { ControllerUpdate, SessionController } from "../session-controller.js"
import { prepareFzf, rankPreparedFzf, workspaceSearchPaths, type PreparedFzfIndex } from "../fuzzy.js"
import { LatestUpdatePump } from "../latest-update-pump.js"
import type { ContextReceiptService } from "../application/context-service.js"
import type { MultiRunOrchestrator, RunGroupService } from "../application/run-group-service.js"
import type { WalkthroughService } from "../application/walkthrough-service.js"
import type { WorktreeService } from "../application/worktree-service.js"
import { WebviewProtocolHost, type ProtocolObservation } from "../protocol/webview-protocol-host.js"
import { dataUrlPayload, receiptHash } from "../application/context-receipt-builders.js"
import { projectChatSnapshotForWebview } from "../application/webview-snapshot-projector.js"
import type { EvidenceService } from "../application/evidence-service.js"
import { RecoveryPreviewGuard, type RecoveryPreviewInput, type RecoveryPreviewService } from "../application/recovery-preview-service.js"
import { exactRunComparisonMarkdown } from "../application/run-comparison-service.js"
import type { SessionPresentationService } from "../application/session-presentation-service.js"
import type { TaskArtifactService } from "../application/task-artifact-service.js"
import type { BrowserEditorSelection } from "../application/browser-context-service.js"
import { inspectContextReceiptSource } from "../application/context-receipt-source-service.js"

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dataText(url: string, mime: string): string | undefined {
  if (!mime.startsWith("text/") && !["application/json", "application/xml", "application/javascript"].includes(mime)) return undefined
  const match = /^data:[^,]*?(;base64)?,([\s\S]*)$/.exec(url)
  if (!match) return undefined
  const content = match[1] ? Buffer.from(match[2]!, "base64").toString("utf8") : decodeURIComponent(match[2]!)
  if (content.length > 2_000_000) throw new Error("This context preview exceeds 2,000,000 characters")
  return content
}

function usesCustomEditor(uri: vscode.Uri): boolean {
  return /\.(?:avif|bmp|gif|ico|jpe?g|pdf|png|svg|webp)$/i.test(uri.path)
}

function icon(path: string): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`
}

const ICONS = {
  add: icon("M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25V2Z"),
  editor: icon("M3 2h8.5L14 4.5V14H3V2Zm1.5 1.5v9h8v-7H11V3.5H4.5ZM6 7h5v1.25H6V7Zm0 2.5h5v1.25H6V9.5Z"),
  attach: icon("M6.2 12.8a3.2 3.2 0 0 1 0-4.5l4.1-4.1a2.1 2.1 0 1 1 3 3l-4.5 4.5a1.1 1.1 0 0 1-1.6-1.6l4.1-4.1.9.9-4.1 4.1.7.7-.7-.7 4.5-4.5a.85.85 0 0 0-1.2-1.2L7.1 9.2a1.95 1.95 0 1 0 2.8 2.8l3.4-3.4.9.9-3.4 3.4a3.2 3.2 0 0 1-4.6-.1Z"),
  close: icon("M4.2 3.2 8 7l3.8-3.8 1 1L9 8l3.8 3.8-1 1L8 9l-3.8 3.8-1-1L7 8 3.2 4.2l1-1Z"),
  chevron: icon("m4.5 6 3.5 3.5L11.5 6l1 1L8 11.5 3.5 7l1-1Z"),
  workbench: icon("M2 2.5h5.25v5.25H2V2.5Zm1.5 1.5v2.25h2.25V4H3.5Zm5.25-1.5H14v5.25H8.75V2.5Zm1.5 1.5v2.25h2.25V4h-2.25ZM2 9.25h5.25v4.25H2V9.25Zm1.5 1.5V12h2.25v-1.25H3.5Zm5.25-1.5H14v4.25H8.75V9.25Zm1.5 1.5V12h2.25v-1.25h-2.25Z"),
  rail: icon("M2 2.5h12v11H2v-11Zm1.5 1.5v8h6V4h-6Zm7.5 0v8h1.5V4H11Z"),
  send: icon("M2.2 2.4 14 8 2.2 13.6 3.5 8.8 9 8 3.5 7.2 2.2 2.4Z"),
  stop: icon("M4 4h8v8H4V4Z"),
  more: icon("M3 6.75A1.25 1.25 0 1 1 3 9.25a1.25 1.25 0 0 1 0-2.5Zm5 0A1.25 1.25 0 1 1 8 9.25a1.25 1.25 0 0 1 0-2.5Zm5 0A1.25 1.25 0 1 1 13 9.25a1.25 1.25 0 0 1 0-2.5Z"),
  back: icon("m9.8 3.2 1 1L7 8l3.8 3.8-1 1L5 8l4.8-4.8Z"),
}

const INSPECTOR_TAB_GROUPS: ReadonlyArray<{ label: string; tabs: ReadonlyArray<{ id: WorkbenchInspectorTab; label: string; description: string }> }> = [
  { label: "Task", tabs: [
    { id: "activity", label: "Activity", description: "Always-current status for the selected session: work state, queue, requests, and todos." },
    { id: "plan", label: "Plan", description: "Plans appear after Plan Task creates a reviewable document; approve one before handing it to an implementation session." },
    { id: "goal", label: "Goal", description: "Goals start with a /goal command or plan handoff and keep OpenCode working toward explicit criteria and limits across turns." },
    { id: "context", label: "Context", description: "Token usage appears after responses; receipts record the exact files, selections, or captures admitted with each prompt." },
  ] },
  { label: "Work", tabs: [
    { id: "changes", label: "Changes", description: "OpenCode session diffs plus the review findings, test evidence, and walkthroughs created from those exact changes." },
    { id: "jobs", label: "Jobs", description: "Delegations, child sessions, terminals, isolated runs, worktrees, comparisons, and session ancestry in one execution view." },
  ] },
  { label: "System", tabs: [
    { id: "health", label: "Health", description: "OpenCode connection, companion status, request queue, and sanitized Workbench protocol events." },
  ] },
]

interface StoredContextAttachment {
  sessionID: string
  key: string
  file: PromptFilePart
  summary: ContextAttachmentSummary
  sourceUri?: string
  receipt: Omit<ContextReceiptItem, "id" | "label">
}

type InitialWorkbenchControl = "composer-focus" | "sessions-toggle" | "sessions-show" | "attention-show"

export interface ChatWorkbenchServices {
  artifacts?: TaskArtifactService
  evidence?: EvidenceService
  recovery?: RecoveryPreviewService
  sessionPresentation?: SessionPresentationService
  health?: () => WorkbenchHealthSummary | undefined
  trace?: () => WorkbenchTraceSummary[]
  captureBrowserContext?: (request: Extract<WebviewToHostMessage, { type: "browserContextAction" }>) => Promise<void>
  openHealth?: () => Promise<void>
  openTrace?: () => Promise<void>
}

function receiptRange(range: vscode.Range): NonNullable<ContextReceiptItem["range"]> {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private panel?: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []
  private readonly viewDisposables: vscode.Disposable[] = []
  private readonly panelDisposables: vscode.Disposable[] = []
  private readonly updates: LatestUpdatePump<HostToWebviewMessage | undefined>
  private readonly pendingMessageUpdates = new Map<string, { sessionID: string; messageID: string }>()
  private readonly contextAttachments = new Map<string, StoredContextAttachment>()
  private readonly composerPayloads = new Map<string, { revision: number; attachments: InlineAttachment[]; pastedText: PastedTextBlock[] }>()
  private readonly recoveryPreviews = new RecoveryPreviewGuard<vscode.Webview>()
  private lastEditor = vscode.window.activeTextEditor
  private lastDocumentUri = vscode.window.activeTextEditor?.document.uri
  private lastEditorSelection = this.editorSelectionSnapshot(vscode.window.activeTextEditor)
  private editorContextSignature = ""
  private workspaceFiles?: { expiresAt: number; index: PreparedFzfIndex }
  private fullUpdatePending = false
  private readonly draftRevisions = new Map<string, number>()
  private readonly surfaceIDs = new Map<vscode.Webview, string>()
  private readonly protocol: WebviewProtocolHost<HostToWebviewMessage[], WebviewToHostMessage, HostToWebviewMessage>
  private lastConnected: boolean
  private knownSessionIDs = new Set<string>()
  private pendingEditorTab?: WorkbenchInspectorTab
  private pendingEditorControl?: InitialWorkbenchControl

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller?: SessionController,
    private readonly workspaceRoot?: string,
    private connectionError?: string,
    private readonly showLogs?: () => void,
    private readonly reportError?: (message: string) => void,
    private readonly contextReceipts?: ContextReceiptService,
    private readonly runGroups?: RunGroupService,
    private readonly multiRun?: MultiRunOrchestrator,
    private readonly walkthroughs?: WalkthroughService,
    private readonly worktrees?: WorktreeService,
    private readonly protocolTrace?: (observation: ProtocolObservation) => void,
    private readonly workbench: ChatWorkbenchServices = {},
  ) {
    this.knownSessionIDs = new Set(Object.keys(controller?.snapshot.sessions ?? {}))
    this.lastConnected = controller?.snapshot.connected ?? false
    this.protocol = new WebviewProtocolHost({
      state: () => this.initialMessages(),
      runtime: () => this.runtimeDescriptor(),
      parseInbound: parseWebviewMessage,
      dispatch: async (surfaceID, message) => {
        const source = [...this.surfaceIDs].find(([, id]) => id === surfaceID)?.[0]
        if (!source) throw new Error("The Workbench surface was disposed")
        await this.handleMessage(message, source, true)
      },
      requiredCapability: (message) => this.requiredCapability(message),
      eventDisposition: (message) => ["error", "insertText", "fileSuggestions", "historyPage"].includes(message.type) ? "transient" : "patch",
      snapshotFollowups: () => this.composerSnapshotFollowups(),
      observe: (observation) => this.protocolTrace?.(observation),
    })
    this.updates = new LatestUpdatePump(
      () => this.nextUpdate(),
      (message) => this.publishUpdate(message),
      (callback) => {
        const timer = setTimeout(callback, this.fullUpdatePending ? 150 : 80)
        return { cancel: () => clearTimeout(timer) }
      },
    )
    const subscription = controller?.subscribe((update) => {
      if (update.type === "connected" && update.connected) this.connectionError = undefined
      if (update.type === "connected") {
        if (this.lastConnected && !update.connected) void this.protocol.rotateEpoch()
        this.lastConnected = update.connected
      }
      this.queueUpdate(update)
    })
    if (subscription) this.disposables.push(subscription)
    const runGroupSubscription = this.runGroups?.subscribe(() => this.queueFullUpdate())
    if (runGroupSubscription) this.disposables.push(runGroupSubscription)
    const worktreeSubscription = this.worktrees?.subscribe(() => this.queueFullUpdate())
    if (worktreeSubscription) this.disposables.push(worktreeSubscription)
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.lastEditor = editor
          this.lastDocumentUri = editor.document.uri
          this.lastEditorSelection = this.editorSelectionSnapshot(editor)
        }
        void this.publishEditorContext()
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === this.lastEditor) {
          this.lastEditorSelection = this.editorSelectionSnapshot(event.textEditor)
          void this.publishEditorContext()
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.lastEditor?.document === document) {
          this.lastEditor = vscode.window.visibleTextEditors.find((editor) => editor.document !== document)
          this.lastDocumentUri = this.lastEditor?.document.uri
          this.lastEditorSelection = this.editorSelectionSnapshot(this.lastEditor)
          void this.publishEditorContext()
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === this.lastEditor?.document) {
          this.lastEditorSelection = this.editorSelectionSnapshot(this.lastEditor)
          void this.publishEditorContext()
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === this.lastEditor?.document) void this.publishEditorContext()
      }),
      vscode.window.onDidChangeActiveNotebookEditor(() => void this.publishEditorContext()),
      vscode.window.onDidChangeNotebookEditorSelection(() => void this.publishEditorContext()),
    )
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.view) {
      const previousID = this.surfaceIDs.get(this.view.webview)
      if (previousID) this.protocol.detach(previousID)
      this.recoveryPreviews.invalidate(this.view.webview)
      this.surfaceIDs.delete(this.view.webview)
    }
    this.disposeAll(this.viewDisposables)
    this.view = view
    const surfaceID = `sidebar-${randomUUID()}`
    this.surfaceIDs.set(view.webview, surfaceID)
    this.protocol.attach(surfaceID, view.webview, view.visible)
    this.configure(view.webview, "sidebar", surfaceID)
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((raw) => void this.handleIncoming(raw, view.webview, surfaceID)),
      view.onDidChangeVisibility(() => {
        void this.protocol.setVisible(surfaceID, view.visible)
        if (view.visible) {
          this.queueFullUpdate()
          void this.postEditorContext(view.webview)
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined
        this.protocol.detach(surfaceID)
        this.recoveryPreviews.invalidate(view.webview)
        this.surfaceIDs.delete(view.webview)
        this.disposeAll(this.viewDisposables)
      }),
    )
  }

  openInEditor(tab?: WorkbenchInspectorTab, initialControl?: InitialWorkbenchControl): void {
    this.rememberActiveEditorSelection()
    if (this.panel) {
      this.panel.reveal()
      if (tab) void this.postTo(this.panel.webview, { type: "navigateWorkbench", tab, focus: true })
      this.closeVisibleSidebar()
      return
    }
    this.pendingEditorTab = tab
    this.pendingEditorControl = initialControl
    const panel = vscode.window.createWebviewPanel(
      "opencodeWorkbench.chatEditor",
      "OpenCode Task Workbench",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] },
    )
    this.attachEditorPanel(panel)
    this.closeVisibleSidebar()
  }

  private closeVisibleSidebar(): void {
    if (this.view?.visible) void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar")
  }

  captureEditorSelection(): BrowserEditorSelection | undefined {
    this.rememberActiveEditorSelection()
    return this.lastEditorSelection ? { ...this.lastEditorSelection } : undefined
  }

  toggleEditor(): void {
    if (this.panel) {
      this.panel.dispose()
      return
    }
    this.openInEditor()
  }

  focusComposer(): void {
    if (!this.panel) {
      this.openInEditor(undefined, "composer-focus")
      return
    }
    this.openInEditor()
    const sessionID = this.controller?.snapshot.selectedID
    if (sessionID) void this.publishDirect({ type: "insertText", sessionID, text: "" })
  }

  toggleSessions(): void {
    if (!this.panel) {
      this.openInEditor(undefined, "sessions-show")
      return
    }
    void this.postTo(this.panel.webview, { type: "workbenchControl", target: "sessions", action: "toggle" })
  }

  toggleJobs(): void {
    if (!this.panel) {
      this.openInEditor("jobs")
      return
    }
    void this.postTo(this.panel.webview, { type: "workbenchControl", target: "jobs", action: "toggle" })
  }

  showAttention(): void {
    if (!this.panel) {
      this.openInEditor(undefined, "attention-show")
      return
    }
    this.openInEditor()
    void this.postTo(this.panel.webview, { type: "workbenchControl", target: "attention", action: "show" })
  }

  async openNextAttention(): Promise<void> {
    const item = this.snapshot().attentionItems?.[0]
    if (!item) {
      this.openInEditor("activity")
      return
    }
    if (item.sessionID && item.sessionID !== this.controller?.snapshot.selectedID && Object.hasOwn(this.controller?.snapshot.sessions ?? {}, item.sessionID)) {
      await this.controller?.select(item.sessionID)
    }
    const tab: WorkbenchInspectorTab = item.target.surface === "goal" ? "goal" : item.target.surface === "runs" ? "runs" : item.target.surface === "health" ? "health" : "activity"
    this.openInEditor(tab)
  }

  restoreEditor(panel: vscode.WebviewPanel): void {
    this.attachEditorPanel(panel)
  }

  private attachEditorPanel(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      const previousID = this.surfaceIDs.get(this.panel.webview)
      if (previousID) this.protocol.detach(previousID)
      this.recoveryPreviews.invalidate(this.panel.webview)
      this.surfaceIDs.delete(this.panel.webview)
    }
    this.disposeAll(this.panelDisposables)
    this.panel = panel
    const surfaceID = `editor-${randomUUID()}`
    this.surfaceIDs.set(panel.webview, surfaceID)
    this.protocol.attach(surfaceID, panel.webview, panel.visible)
    this.configure(panel.webview, "editor", surfaceID, this.pendingEditorTab, this.pendingEditorControl)
    this.pendingEditorTab = undefined
    this.pendingEditorControl = undefined
    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((raw) => void this.handleIncoming(raw, panel.webview, surfaceID)),
      panel.onDidChangeViewState(() => {
        void this.protocol.setVisible(surfaceID, panel.visible)
        if (panel.visible) {
          this.queueFullUpdate()
          void this.postEditorContext(panel.webview)
        }
      }),
      panel.onDidDispose(() => {
        if (this.panel === panel) this.panel = undefined
        this.protocol.detach(surfaceID)
        this.recoveryPreviews.invalidate(panel.webview)
        this.surfaceIDs.delete(panel.webview)
        this.disposeAll(this.panelDisposables)
      }),
    )
  }

  private disposeAll(disposables: vscode.Disposable[]): void {
    for (const disposable of disposables.splice(0)) disposable.dispose()
  }

  isShowingSession(sessionID: string): boolean {
    if (!vscode.window.state.focused || (!this.view?.visible && !this.panel?.active) || !this.controller?.snapshot.selectedID) return false
    const root = (id: string): string => {
      const visited = new Set<string>()
      let current = id
      while (this.controller?.snapshot.sessions[current]?.info.parentID && !visited.has(current)) {
        visited.add(current)
        current = this.controller.snapshot.sessions[current]!.info.parentID!
      }
      return current
    }
    return root(sessionID) === root(this.controller.snapshot.selectedID)
  }

  protocolHealth(): {
    protocol: { version: 2; epoch: string }
    runtime: RuntimeDescriptor
    capabilities: WorkbenchCapability[]
    requestQueueDepth: number
  } {
    return {
      protocol: { version: 2, epoch: this.protocol.currentEpoch },
      runtime: this.runtimeDescriptor(),
      capabilities: (Object.entries(this.protocol.capabilities) as Array<[WorkbenchCapability, boolean]>)
        .filter(([, available]) => available)
        .map(([capability]) => capability),
      requestQueueDepth: this.protocol.pendingRequests,
    }
  }

  private configure(webview: vscode.Webview, mode: "sidebar" | "editor", surfaceID: string, initialTab?: WorkbenchInspectorTab, initialControl?: InitialWorkbenchControl): void {
    const media = vscode.Uri.joinPath(this.extensionUri, "media")
    webview.options = { enableScripts: true, localResourceRoots: [media] }
    webview.html = this.html(webview, mode, surfaceID, initialTab, initialControl)
  }

  private html(webview: vscode.Webview, mode: "sidebar" | "editor", surfaceID: string, initialTab?: WorkbenchInspectorTab, initialControl?: InitialWorkbenchControl): string {
    const nonce = randomBytes(18).toString("base64")
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"))
    const extensionVersion = String(vscode.extensions.getExtension("nulifyer.opencode-workbench")?.packageJSON.version ?? "unknown")
    const safeVersion = /^[A-Za-z0-9.+-]{1,64}$/.test(extensionVersion) ? extensionVersion : "unknown"
    const configuration = vscode.workspace.getConfiguration("opencodeWorkbench")
    const configuredDensity = configuration.get<string>("transcriptDensity", "full")
    const transcriptDensity = configuredDensity === "answers" ? "answers" : "full"
    const configuredMotion = configuration.get<string>("progressMotion", "system")
    const progressMotion = configuredMotion === "animated" || configuredMotion === "static" ? configuredMotion : "system"
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>OpenCode Chat</title>
</head>
<body data-mode="${mode}" data-surface-id="${surfaceID}" data-extension-version="${safeVersion}" data-transcript-density="${transcriptDensity}" data-progress-motion="${progressMotion}"${initialTab ? ` data-initial-tab="${initialTab}"` : ""}${initialControl ? ` data-initial-control="${initialControl}"` : ""}>
  <div class="app-shell">
    <header class="chat-header">
      <button id="back-parent" class="icon-action" type="button" title="Back to parent session" aria-label="Back to parent session" hidden>${ICONS.back}</button>
      <button id="session-current" class="session-current" type="button" aria-haspopup="dialog" aria-expanded="false" title="Search session history">
        <span class="session-title" id="session-title">No session</span><span class="session-state" id="session-state"></span>${ICONS.chevron}
      </button>
      <span id="public-badge" class="public-badge" title="This OpenCode transcript is publicly shared" hidden>PUBLIC</span>
      <span id="connection" class="connection offline" role="status" tabindex="-1" hidden>Offline</span>
      <div class="header-actions">
        <button id="create-header" class="icon-action" type="button" title="New session" aria-label="New session">${ICONS.add}</button>
        <button id="attention-toggle" class="icon-action attention-toggle" type="button" title="Needs Attention" aria-label="Needs Attention" aria-haspopup="dialog" aria-expanded="false"><span aria-hidden="true">!</span><small id="attention-count" hidden></small></button>
        <button id="help-toggle" class="icon-action" type="button" title="Keyboard help" aria-label="Keyboard help" aria-haspopup="dialog" aria-expanded="false"><span aria-hidden="true">?</span></button>
        <button id="inspector-toggle" class="icon-action" type="button" title="Toggle Task Workbench" aria-label="Toggle Task Workbench" aria-expanded="false">${ICONS.workbench}</button>
        <button id="surface-toggle" class="icon-action" type="button" title="${mode === "sidebar" ? "Switch chat to editor" : "Switch chat to sidebar"}" aria-label="${mode === "sidebar" ? "Switch chat to editor" : "Switch chat to sidebar"}">${ICONS.editor}</button>
        <button id="rail-toggle" class="icon-action" type="button" title="Toggle sessions" aria-label="Toggle sessions" aria-expanded="${mode === "editor"}">${ICONS.rail}</button>
        <button id="session-menu-toggle" class="icon-action" type="button" title="Session actions" aria-label="Session actions" aria-haspopup="menu" aria-expanded="false">${ICONS.more}</button>
      </div>
    </header>
    <div id="session-menu" class="session-menu" role="menu" hidden>
      <label class="menu-search"><span class="visually-hidden">Search actions</span><input id="session-menu-search" type="search" placeholder="Search actions" autocomplete="off"></label>
      <button type="button" role="menuitem" data-menu-command="create">New session</button>
      <button type="button" role="menuitem" data-menu-command="refresh">Refresh sessions</button>
      <button type="button" role="menuitem" data-menu-command="sessions">Switch session</button>
      <button type="button" role="menuitem" data-menu-command="agent">Switch agent</button>
      <button type="button" role="menuitem" data-menu-command="model">Switch model</button>
      <button type="button" role="menuitem" data-menu-command="variant">Switch reasoning</button>
      <button type="button" role="menuitem" data-menu-command="skills">Browse commands and skills</button>
      <button type="button" role="menuitem" data-menu-command="surface">${mode === "sidebar" ? "Open in editor" : "Open in sidebar"}</button>
      <hr>
      <button type="button" role="menuitem" data-session-action="rename">Rename</button>
      <button type="button" role="menuitem" data-session-action="fork">Fork session</button>
      <button type="button" role="menuitem" data-session-action="undo">Undo last turn</button>
      <button type="button" role="menuitem" data-session-action="redo">Redo</button>
      <button type="button" role="menuitem" data-session-action="compact">Compact context</button>
      <button type="button" role="menuitem" data-session-action="share">Share publicly</button>
      <button type="button" role="menuitem" data-session-action="unshare">Unshare</button>
      <button type="button" role="menuitem" data-menu-command="copyShare">Copy public link</button>
      <hr>
      <button type="button" role="menuitem" data-menu-command="stash">Stash prompt</button>
      <button type="button" role="menuitem" data-menu-command="restore">Restore stashed prompt</button>
      <button type="button" role="menuitem" data-menu-command="latest">Jump to latest message</button>
      <button type="button" role="menuitem" data-menu-command="expand-thinking">Expand thinking</button>
      <button type="button" role="menuitem" data-menu-command="collapse-thinking">Collapse thinking</button>
      <button type="button" role="menuitem" data-menu-command="expand-tools">Show tool details</button>
      <button type="button" role="menuitem" data-menu-command="collapse-tools">Hide tool details</button>
      <button type="button" role="menuitem" data-menu-command="timestamps">Toggle timestamps</button>
      <button type="button" role="menuitem" data-menu-command="scrollbar">Toggle session scrollbar</button>
      <button type="button" role="menuitem" data-session-action="copyLast">Copy last response</button>
      <button type="button" role="menuitem" data-session-action="copyTranscript">Copy transcript</button>
      <button type="button" role="menuitem" data-session-action="export">Export transcript</button>
      <button type="button" role="menuitem" class="danger-action" data-session-action="delete">Delete session</button>
    </div>
    <div id="session-context-menu" class="session-context-menu" role="menu" hidden>
      <button type="button" role="menuitem" data-context-action="open">Open</button>
      <button type="button" role="menuitem" data-context-action="pin">Pin</button>
      <button type="button" role="menuitem" data-context-action="rename">Rename</button>
      <button type="button" role="menuitem" data-context-action="fork">Fork session</button>
      <button type="button" role="menuitem" data-context-action="archive">Archive</button>
      <hr>
      <button type="button" role="menuitem" class="danger-action" data-context-action="delete">Delete session</button>
    </div>

    <div id="history-overlay" class="overlay" hidden>
      <button class="overlay-backdrop" type="button" data-close-overlay aria-label="Close session history"></button>
      <section class="history-panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div class="overlay-heading"><strong id="history-title">Session history</strong><button type="button" class="text-action" data-close-overlay>Close</button></div>
        <label class="search"><span class="visually-hidden">Search sessions</span><input id="history-search" type="search" placeholder="Search sessions" autocomplete="off"></label>
        <div id="history-list" class="history-list"></div>
      </section>
    </div>

    <div id="attachment-preview" class="overlay attachment-preview" hidden>
      <button class="overlay-backdrop" type="button" data-close-attachment-preview aria-label="Close attachment preview"></button>
      <section class="attachment-preview-panel" role="dialog" aria-modal="true" aria-labelledby="attachment-preview-title">
        <div class="overlay-heading"><strong id="attachment-preview-title">Attachment preview</strong><button type="button" class="text-action" data-close-attachment-preview>Close</button></div>
        <img id="attachment-preview-image" alt="">
        <p id="attachment-preview-meta"></p>
      </section>
    </div>

    <div id="attention-overlay" class="overlay" hidden>
      <button class="overlay-backdrop" type="button" data-close-attention aria-label="Close Needs Attention"></button>
      <section class="history-panel attention-panel" role="dialog" aria-modal="true" aria-labelledby="attention-title">
        <div class="overlay-heading"><strong id="attention-title">Needs Attention</strong><button type="button" class="text-action" data-close-attention>Close</button></div>
        <div id="attention-list" class="attention-list"></div>
      </section>
    </div>

    <div id="recovery-overlay" class="overlay" hidden>
      <button class="overlay-backdrop" type="button" data-close-recovery aria-label="Close recovery preview"></button>
      <section class="history-panel recovery-panel" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <div class="overlay-heading"><strong id="recovery-title">OpenCode recovery preview</strong><button type="button" class="text-action" data-close-recovery>Close</button></div>
        <div id="recovery-content"></div>
      </section>
    </div>

    <div id="keyboard-help-overlay" class="overlay" hidden>
      <button class="overlay-backdrop" type="button" data-close-keyboard-help aria-label="Close keyboard help"></button>
      <section class="history-panel keyboard-help-panel" role="dialog" aria-modal="true" aria-labelledby="keyboard-help-title">
        <div class="overlay-heading"><strong id="keyboard-help-title">OpenCode Workbench keyboard help</strong><button type="button" class="text-action" data-close-keyboard-help>Close</button></div>
        <p class="keyboard-help-note">Shortcuts are user-configurable in VS Code. These are the extension defaults.</p>
        <dl class="inspector-metrics keyboard-help-list"><dt>Default: Ctrl/Cmd+Shift+O</dt><dd>Open Task Workbench</dd><dt>Default: Ctrl/Cmd+L</dt><dd>Focus composer</dd><dt>Escape</dt><dd>Stop active OpenCode work when the Workbench is focused</dd><dt>Arrow keys</dt><dd>Navigate menus, tabs, session lists, and splitters</dd><dt>Shift+F10</dt><dd>Open the selected session context menu</dd><dt>Home / End</dt><dd>Resize a focused pane to its minimum or maximum</dd></dl>
      </section>
    </div>

    <div class="work-area">
      <section id="conversation-column" class="conversation-column">
        <section id="notice" class="notice" role="alert" tabindex="-1" hidden>
          <div class="notice-copy"><strong id="notice-title"></strong><p id="notice-message"></p></div>
          <div class="notice-actions"><button id="notice-retry" type="button">Retry</button><button id="notice-logs" type="button">Open Logs</button><button id="notice-copy" type="button">Copy details</button><button id="notice-dismiss" type="button" aria-label="Dismiss message">×</button></div>
        </section>
        <nav id="turn-navigation" class="turn-navigation" aria-label="Session markers" hidden></nav>
        <section id="history-boundary" class="history-boundary" role="status" aria-live="polite" hidden>
          <span id="history-boundary-text"></span>
          <button id="history-load-older" type="button">Load older messages</button>
        </section>
        <main id="messages" role="log" aria-label="OpenCode conversation"></main>
        <section id="session-change-summary" class="session-change-summary" aria-label="Session changes" hidden></section>
        <button id="jump-latest" class="jump-latest" type="button" hidden>↓ Latest <span id="jump-latest-count"></span></button>
        <div id="session-loading" class="session-loading" role="status" aria-live="polite" hidden><span class="session-loading-indicator" aria-hidden="true"></span><span>Loading session…</span></div>
        <div id="announcer" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>
        <section id="empty" class="empty">
          <div class="empty-mark" aria-hidden="true">OC</div>
          <h1>Work with OpenCode</h1>
          <p>Ask about this workspace, plan a change, or start implementing.</p>
          <div class="starters" aria-label="Suggested prompts">
            <button type="button" data-prompt="Explain the architecture of this workspace.">Explain this workspace</button>
            <button type="button" data-prompt="Review the current changes for bugs and missing tests.">Review current changes</button>
            <button type="button" data-prompt="Help me plan the next implementation step.">Plan next steps</button>
          </div>
          <div class="empty-actions">
            <button id="plan-task" class="primary-action" type="button">Plan a task first</button>
            <button id="create-empty" type="button">New session</button>
          </div>
        </section>

        <footer class="interaction-region">
          <section id="permission-dock" class="dock permission-dock" aria-label="Permission requests" aria-live="assertive" hidden></section>
          <section id="question-dock" class="dock question-dock" aria-label="Questions from OpenCode" aria-live="assertive" hidden></section>
          <div class="summary-docks">
            <section id="goal-dock" class="dock summary-dock goal-dock" hidden></section>
            <section id="todo-dock" class="dock todo-dock" aria-label="Session todos" hidden></section>
          </div>
          <section id="queue-dock" class="dock queue-dock" aria-label="Queued prompts" hidden></section>
          <section id="command-suggestions" class="command-suggestions" role="listbox" aria-label="OpenCode commands" hidden></section>
          <section id="file-suggestions" class="command-suggestions" role="listbox" aria-label="Workspace files" hidden></section>
          <section id="model-picker" class="model-picker" role="dialog" aria-modal="true" aria-labelledby="model-picker-title" hidden>
            <div class="model-picker-header"><strong id="model-picker-title">Model settings</strong><label><span class="visually-hidden">Search models</span><input id="model-search" type="search" placeholder="Search models" autocomplete="off"></label></div>
            <div id="reasoning-options" class="picker-options reasoning-options"></div>
            <div id="model-options" class="picker-options model-options" role="listbox" aria-label="Models"></div>
            <div id="model-meta" class="model-picker-meta"></div>
          </section>
          <div class="composer" id="composer">
            <div id="attachment-dock" class="attachment-dock" hidden></div>
            <textarea id="draft" rows="2" placeholder="Ask OpenCode or use /command..." aria-label="Message OpenCode" aria-autocomplete="list" aria-controls="command-suggestions file-suggestions" aria-expanded="false"></textarea>
            <div class="composer-footer">
              <div class="composer-fields">
                <label class="composer-field agent-field" title="Agent"><select id="agent" aria-label="Agent"><option value="">Default agent</option></select></label>
                <button id="approval-toggle" class="composer-field approval-toggle" type="button" role="switch" aria-checked="false" title="Ask before OpenCode performs actions that need permission"><strong id="approval-mode">Ask</strong></button>
                <button id="model-toggle" class="composer-field model-field" type="button" aria-haspopup="dialog" aria-expanded="false" title="Model and reasoning"><span id="model-button-label">Default model</span><small id="variant-button-label"></small></button>
                <select id="model" aria-label="Model" hidden><option value="">Default model</option></select>
                <select id="variant" aria-label="Reasoning level" hidden><option value="">Default reasoning</option></select>
              </div>
              <div class="composer-actions">
                <span id="status" role="status" aria-live="polite" tabindex="-1">Idle</span>
                <button id="attach-files" class="icon-action" type="button" title="Attach files or folders" aria-label="Attach files or folders">${ICONS.attach}</button>
                <div id="send-group" class="send-group">
                  <button id="send" class="round-action send-action" type="button" title="Send (Enter)" aria-label="Send message">${ICONS.send}</button>
                  <details id="send-options" hidden>
                    <summary aria-label="More send options" title="More send options">⌄</summary>
                    <div role="menu">
                      <button type="button" role="menuitem" data-send-delivery="steer"><strong>Steer current work</strong><small>Deliver at OpenCode's next safe boundary.</small></button>
                      <button type="button" role="menuitem" data-send-delivery="queue"><strong>Follow up after completion</strong><small>Wait until the current work would otherwise stop.</small></button>
                      <button type="button" role="menuitem" data-send-delivery="replace"><strong>Replace queued instruction</strong><small>Cancel current work and admit this instruction next.</small></button>
                    </div>
                  </details>
                </div>
              </div>
            </div>
          </div>
          <div id="workspace-strip" class="workspace-strip" aria-label="Workspace status"></div>
        </footer>
      </section>

      <div id="artifact-splitter" class="pane-splitter editor-only" role="separator" aria-orientation="vertical" aria-label="Resize task artifacts" aria-valuemin="420" aria-valuemax="900" aria-valuenow="500" tabindex="0"></div>

      <aside id="inspector" class="inspector" aria-label="OpenCode inspector" hidden>
        <div class="inspector-header"><strong>Task Workbench</strong><button id="inspector-close" class="icon-action" type="button" aria-label="Close task workbench">${ICONS.close}</button></div>
        <div id="inspector-tabs" class="inspector-tabs" role="tablist" aria-label="Inspector sections">
          ${INSPECTOR_TAB_GROUPS.map((group, groupIndex) => `<div class="inspector-tab-group" role="presentation"><span class="inspector-tab-group-label" aria-hidden="true">${group.label}</span>${group.tabs.map((tab, tabIndex) => `<button id="inspector-tab-${tab.id}" type="button" role="tab" data-inspector-tab="${tab.id}" aria-controls="inspector-panel" aria-selected="${groupIndex === 0 && tabIndex === 0}" aria-description="${tab.description}" title="${tab.description}" tabindex="${groupIndex === 0 && tabIndex === 0 ? 0 : -1}"><span>${tab.label}</span></button>`).join("")}</div>`).join("")}
        </div>
        <section id="inspector-panel" class="inspector-panel" role="tabpanel" aria-labelledby="inspector-tab-activity" tabindex="0"></section>
      </aside>

      <div id="sessions-splitter" class="pane-splitter editor-only" role="separator" aria-orientation="vertical" aria-label="Resize sessions" aria-valuemin="280" aria-valuemax="520" aria-valuenow="320" tabindex="0"></div>

      <aside id="right-rail" class="right-rail editor-only" aria-label="OpenCode sessions">
        <div class="rail-header sidebar-only"><strong>Sessions</strong><button id="rail-close" class="icon-action" type="button" title="Close sessions" aria-label="Close sessions">${ICONS.close}</button></div>
        <div id="rail-sessions" class="rail-panel">
          <div class="rail-heading"><strong>Sessions</strong><span id="rail-session-count">0</span></div>
          <label class="rail-session-search"><span class="visually-hidden">Search sessions</span><input id="rail-session-search" type="search" placeholder="Search sessions" autocomplete="off"></label>
          <div id="rail-session-list"></div>
        </div>
      </aside>
    </div>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }

  private requireSelected(sessionID: string): void {
    this.requireKnown(sessionID)
    if (this.controller!.snapshot.selectedID !== sessionID) throw new Error("Session changed before the request completed")
  }

  private requireKnown(sessionID: string): void {
    if (!this.controller || !Object.hasOwn(this.controller.snapshot.sessions, sessionID)) throw new Error("Unknown OpenCode session")
  }

  private requireInteractiveSession(sessionID: string): void {
    if (!this.controller || !Object.hasOwn(this.controller.snapshot.sessions, sessionID)) throw new Error("Unknown OpenCode session")
    if (this.controller.snapshot.selectedID === sessionID) return
    const selectedID = this.controller.snapshot.selectedID
    let parentID = this.controller.snapshot.sessions[sessionID]?.info.parentID
    const visited = new Set<string>()
    while (parentID && !visited.has(parentID)) {
      if (parentID === selectedID) return
      visited.add(parentID)
      parentID = this.controller.snapshot.sessions[parentID]?.info.parentID
    }
    throw new Error("Session changed before the request completed")
  }

  private selectionLines(range: vscode.Range): string | undefined {
    if (range.isEmpty) return undefined
    const end = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1
    return range.start.line + 1 === end ? `Line ${end}` : `Lines ${range.start.line + 1}-${end}`
  }

  private editorSelectionSnapshot(editor: vscode.TextEditor | undefined): BrowserEditorSelection | undefined {
    if (!editor || editor.document.isClosed || editor.selection.isEmpty) return undefined
    const selection = editor.selection
    return {
      uri: editor.document.uri.toString(),
      startLine: selection.start.line + 1,
      startColumn: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
      revision: String(editor.document.version),
      text: editor.document.getText(selection),
    }
  }

  private rememberActiveEditorSelection(): void {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    this.lastEditor = editor
    this.lastDocumentUri = editor.document.uri
    this.lastEditorSelection = this.editorSelectionSnapshot(editor)
  }

  private editorContext(): EditorContextSummary | undefined {
    const sessionID = this.controller?.snapshot.selectedID
    const isAttached = (uri: vscode.Uri): boolean => Boolean(sessionID && [...this.contextAttachments.values()].some((attachment) =>
      attachment.sessionID === sessionID && attachment.sourceUri === uri.toString()))
    const notebook = vscode.window.activeTextEditor ? undefined : vscode.window.activeNotebookEditor
    if (notebook) {
      const selected = notebook.selections.reduce((total, range) => total + Math.max(0, range.end - range.start), 0)
      return { name: path.basename(notebook.notebook.uri.fsPath) || "Untitled notebook", detail: selected ? `${selected} selected cell${selected === 1 ? "" : "s"}` : `${notebook.notebook.cellCount} cells`, dirty: notebook.notebook.isDirty, attached: isAttached(notebook.notebook.uri) }
    }
    const editor = this.lastEditor && !this.lastEditor.document.isClosed ? this.lastEditor : undefined
    const document = editor?.document ?? this.currentTextDocument()
    if (!document) return undefined
    return {
      name: path.basename(document.fileName) || "Untitled",
      detail: editor && editor.document === document ? this.selectionLines(editor.selection) ?? (document.isDirty ? "Unsaved changes" : "Current editor") : document.isDirty ? "Unsaved changes" : "Open editor",
      dirty: document.isDirty,
      attached: isAttached(document.uri),
    }
  }

  private currentTextDocument(): vscode.TextDocument | undefined {
    const remembered = this.lastDocumentUri && vscode.workspace.textDocuments.find((document) => !document.isClosed && document.uri.toString() === this.lastDocumentUri!.toString())
    if (remembered) return remembered
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const uri = input instanceof vscode.TabInputText ? input.uri : input instanceof vscode.TabInputTextDiff ? input.modified : undefined
    if (uri) {
      const document = vscode.workspace.textDocuments.find((candidate) => !candidate.isClosed && candidate.uri.toString() === uri.toString())
      if (document) {
        this.lastDocumentUri = uri
        return document
      }
    }
    return undefined
  }

  private runtimeDescriptor(): RuntimeDescriptor {
    const mode = vscode.workspace.getConfiguration("opencodeWorkbench").get<"managed" | "external">("serverMode", "managed")
    return {
      mode,
      authority: "opencode",
      companion: mode === "external" ? "missing" : this.controller && !this.connectionError ? "connected" : "incompatible",
      nativeAgentHost: "deferred",
    }
  }

  private requiredCapability(message: WebviewToHostMessage): WorkbenchCapability | undefined {
    if (message.type === "createSession") return "session.create"
    if (message.type === "selectSession") return "session.resume"
    if (message.type === "abort") return "prompt.cancel"
    if (message.type === "send") {
      return message.delivery === "steer"
        ? "prompt.steer"
        : message.delivery === "replace"
        ? "prompt.replace"
        : "prompt.followUp"
    }
    if (message.type === "sessionAction") {
      if (message.action === "fork") return "session.fork"
      if (message.action === "delete") return "session.delete"
    }
    if (message.type === "respondPermission") return "input.permissions.exact"
    if (message.type === "respondQuestion" || message.type === "rejectQuestion") return "input.questions"
    if (message.type === "goalAction") return "goal.lifecycle"
    if (["pickFiles", "resolveDroppedUris", "removeContextAttachment", "openContextAttachment", "contextReceiptAction", "attachWorkspacePath", "attachResource"].includes(message.type)) return "context.ledger"
    if (message.type === "attachCurrentEditor") return "context.editorBridge"
    return undefined
  }

  private initialMessages(): HostToWebviewMessage[] {
    const messages: HostToWebviewMessage[] = [
      { type: "snapshot", snapshot: this.snapshot() },
      { type: "editorContextChanged", context: this.editorContext() },
    ]
    const sessionID = this.controller?.snapshot.selectedID
    if (sessionID) {
      messages.push({ type: "contextAttachmentsChanged", sessionID, attachments: this.contextSummaries(sessionID) })
    }
    return this.validHostState(messages)
  }

  private composerSnapshotFollowups(): HostToWebviewMessage[] {
    const sessionID = this.controller?.snapshot.selectedID
    if (!sessionID) return []
    const payload = this.composerPayloads.get(sessionID) ?? { revision: 0, attachments: [], pastedText: [] }
    return this.validHostState([{ type: "composerPayloadChanged", sessionID, ...payload }])
  }

  private validHostState(messages: HostToWebviewMessage[]): HostToWebviewMessage[] {
    return messages.flatMap((message) => {
      if (parseHostMessage(message)) return [message]
      const type = typeof message.type === "string" ? message.type : "unknown"
      if (message.type === "snapshot") {
        const recovered = this.recoverInvalidSnapshot(message)
        if (recovered) return [recovered]
      }
      this.reportError?.(`Generated invalid Workbench host message: ${type}`)
      // A snapshot is the authoritative state and must never be silently hidden.
      // Optional editor/composer decorations can be omitted until their next valid update.
      return type === "snapshot" ? [message] : []
    })
  }

  private recoverInvalidSnapshot(message: Extract<HostToWebviewMessage, { type: "snapshot" }>): HostToWebviewMessage | undefined {
    const optionalSnapshotFields = [
      "lineage", "mentionAgents", "providers", "resources", "catalog", "commands", "autoApproval", "runtime", "ptys",
      "attentionItems", "composer", "runGroups", "worktrees", "walkthroughs", "health", "trace", "projection",
      "artifacts", "reviewFindings", "evidence", "runComparisons",
    ] as const
    for (const field of optionalSnapshotFields) {
      if (message.snapshot[field] === undefined) continue
      const snapshot = { ...message.snapshot }
      delete (snapshot as unknown as Record<string, unknown>)[field]
      const candidate: HostToWebviewMessage = { type: "snapshot", snapshot }
      if (!parseHostMessage(candidate)) continue
      this.reportError?.(`Omitted invalid optional Workbench snapshot field: ${field}`)
      return candidate
    }
    if (!message.snapshot.session) return undefined
    const optionalSessionFields = [
      "parentID", "directory", "agent", "model", "variant", "queue", "inFlightPromptID", "permissions", "questions", "todos",
      "changes", "context", "goal", "delegations", "contextReceipts", "history", "archived", "shared", "shareUrl", "revertMessageID",
    ] as const
    for (const field of optionalSessionFields) {
      if (message.snapshot.session[field] === undefined) continue
      const session = { ...message.snapshot.session }
      delete (session as unknown as Record<string, unknown>)[field]
      if (field === "queue") delete (session as unknown as Record<string, unknown>).inFlightPromptID
      const candidate: HostToWebviewMessage = { type: "snapshot", snapshot: { ...message.snapshot, session } }
      if (!parseHostMessage(candidate)) continue
      this.reportError?.(`Omitted invalid optional Workbench session field: ${field}`)
      return candidate
    }
    return undefined
  }

  private async handleIncoming(raw: unknown, source: vscode.Webview, surfaceID: string): Promise<void> {
    try {
      if (await this.protocol.receive(surfaceID, raw)) return
      this.protocol.markLegacy(surfaceID)
      await this.handleMessage(raw, source)
    } catch (error) {
      const message = errorText(error)
      this.reportError?.(`Webview protocol failed: ${message}`)
      await this.postTo(source, { type: "error", message })
    }
  }

  private async postTo(source: vscode.Webview, message: HostToWebviewMessage): Promise<void> {
    const surfaceID = this.surfaceIDs.get(source)
    if (!surfaceID) {
      await source.postMessage(message)
      return
    }
    await this.protocol.publishTo(surfaceID, message)
  }

  private async deliverRecoveryPreview(source: vscode.Webview, input: RecoveryPreviewInput): Promise<void> {
    this.recoveryPreviews.invalidate(source)
    if (!this.workbench.recovery) throw new Error("OpenCode recovery preview is unavailable")
    const preview = this.workbench.recovery.preview(input)
    this.recoveryPreviews.remember(source, { input, preview })
    try {
      await this.postTo(source, { type: "recoveryPreview", preview })
    } catch (error) {
      this.recoveryPreviews.invalidate(source)
      throw error
    }
  }

  private contextSummaries(sessionID: string): ContextAttachmentSummary[] {
    return [...this.contextAttachments.values()].filter((attachment) => attachment.sessionID === sessionID).map((attachment) => attachment.summary)
  }

  private async postEditorContext(webview: vscode.Webview): Promise<void> {
    await this.postTo(webview, { type: "editorContextChanged", context: this.editorContext() })
    const sessionID = this.controller?.snapshot.selectedID
    if (sessionID) {
      await this.postTo(webview, { type: "contextAttachmentsChanged", sessionID, attachments: this.contextSummaries(sessionID) })
      const payload = this.composerPayloads.get(sessionID) ?? { revision: 0, attachments: [], pastedText: [] }
      await this.postTo(webview, { type: "composerPayloadChanged", sessionID, ...payload })
    }
  }

  private async publishEditorContext(): Promise<void> {
    const signature = JSON.stringify(this.editorContext())
    if (signature === this.editorContextSignature) return
    this.editorContextSignature = signature
    await Promise.all([
      this.view?.visible ? this.postEditorContext(this.view.webview) : undefined,
      this.panel?.visible ? this.postEditorContext(this.panel.webview) : undefined,
    ].filter(Boolean))
  }

  private async publishContextAttachments(sessionID: string): Promise<void> {
    if (sessionID !== this.controller?.snapshot.selectedID) return
    this.editorContextSignature = ""
    await this.publishEditorContext()
  }

  private async handleMessage(raw: unknown, source: vscode.Webview, rethrow = false): Promise<void> {
    const message = parseWebviewMessage(raw)
    if (!message) {
      await this.postTo(source, { type: "error", message: "Ignored an invalid webview message" })
      return
    }
    try {
      switch (message.type) {
        case "ready":
          this.recoveryPreviews.invalidate(source)
          await this.postTo(source, { type: "snapshot", snapshot: this.snapshot() })
          await this.postEditorContext(source)
          break
        case "setDraft":
          this.requireKnown(message.sessionID)
          this.controller!.setSessionDraft(message.sessionID, message.draft)
          const revision = (this.draftRevisions.get(message.sessionID) ?? 0) + 1
          this.draftRevisions.set(message.sessionID, revision)
          await this.publishDirect({
            type: "draftChanged",
            sessionID: message.sessionID,
            draft: message.draft,
            revision,
          })
          break
        case "setComposerPayload":
          this.requireKnown(message.sessionID)
          {
            const current = this.composerPayloads.get(message.sessionID) ?? { revision: 0, attachments: [], pastedText: [] }
            if (message.revision !== current.revision) {
              await this.postTo(source, { type: "composerPayloadChanged", sessionID: message.sessionID, ...current, conflict: true, mutationID: message.mutationID })
              break
            }
            const payload = { revision: current.revision + 1, attachments: message.attachments, pastedText: message.pastedText }
            this.composerPayloads.set(message.sessionID, payload)
            await this.publishDirect({ type: "composerPayloadChanged", sessionID: message.sessionID, ...payload, mutationID: message.mutationID })
          }
          break
        case "setPreference":
          this.requireSelected(message.sessionID)
          this.controller!.setPreference(message.agent, message.model, message.variant)
          break
        case "goalAction":
          this.requireSelected(message.sessionID)
          if (message.action === "edit" || message.action === "configure") {
            this.openInEditor("goal")
          } else if (message.action === "verify") {
            await vscode.commands.executeCommand("opencodeWorkbench.verifyGoal")
          } else if (message.action === "cancel") {
            const confirmed = await vscode.window.showWarningMessage("Cancel and clear this goal?", { modal: true }, "Cancel goal")
            if (confirmed === "Cancel goal") await this.controller!.send("/goal cancel")
          } else {
            await this.controller!.send(`/goal ${message.action}`)
          }
          break
        case "configureGoal": {
          this.requireSelected(message.sessionID)
          const goal = this.controller!.chatSnapshot().session?.goal
          if (!goal) throw new Error("This session has no goal")
          if (message.expectedSettlementGeneration !== undefined && goal.settlementGeneration !== message.expectedSettlementGeneration) {
            throw new Error("The goal changed while its configuration form was open; review the latest values and save again")
          }
          const configuration = message.configuration
          await this.controller!.send(`/goal configure ${JSON.stringify({
            objective: configuration.objective,
            acceptance_criteria: configuration.acceptanceCriteria,
            token_budget: configuration.tokenBudget,
            max_auto_turns: configuration.maxAutoTurns,
            max_duration_seconds: configuration.maxDurationSeconds,
            enabled: configuration.verifier.enabled,
            model: configuration.verifier.model,
            agent: configuration.verifier.agent,
            timeout_milliseconds: configuration.verifier.timeoutMilliseconds,
            repeated_block_threshold: configuration.verifier.repeatedBlockThreshold,
            expected_generation: message.expectedSettlementGeneration,
          })}`)
          break
        }
        case "sessionPresentation": {
          this.requireKnown(message.sessionID)
          if (message.action === "pin") this.workbench.sessionPresentation?.pin(message.sessionID)
          else if (message.action === "unpin") this.workbench.sessionPresentation?.unpin(message.sessionID)
          else {
            const session = this.controller!.snapshot.sessions[message.sessionID]
            const confirmed = await vscode.window.showWarningMessage(
              `Archive "${session?.info.title || message.sessionID}"?`,
              { modal: true, detail: "Archived is native OpenCode session state. Archived sessions are hidden by default. This pinned OpenCode version has no proven unarchive API, so the Workbench cannot currently undo this action." },
              "Archive",
            )
            if (confirmed === "Archive") await this.controller!.archiveSession(message.sessionID)
          }
          this.queueFullUpdate()
          break
        }
        case "ptyAction":
          await this.controller!.cancelPty(message.id)
          this.queueFullUpdate()
          break
        case "jobAction":
          this.requireKnown(message.sessionID)
          if (message.action === "open") await this.controller!.select(message.sessionID)
          else await this.controller!.backgroundChildSessions(message.sessionID)
          break
        case "artifactAction": {
          this.requireKnown(message.sessionID)
          const artifact = this.workbench.artifacts?.get(message.sessionID, message.artifactID)
          if (!artifact) throw new Error("Task artifact is no longer available")
          if (message.action === "archive") {
            this.workbench.artifacts!.archive(message.sessionID, message.artifactID, message.expectedRevision ?? artifact.revision)
          } else if (message.action === "delete") {
            const confirmed = await vscode.window.showWarningMessage("Delete this Workbench artifact metadata?", { modal: true, detail: "This does not delete the owning OpenCode session or its transcript." }, "Delete metadata")
            if (confirmed === "Delete metadata") this.workbench.artifacts!.remove(message.sessionID, message.artifactID, message.expectedRevision ?? artifact.revision)
          } else {
            await vscode.commands.executeCommand("opencodeWorkbench.taskArtifactAction", message)
          }
          this.queueFullUpdate()
          break
        }
        case "requestRecoveryPreview": {
          this.recoveryPreviews.invalidate(source)
          this.requireSelected(message.sessionID)
          const session = this.controller!.snapshot.sessions[message.sessionID]
          if (!session) throw new Error("OpenCode recovery preview is unavailable")
          await this.deliverRecoveryPreview(source, {
            sessionID: message.sessionID,
            status: session.status,
            messages: session.messages,
            changes: session.changes,
            intent: "recover",
            messageID: message.messageID,
            revertMessageID: session.info.revert?.messageID,
          })
          break
        }
        case "applyRecovery": {
          try {
            this.requireSelected(message.sessionID)
            const session = this.controller!.snapshot.sessions[message.sessionID]
            if (!session || !this.workbench.recovery) throw new Error("OpenCode recovery preview is unavailable")
            const delivered = this.recoveryPreviews.consume(source, (preview) => {
              const intent = message.mode === "redo" ? "redo" : "recover"
              const input: RecoveryPreviewInput = {
                sessionID: message.sessionID,
                status: session.status,
                messages: session.messages,
                changes: session.changes,
                intent,
                messageID: intent === "recover" ? message.messageID ?? preview.messageID : undefined,
                revertMessageID: session.info.revert?.messageID,
              }
              return { input, preview: this.workbench.recovery!.preview(input) }
            })
            const available = message.mode === "redo" ? delivered.canRedo : message.mode === "fork" ? delivered.canFork : delivered.canRevert
            if (!available) throw new Error("The selected recovery action was not available in the confirmed preview")
            if (message.mode === "redo") await this.controller!.redoSession(message.sessionID)
            else if (message.mode === "fork") await this.controller!.forkSession(message.sessionID, delivered.messageID)
            else await this.controller!.undoSession(message.sessionID, delivered.messageID)
          } catch (error) {
            this.recoveryPreviews.invalidate(source)
            throw error
          }
          break
        }
        case "healthAction": {
          if (message.action === "refresh") await this.controller?.refresh()
          else if (message.action === "reconnect") this.controller?.reconnect()
          else if (message.action === "logs") this.showLogs?.()
          else if (message.action === "trace") await this.workbench.openTrace?.()
          else {
            const health = this.workbench.health?.()
            if (health) await vscode.env.clipboard.writeText(JSON.stringify(health, null, 2))
          }
          break
        }
        case "evidenceAction":
          await vscode.commands.executeCommand("opencodeWorkbench.captureTaskEvidence")
          break
        case "workbenchAction":
          this.requireSelected(message.sessionID)
          if (message.action === "refresh-session") await this.controller!.refreshSessionData(message.sessionID)
          else if (message.action === "review") await vscode.commands.executeCommand("opencodeWorkbench.reviewChanges")
          else if (message.action === "walkthrough") await vscode.commands.executeCommand("opencodeWorkbench.generateWalkthrough")
          else await vscode.commands.executeCommand("opencodeWorkbench.compareModels")
          break
        case "browserContextAction":
          this.requireSelected(message.sessionID)
          await this.workbench.captureBrowserContext?.(message)
          break
        case "runAction": {
          const group = this.runGroups?.get(message.groupID)
          if (!group) throw new Error("Run group is no longer available")
          if (message.action === "refresh") await vscode.commands.executeCommand("opencodeWorkbench.refreshRunGroups")
          else if (message.action === "compare") await vscode.commands.executeCommand("opencodeWorkbench.compareRunResults", group.id)
          else if (message.action === "export-comparison") {
            if (!this.workbench.artifacts) throw new Error("Run comparison artifacts are unavailable")
            const content = exactRunComparisonMarkdown(group, this.workbench.artifacts.list(), {
              groupID: message.groupID,
              artifactID: message.comparisonArtifactID,
              revision: message.comparisonRevision,
            })
            const safeTitle = group.title.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "run-comparison"
            const target = await vscode.window.showSaveDialog({
              title: "Export Objective Run Comparison",
              defaultUri: this.workspaceRoot ? vscode.Uri.file(path.join(this.workspaceRoot, `${safeTitle}-comparison.md`)) : undefined,
              filters: { Markdown: ["md"] },
            })
            if (target) await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content))
          }
          else if (message.action === "fuse") await vscode.commands.executeCommand("opencodeWorkbench.fuseRuns", group.id)
          else {
            if (!("runID" in message)) throw new Error("Run action is missing its exact run identity")
            const run = group.runs.find((candidate) => candidate.id === message.runID)
            if (!run) throw new Error("Run is no longer available")
            const sourceAction = ["open", "diff", "review", "keep", "discard"].includes(message.action)
            if (sourceAction && (run.session.sessionID === "pending" || run.discarded)) throw new Error("This run source is no longer available")
            if (["keep", "discard"].includes(message.action) && run.retained) throw new Error("This run is already retained")
            if (message.action === "cancel") await this.multiRun?.cancel(group.id, run.id)
            else if (message.action === "retry") {
              const prompt = await vscode.window.showInputBox({ title: `Retry ${run.model}`, prompt: "Explicit retry instruction (source prompt bytes are not persisted)", value: "Continue the original task from the current worktree state. Diagnose the prior failure and complete the requested work.", validateInput: (value) => value.trim() ? undefined : "Enter a retry instruction" })
              if (prompt) await this.multiRun?.retry(group.id, run.id, prompt)
            }
            else if (message.action === "diff") await vscode.commands.executeCommand("opencodeWorkbench.openRunDiff", group.id, run.id)
            else if (message.action === "review") await vscode.commands.executeCommand("opencodeWorkbench.reviewChanges", run.session.directory, group.baseRef, run.session.sessionID)
            else if (message.action === "discard") await vscode.commands.executeCommand("opencodeWorkbench.discardRun", group.id, run.id)
            else if (message.action === "keep") {
              this.runGroups?.update(group.id, run.id, { retained: true })
              await this.runGroups?.flush()
              void vscode.window.showInformationMessage(`Kept ${run.model}; it is no longer offered as disposable in the Runs inspector.`)
            }
            else await vscode.commands.executeCommand("opencodeWorkbench.openRun", group.id, run.id)
          }
          this.queueFullUpdate()
          break
        }
        case "walkthroughAction":
          await vscode.commands.executeCommand("opencodeWorkbench.openWalkthroughStop", message.documentID, message.stopID)
          break
        case "send":
          this.requireSelected(message.sessionID)
          const composerPayload = this.composerPayloads.get(message.sessionID) ?? { revision: 0, attachments: [], pastedText: [] }
          if ((message.composerRevision ?? 0) !== composerPayload.revision) {
            await this.postTo(source, { type: "composerPayloadChanged", sessionID: message.sessionID, ...composerPayload })
            throw new Error("Composer attachments changed in another chat view; review them before sending")
          }
          const contextFiles = (message.contextIDs ?? []).map((id) => {
            const attachment = this.contextAttachments.get(id)
            if (!attachment || attachment.sessionID !== message.sessionID) throw new Error("Context attachment is no longer available")
            return attachment.file
          })
          const contextUrls = new Set(contextFiles.map((file) => file.url))
          const mentionedFiles = (await this.workspaceMentions(message.text)).filter((file) => !contextUrls.has(file.url))
          const files = [
            ...mentionedFiles,
            ...contextFiles,
            ...composerPayload.attachments.map((attachment) => ({
              type: "file" as const,
              mime: attachment.mime,
              filename: `${attachment.label} ${attachment.name}`.slice(0, 255),
              url: `data:${attachment.mime};base64,${attachment.data}`,
            })),
            ...composerPayload.pastedText.map((block, index) => ({
              type: "file" as const,
              mime: "text/plain",
              filename: `${block.label} pasted-text-${index + 1}.txt`.slice(0, 255),
              url: `data:text/plain;base64,${Buffer.from(block.text, "utf8").toString("base64")}`,
            })),
          ]
          const seenFiles = new Set<string>()
          const uniqueFiles = files.filter((file) => {
            const key = `${file.mime}\0${file.url}`
            if (seenFiles.has(key)) return false
            seenFiles.add(key)
            return true
          })
          const fileCharacters = uniqueFiles.reduce((total, file) => total + file.filename.length + file.mime.length + file.url.length, 0)
          if (uniqueFiles.length > PROMPT_ATTACHMENT_COUNT_LIMIT || fileCharacters > PROMPT_ATTACHMENT_CHARACTER_LIMIT) {
            throw new Error(`Combined workspace, context, and composer attachments exceed the ${PROMPT_ATTACHMENT_COUNT_LIMIT}-file prompt limit`)
          }
          const promptID = message.promptID!
          const receiptItems: ContextReceiptItem[] = [
            ...await Promise.all(mentionedFiles.map((file, index) => this.promptFileReceipt(file, `mention:${index}`))),
            ...(message.contextIDs ?? []).map((id) => {
              const attachment = this.contextAttachments.get(id)!
              return { id, label: attachment.summary.name, ...attachment.receipt }
            }),
            ...composerPayload.attachments.map((attachment) => ({ id: attachment.id, kind: "attachment" as const, label: attachment.label, bytes: attachment.size, contentHash: `sha256:${createHash("sha256").update(attachment.data).digest("hex")}` })),
            ...composerPayload.pastedText.map((block, index) => ({ id: `paste:${index}`, kind: "attachment" as const, label: block.label, bytes: Buffer.byteLength(block.text), contentHash: `sha256:${createHash("sha256").update(block.text).digest("hex")}` })),
          ]
          this.contextReceipts?.stage(message.sessionID, promptID, receiptItems, receiptItems.some((item) => item.truncated) ? "explicit" : "none")
          try {
            await this.controller!.send(message.text, message.agent, message.model, message.variant, uniqueFiles, this.controller!.mentionedAgents(message.text), promptID, message.delivery)
          } catch (error) {
            this.contextReceipts?.reject(promptID)
            throw error
          }
          if ((this.composerPayloads.get(message.sessionID)?.revision ?? 0) === composerPayload.revision) {
            const cleared = { revision: composerPayload.revision + 1, attachments: [] as InlineAttachment[], pastedText: [] as PastedTextBlock[] }
            this.composerPayloads.set(message.sessionID, cleared)
            await this.publishDirect({ type: "composerPayloadChanged", sessionID: message.sessionID, ...cleared })
          }
          for (const id of message.contextIDs ?? []) this.contextAttachments.delete(id)
          await this.publishContextAttachments(message.sessionID)
          break
        case "pickFiles":
          this.requireSelected(message.sessionID)
          await this.pickFiles(message.sessionID)
          break
        case "attachCurrentEditor":
          this.requireSelected(message.sessionID)
          await this.attachCurrentEditor(message.sessionID)
          break
        case "resolveDroppedUris":
          this.requireSelected(message.sessionID)
          await this.resolveDroppedUris(message.sessionID, message.uris)
          break
        case "searchFiles":
          this.requireSelected(message.sessionID)
          await this.searchFiles(message.sessionID, message.query, message.requestID, source)
          break
        case "removeContextAttachment": {
          this.requireSelected(message.sessionID)
          const attachment = this.contextAttachments.get(message.attachmentID)
          if (attachment?.sessionID === message.sessionID) this.contextAttachments.delete(message.attachmentID)
          await this.publishContextAttachments(message.sessionID)
          break
        }
        case "openContextAttachment": {
          this.requireSelected(message.sessionID)
          const attachment = this.contextAttachments.get(message.attachmentID)
          if (!attachment || attachment.sessionID !== message.sessionID) throw new Error("Context attachment is no longer available")
          const source = attachment.file.url.startsWith("file:") ? attachment.file.url : attachment.sourceUri ?? attachment.file.url
          const uri = vscode.Uri.parse(source, true)
          if (uri.scheme === "file") {
            const info = await stat(uri.fsPath)
            if (info.isDirectory()) await vscode.commands.executeCommand("revealInExplorer", uri)
            else if (usesCustomEditor(uri)) await vscode.commands.executeCommand("vscode.open", uri, { preview: true })
            else {
              const document = await vscode.workspace.openTextDocument(uri.with({ query: "", fragment: "" }))
              const editor = await vscode.window.showTextDocument(document, { preview: true })
              const params = new URLSearchParams(uri.query)
              const start = Number(params.get("start"))
              const end = Number(params.get("end"))
              if (Number.isSafeInteger(start) && start >= 1) {
                const first = Math.min(start - 1, Math.max(0, document.lineCount - 1))
                const last = Number.isSafeInteger(end) && end >= start ? Math.min(end - 1, Math.max(0, document.lineCount - 1)) : first
                const range = new vscode.Range(first, 0, last, document.lineAt(last).text.length)
                editor.selection = new vscode.Selection(range.start, range.end)
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
              }
            }
          } else if (uri.scheme === "untitled") await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true })
          else {
            const content = dataText(attachment.file.url, attachment.file.mime)
            if (content !== undefined) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content }), { preview: true })
            else if (attachment.sourceUri) await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(attachment.sourceUri, true), { preview: true })
            else throw new Error("This context item does not have a previewable source")
          }
          break
        }
        case "contextReceiptAction": {
          this.requireSelected(message.sessionID)
          const receipt = this.contextReceipts?.get(message.receiptID)
          const directory = this.controller!.snapshot.sessions[message.sessionID]?.info.directory
          if (!receipt || !directory) throw new Error("Context receipt source is no longer available")
          const inspected = await inspectContextReceiptSource({
            sessionID: message.sessionID,
            directory,
            receipt,
            itemID: message.itemID,
          })
          if (inspected.availability !== "available" || !inspected.uri) throw new Error("This context source is unavailable; only its admitted metadata remains")
          if (inspected.stale) {
            const confirmed = await vscode.window.showWarningMessage(
              "This context source changed after it was sent to OpenCode.",
              { modal: true, detail: "Opening shows the current file, not the exact admitted revision." },
              "Open current source",
            )
            if (confirmed !== "Open current source") break
          }
          const uri = vscode.Uri.parse(inspected.uri, true)
          if (uri.scheme === "http" || uri.scheme === "https") {
            if (!await vscode.env.openExternal(uri)) throw new Error("VS Code did not open the context source")
            break
          }
          if (uri.scheme !== "file") throw new Error("This context source cannot be opened")
          if (usesCustomEditor(uri)) {
            await vscode.commands.executeCommand("vscode.open", uri, { preview: true })
            break
          }
          const document = await vscode.workspace.openTextDocument(uri)
          const editor = await vscode.window.showTextDocument(document, { preview: true })
          if (inspected.range && document.lineCount) {
            const firstLine = Math.min(inspected.range.startLine - 1, document.lineCount - 1)
            const lastLine = Math.min(inspected.range.endLine - 1, document.lineCount - 1)
            const firstColumn = Math.min(inspected.range.startColumn - 1, document.lineAt(firstLine).text.length)
            const lastColumn = Math.min(inspected.range.endColumn - 1, document.lineAt(lastLine).text.length)
            const range = new vscode.Range(firstLine, firstColumn, lastLine, lastColumn)
            editor.selection = new vscode.Selection(range.start, range.end)
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
          }
          break
        }
        case "attachWorkspacePath":
          this.requireSelected(message.sessionID)
          await this.addWorkspaceAttachments(message.sessionID, [await this.workspaceFile(message.path)])
          break
        case "attachResource": {
          this.requireSelected(message.sessionID)
          const file = this.controller!.resourceAttachment(message.uri)
          if (!file) throw new Error("MCP resource is no longer available")
          const payload = dataUrlPayload(file.url)
          this.storeContextAttachment(
            message.sessionID,
            `resource:${message.uri}`,
            file,
            { name: file.filename, detail: message.uri.slice(0, 255), kind: "resource" },
            message.uri,
            { kind: "mcp-resource", uri: message.uri, bytes: payload?.byteLength, contentHash: payload && receiptHash(payload) },
          )
          await this.publishContextAttachments(message.sessionID)
          break
        }
        case "openPlan": {
          this.requireSelected(message.sessionID)
          if (!this.workspaceRoot) throw new Error("Open a workspace before opening its plan")
          const name = this.controller!.planFileName(message.sessionID)
          if (!name) throw new Error("This session has no native plan file name")
          const root = await realpath(this.workspaceRoot)
          const candidate = await realpath(path.join(root, ".opencode", "plans", name))
          const relative = path.relative(root, candidate)
          if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plan file is outside the current workspace")
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(candidate)), { preview: false })
          break
        }
        case "mcpAction":
          this.requireSelected(message.sessionID)
          await this.controller!.manageMcp(message.sessionID, message.name, message.action)
          break
        case "abort":
          this.requireSelected(message.sessionID)
          await this.controller!.abortSelected()
          break
        case "planTask":
          await vscode.commands.executeCommand("opencodeWorkbench.planTask")
          break
        case "createSession":
          if (!this.controller) throw new Error("Open a folder to create a session")
          if (message.submit) await this.controller.createSessionWithPrompt(message.draft!)
          else await this.controller.createSession(undefined, message.draft)
          break
        case "selectSession":
          if (!this.controller || !Object.hasOwn(this.controller.snapshot.sessions, message.sessionID)) throw new Error("Unknown OpenCode session")
          await this.controller.select(message.sessionID)
          break
        case "removeQueued":
          this.requireSelected(message.sessionID)
          this.controller!.removeQueued(message.sessionID, message.promptID)
          break
        case "editQueued": {
          this.requireSelected(message.sessionID)
          const prompt = this.controller!.snapshot.sessions[message.sessionID]?.queue.find((candidate) => candidate.id === message.promptID)
          if (!prompt) throw new Error("Queued prompt is no longer available")
          const text = await vscode.window.showInputBox({ title: "Edit queued message", value: prompt.text, prompt: "Attachments and delivery settings are preserved.", ignoreFocusOut: true })
          if (text !== undefined) this.controller!.editQueued(message.sessionID, message.promptID, text)
          break
        }
        case "reorderQueue":
          this.requireSelected(message.sessionID)
          this.controller!.reorderQueue(message.sessionID, message.promptIDs)
          break
        case "sendQueuedNow":
          this.requireSelected(message.sessionID)
          await this.controller!.sendQueuedNow(message.sessionID, message.promptID)
          break
        case "respondPermission":
          this.requireInteractiveSession(message.sessionID)
          await this.controller!.respondPermission(message.requestID, message.response, message.sessionID, message.protocol, message.feedback, message.scope)
          break
        case "respondQuestion":
          this.requireInteractiveSession(message.sessionID)
          await this.controller!.respondQuestion(message.requestID, message.answers, message.sessionID)
          break
        case "rejectQuestion":
          this.requireInteractiveSession(message.sessionID)
          await this.controller!.rejectQuestion(message.requestID, message.sessionID)
          break
        case "openFile":
          this.requireSelected(message.sessionID)
          await this.openWorkspaceFile(message.file, message.line, message.column, message.endLine, message.endColumn)
          break
        case "openPatch": {
          this.requireSelected(message.sessionID)
          const change = this.controller!.snapshot.sessions[message.sessionID]?.changes.find((candidate) => candidate.file === message.file)
          if (!change?.patch) throw new Error("No patch is available for this file")
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "diff", content: change.patch }), { preview: true })
          break
        }
        case "sessionAction":
          if (["rename", "delete", "fork"].includes(message.action)) this.requireKnown(message.sessionID)
          else this.requireSelected(message.sessionID)
          await this.handleSessionAction(message.sessionID, message.action, source, message.messageID)
          break
        case "setAutoApproval":
          if (!this.controller) throw new Error("Open a folder to change approval behavior")
          this.requireKnown(message.sessionID)
          this.controller.setAutoApproval(message.sessionID, message.enabled)
          break
        case "openInEditor":
          this.openInEditor(message.tab)
          break
        case "openInSidebar":
          await this.openInSidebar()
          break
        case "navigateBack":
          await vscode.commands.executeCommand("workbench.action.navigateBack")
          break
        case "loadOlderHistory":
          this.requireSelected(message.sessionID)
          await this.postTo(source, { type: "historyPage", page: this.controller!.historyPage(message.sessionID, message.beforeMessageID) })
          break
        case "refresh":
          if (!this.controller) throw new Error("Open a folder to refresh OpenCode")
          await this.controller.refresh()
          break
        case "openLogs":
          this.showLogs?.()
          break
        case "openHelp":
          await vscode.commands.executeCommand("opencodeWorkbench.openHelp")
          break
        case "openFolder":
          await vscode.commands.executeCommand("workbench.action.files.openFolder")
          break
        case "reloadWindow":
          if (this.controller?.hasActiveSessions()) throw new Error("Stop all active OpenCode sessions before reloading VS Code")
          await vscode.commands.executeCommand("workbench.action.reloadWindow")
          break
        case "openLink": {
          const url = new URL(message.url)
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP links can be opened")
          await vscode.env.openExternal(vscode.Uri.parse(url.toString()))
          break
        }
        case "copyText":
          await vscode.env.clipboard.writeText(message.text)
          vscode.window.setStatusBarMessage("OpenCode Workbench: Copied to clipboard", 2_000)
          break
      }
    } catch (error) {
      const message = errorText(error)
      this.reportError?.(`Webview request failed: ${message}`)
      if (rethrow) throw error
      await this.postTo(source, { type: "error", message })
    }
  }

  private snapshot() {
    const snapshot = this.controller?.chatSnapshot() ?? { connected: false, connectionState: this.connectionError ? "failed" as const : "connecting" as const, sessions: [], agents: [], models: [] }
    const decorated = snapshot.session && this.contextReceipts
      ? { ...snapshot, session: { ...snapshot.session, contextReceipts: this.contextReceipts.forSession(snapshot.session.id) } }
      : snapshot
    const runGroups = this.runGroups?.list() ?? []
    const worktrees = this.worktrees?.journal().slice(-1_000) ?? []
    const runAttention: AttentionItem[] = runGroups.flatMap((group) => group.runs.flatMap((run): AttentionItem[] => {
      if (run.phase === "needs-input" && !run.discarded) return [{
        id: `run-input:${createHash("sha256").update(`${group.id}\0${run.id}`).digest("hex").slice(0, 32)}`,
        kind: "native-action",
        title: `Run needs input: ${run.model}`.slice(0, 1_024),
        detail: "Open the run worktree to answer its pending permission or question.",
        createdAt: run.startedAt ?? group.createdAt,
        target: { surface: "runs", itemID: run.id },
      } satisfies AttentionItem]
      if (run.phase !== "failed" || run.discarded) return []
      const worktreeFailure = group.isolation === "worktree" && !run.worktreeID
      const timestamp = run.completedAt ?? run.startedAt ?? group.createdAt
      return [{
        id: `run-failure:${createHash("sha256").update(`${group.id}\0${run.id}`).digest("hex").slice(0, 32)}`,
        kind: worktreeFailure ? "worktree-failure" : "run-failure",
        title: `${worktreeFailure ? "Worktree" : "Run"} failed: ${run.model}`.slice(0, 1_024),
        detail: run.error?.message.slice(0, 2_000),
        createdAt: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : group.createdAt,
        target: { surface: "runs", itemID: run.id },
      } satisfies AttentionItem]
    }))
    const runWorktreeIDs = new Set(runGroups.flatMap((group) => group.runs.flatMap((run) => run.worktreeID ? [run.worktreeID] : [])))
    const standaloneWorktreeAttention: AttentionItem[] = worktrees.flatMap((entry): AttentionItem[] => entry.phase === "failed" && !runWorktreeIDs.has(entry.id) ? [{
      id: `worktree-failure:${createHash("sha256").update(entry.id).digest("hex").slice(0, 32)}`,
      kind: "worktree-failure",
      title: `Worktree failed: ${entry.branch}`.slice(0, 1_024),
      detail: entry.error?.message.slice(0, 2_000),
      createdAt: entry.updatedAt,
      target: { surface: "runs", itemID: entry.id },
    }] : [])
    const baseAttention = decorated.attentionItems ?? []
    const supplementalLimit = Math.max(0, 500 - baseAttention.length)
    const attentionItems = [...baseAttention, ...[...runAttention, ...standaloneWorktreeAttention]
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, supplementalLimit)]
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, 500)
    const pins = new Set(this.workbench.sessionPresentation?.list().map((entry) => entry.sessionID) ?? [])
    const runBySession = new Map(runGroups.flatMap((group) => group.runs.flatMap((run) => run.session.sessionID === "pending" ? [] : [[run.session.sessionID, { group, run }] as const])))
    const worktreeByID = new Map(worktrees.map((entry) => [entry.id, entry]))
    const worktreeBySession = new Map(worktrees.flatMap((entry) => entry.sessionID ? [[entry.sessionID, entry] as const] : []))
    const sessions = decorated.sessions.map((session) => {
      const run = runBySession.get(session.id)?.run
      const worktree = run?.worktreeID ? worktreeByID.get(run.worktreeID) : undefined
      return {
        ...session,
        pinned: pins.has(session.id),
        tokens: session.id === decorated.session?.id ? decorated.session.context?.totalTokens ?? session.tokens : session.tokens,
        branch: worktree?.branch,
        worktree: worktree?.path,
      }
    })
    const lineage = decorated.lineage?.map((node) => {
      const match = runBySession.get(node.sessionID)
      const worktree = (match?.run.worktreeID ? worktreeByID.get(match.run.worktreeID) : undefined) ?? worktreeBySession.get(node.sessionID)
      return {
        ...node,
        relation: match ? "run" as const : node.relation,
        branch: worktree?.branch,
        worktree: worktree?.path,
        runGroupID: match?.group.id,
        runID: match?.run.id,
        worktreeID: match?.run.worktreeID ?? worktree?.id,
      }
    })
    this.workbench.sessionPresentation?.reconcile(sessions.map((session) => session.id))
    const selectedSessionID = decorated.session?.id
    const selectedArtifacts = selectedSessionID ? this.workbench.artifacts?.list(selectedSessionID) ?? [] : []
    const reviewFindings = selectedArtifacts
      .filter((artifact) => artifact.kind === "review" && artifact.lifecycle === "active")
      .flatMap((artifact) => artifact.kind === "review" ? artifact.payload.document.findings.map((finding) => ({
        sessionID: artifact.sessionID,
        artifactID: artifact.id,
        artifactRevision: artifact.revision,
        artifactUpdatedAt: artifact.updatedAt,
        stale: artifact.payload.stale,
        diffHash: artifact.payload.diffHash,
        findingID: finding.id,
        title: finding.title,
        detail: finding.detail,
        category: finding.category,
        severity: finding.severity,
        anchors: finding.anchors,
        disposition: artifact.payload.dispositions.find((entry) => entry.findingID === finding.id)?.state ?? "open" as const,
      })) : [])
      .sort((left, right) => right.artifactUpdatedAt - left.artifactUpdatedAt || left.findingID.localeCompare(right.findingID))
      .slice(0, 200)
    const comparisonGroups = new Set<string>()
    const runComparisons = (this.workbench.artifacts?.list() ?? [])
      .filter((artifact) => artifact.kind === "run-comparison" && artifact.lifecycle === "active")
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .flatMap((artifact) => {
        if (artifact.kind !== "run-comparison" || comparisonGroups.has(artifact.payload.groupID)) return []
        const group = runGroups.find((candidate) => candidate.id === artifact.payload.groupID)
        if (!group) return []
        const shapeChanged = group.runs.length !== artifact.payload.rows.length || !artifact.payload.rows.every((row) => group.runs.some((run) => run.id === row.runID && run.phase === row.status))
        const newestSourceUpdate = Math.max(group.createdAt, ...group.runs.flatMap((run) => [run.startedAt ?? 0, run.completedAt ?? 0, run.worktreeID ? worktreeByID.get(run.worktreeID)?.updatedAt ?? 0 : 0]))
        const active = group.runs.some((run) => ["pending", "preparing", "admitting", "working", "needs-input"].includes(run.phase))
        comparisonGroups.add(artifact.payload.groupID)
        return [{ artifactID: artifact.id, revision: artifact.revision, groupID: artifact.payload.groupID, rows: artifact.payload.rows, updatedAt: artifact.updatedAt, stale: shapeChanged || active || newestSourceUpdate > artifact.updatedAt }]
      })
      .slice(0, 20)
    const configured = {
      ...decorated,
      sessions,
      lineage,
      attentionItems,
      runGroups,
      worktrees,
      ptys: this.controller?.ptys(),
      walkthroughs: this.walkthroughs?.list(),
      artifacts: selectedSessionID ? selectedArtifacts.map(taskArtifactSummary) : undefined,
      reviewFindings: selectedSessionID ? reviewFindings : undefined,
      evidence: selectedSessionID ? this.workbench.evidence?.list({ sessionID: selectedSessionID }) : undefined,
      // Comparison snapshots are protocol-scoped to a selected OpenCode
      // session. During startup reconciliation there is briefly no selection;
      // omit the field instead of publishing an unanchored empty collection.
      runComparisons: this.workbench.artifacts && selectedSessionID ? runComparisons : undefined,
      health: this.workbench.health?.(),
      trace: this.workbench.trace?.(),
      composer: { enterBehavior: vscode.workspace.getConfiguration("opencodeWorkbench").get<"send" | "newline">("enterBehavior", "send") },
    }
    const complete = !configured.connected && this.connectionError ? { ...configured, connectionError: this.connectionError } : configured
    return projectChatSnapshotForWebview(complete)
  }

  private queueUpdate(update: ControllerUpdate): void {
    this.publishRemovedSessions()
    if (update.type === "draft") return
    this.recoveryPreviews.clear()
    const key = this.controller?.messageUpdateKey(update)
    if (key && !this.fullUpdatePending) this.pendingMessageUpdates.set(`${key.sessionID}\0${key.messageID}`, key)
    else {
      this.fullUpdatePending = true
      this.pendingMessageUpdates.clear()
    }
    this.updates.request()
  }

  private publishRemovedSessions(): void {
    const current = new Set(Object.keys(this.controller?.snapshot.sessions ?? {}))
    for (const sessionID of this.knownSessionIDs) {
      if (current.has(sessionID)) continue
      for (const [id, attachment] of this.contextAttachments) if (attachment.sessionID === sessionID) this.contextAttachments.delete(id)
      this.composerPayloads.delete(sessionID)
      this.draftRevisions.delete(sessionID)
      void this.publishDirect({ type: "sessionRemoved", sessionID })
    }
    this.knownSessionIDs = current
  }

  private async publishDirect(message: HostToWebviewMessage): Promise<void> {
    const publications: Promise<void>[] = []
    if (this.view) publications.push(this.postTo(this.view.webview, message))
    if (this.panel) publications.push(this.postTo(this.panel.webview, message))
    await Promise.all(publications)
  }

  private queueFullUpdate(): void {
    this.fullUpdatePending = true
    this.pendingMessageUpdates.clear()
    this.updates.request()
  }

  private nextUpdate(): HostToWebviewMessage | undefined {
    if (this.fullUpdatePending) {
      this.fullUpdatePending = false
      this.pendingMessageUpdates.clear()
      return { type: "snapshot", snapshot: this.snapshot() }
    }
    const keys = [...this.pendingMessageUpdates.values()]
    this.pendingMessageUpdates.clear()
    const patches = this.controller?.messagePatches(keys)
    return patches === undefined
      ? { type: "snapshot", snapshot: this.snapshot() }
      : patches.length ? { type: "messagePatches", patches } : undefined
  }

  private async workspaceFile(file: string): Promise<vscode.Uri> {
    if (!this.workspaceRoot) throw new Error("Open a workspace folder before opening changed files")
    const root = await realpath(this.workspaceRoot)
    const candidate = path.resolve(root, file)
    const relative = path.relative(root, candidate)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Changed file is outside the current workspace")
    let resolved: string
    try {
      resolved = await realpath(candidate)
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") ||
        !/^[A-Za-z0-9._ -]{1,255}$/.test(file)) throw error
      const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), `**/${file}`), "**/{.git,node_modules}/**", 2)
      if (matches.length !== 1) throw new Error(matches.length ? `Multiple workspace files match ${file}` : `Workspace file not found: ${file}`)
      resolved = await realpath(matches[0]!.fsPath)
    }
    const resolvedRelative = path.relative(root, resolved)
    if (!resolvedRelative || resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) throw new Error("Changed file resolves outside the current workspace")
    return vscode.Uri.file(resolved)
  }

  private async promptFileReceipt(file: PromptFilePart, id: string): Promise<ContextReceiptItem> {
    const base: ContextReceiptItem = { id, kind: "file", label: file.filename }
    if (file.url.startsWith("file:")) {
      const uri = vscode.Uri.parse(file.url, true)
      const source = uri.with({ query: "", fragment: "" })
      const params = new URLSearchParams(uri.query)
      const start = Number(params.get("start"))
      const end = Number(params.get("end"))
      try {
        const info = await stat(source.fsPath)
        return {
          ...base,
          kind: Number.isSafeInteger(start) && start >= 1 ? "selection" : "file",
          uri: source.toString(),
          range: Number.isSafeInteger(start) && start >= 1
            ? { startLine: start, startColumn: 1, endLine: Number.isSafeInteger(end) && end >= start ? end : start, endColumn: 1 }
            : undefined,
          revision: `${Math.trunc(info.mtimeMs)}:${info.size}`,
          bytes: info.isFile() ? info.size : undefined,
        }
      } catch {
        return { ...base, uri: source.toString() }
      }
    }
    const payload = dataUrlPayload(file.url)
    return payload ? { ...base, kind: "attachment", bytes: payload.byteLength, contentHash: receiptHash(payload) } : base
  }

  private async workspaceAttachment(uri: vscode.Uri, range?: vscode.Range): Promise<{ key: string; file: PromptFilePart; summary: Omit<ContextAttachmentSummary, "id">; receipt: Omit<ContextReceiptItem, "id" | "label"> }> {
    if (!this.controller?.canAttachWorkspaceFiles()) throw new Error("Workspace attachments require a local OpenCode server")
    if (!this.workspaceRoot || uri.scheme !== "file") throw new Error("Only files from the current workspace can be attached")
    const root = await realpath(this.workspaceRoot)
    const resolved = await realpath(uri.fsPath)
    const relative = path.relative(root, resolved)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Attachment is outside the current workspace")
    const normalized = relative.replaceAll(path.sep, "/")
    const info = await stat(resolved)
    const url = pathToFileURL(resolved)
    const lines = range ? this.selectionLines(range) : undefined
    if (range && !range.isEmpty) {
      const end = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1
      url.searchParams.set("start", String(range.start.line + 1))
      url.searchParams.set("end", String(end))
    }
    const kind = info.isDirectory() ? "folder" as const : range && !range.isEmpty ? "selection" as const : "file" as const
    return {
      key: `${resolved}\0${url.search}`,
      file: { type: "file", mime: info.isDirectory() ? "application/x-directory" : "text/plain", url: url.toString(), filename: path.basename(resolved) },
      summary: { name: path.basename(resolved), detail: lines ?? normalized, kind },
      receipt: {
        kind: range && !range.isEmpty ? "selection" : "file",
        uri: uri.toString(),
        range: range && !range.isEmpty ? receiptRange(range) : undefined,
        revision: `${Math.trunc(info.mtimeMs)}:${info.size}`,
        bytes: info.isFile() ? info.size : undefined,
      },
    }
  }

  private async pickFiles(sessionID: string): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, openLabel: "Attach" })
    if (!uris?.length) return
    await this.addWorkspaceAttachments(sessionID, uris.slice(0, 10))
  }

  private async attachCurrentEditor(sessionID: string): Promise<void> {
    const editor = this.lastEditor
    if (!vscode.window.activeTextEditor && vscode.window.activeNotebookEditor) await this.storeNotebookAttachment(sessionID, vscode.window.activeNotebookEditor)
    else if (editor && !editor.document.isClosed) await this.storeEditorAttachment(sessionID, editor)
    else {
      const document = this.currentTextDocument()
      if (document) await this.storeDocumentAttachment(sessionID, document)
      else throw new Error("No active text editor or notebook")
    }
    await this.publishContextAttachments(sessionID)
  }

  private async storeNotebookAttachment(sessionID: string, editor: vscode.NotebookEditor): Promise<void> {
    const notebook = editor.notebook
    if (notebook.uri.scheme === "file") {
      if (!this.workspaceRoot) throw new Error("Open a workspace before attaching a notebook")
      const root = await realpath(this.workspaceRoot)
      const resolved = await realpath(notebook.uri.fsPath)
      const relative = path.relative(root, resolved)
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Notebook is outside the current workspace")
    } else if (notebook.uri.scheme !== "untitled") throw new Error("Only workspace and untitled notebooks can be attached")
    const selected = new Set<number>()
    let selectionTruncated = false
    for (const range of editor.selections) {
      for (let index = range.start; index < range.end; index += 1) {
        if (selected.size < 50) selected.add(index)
        else selectionTruncated = true
      }
    }
    const indexes = selected.size ? [...selected] : Array.from({ length: Math.min(20, notebook.cellCount) }, (_, index) => index)
    const chunks: string[] = []
    let bytesUsed = 0
    let sizeTruncated = false
    for (const index of indexes) {
      const cell = notebook.cellAt(index)
      const source = cell.document.getText()
      const chunk = `Cell ${index + 1} (${cell.document.languageId})\n${source}`
      const nextBytes = Buffer.byteLength(chunk, "utf8") + (chunks.length ? Buffer.byteLength("\n\n---\n\n") : 0)
      if (bytesUsed + nextBytes > 750_000) {
        sizeTruncated = true
        break
      }
      chunks.push(chunk)
      bytesUsed += nextBytes
    }
    if (!chunks.length) throw new Error("Notebook context is empty or exceeds Workbench limits")
    const text = chunks.join("\n\n---\n\n")
    const name = (path.basename(notebook.uri.fsPath) || "Untitled notebook").slice(0, 255)
    const bytes = Buffer.from(text, "utf8")
    const truncated = selectionTruncated || (!selected.size && notebook.cellCount > indexes.length) || sizeTruncated
    this.storeContextAttachment(sessionID, `notebook:${notebook.uri}:${notebook.version}:${indexes.join(",")}`, {
      type: "file",
      mime: "text/plain",
      url: `data:text/plain;base64,${bytes.toString("base64")}`,
      filename: `${name}.txt`.slice(0, 255),
    }, { name, detail: `${chunks.length} cell${chunks.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`, kind: "notebook" }, notebook.uri.toString(), {
      kind: "notebook",
      uri: notebook.uri.toString(),
      revision: String(notebook.version),
      contentHash: receiptHash(bytes),
      bytes: bytes.byteLength,
      truncated,
    })
  }

  private async storeEditorAttachment(sessionID: string, editor: vscode.TextEditor, useSelection = true): Promise<void> {
    await this.storeDocumentAttachment(sessionID, editor.document, useSelection ? editor.selection : undefined)
  }

  private async storeDocumentAttachment(sessionID: string, document: vscode.TextDocument, selection?: vscode.Selection): Promise<void> {
    if (document.isClosed) throw new Error("Current editor is no longer open")
    if (document.uri.scheme === "file") {
      if (!this.workspaceRoot) throw new Error("Open a workspace before attaching file-backed editor context")
      const root = await realpath(this.workspaceRoot)
      const resolved = await realpath(document.uri.fsPath)
      const relative = path.relative(root, resolved)
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Editor context is outside the current workspace")
    } else if (!document.isUntitled) throw new Error("Only workspace files and untitled buffers can be attached")
    if (document.isUntitled || document.isDirty || document.uri.scheme !== "file") {
      const selected = Boolean(selection && !selection.isEmpty)
      const text = document.getText(selected ? selection : undefined)
      const bytes = Buffer.from(text, "utf8")
      if (!bytes.length) throw new Error("Current editor context is empty")
      if (bytes.length > 1_000_000) throw new Error("Current editor context exceeds 1 MB")
      const name = (path.basename(document.fileName) || "Untitled").slice(0, 255)
      this.storeContextAttachment(sessionID, `buffer:${document.uri}:${document.version}:${selected ? `${selection!.start.line}:${selection!.start.character}-${selection!.end.line}:${selection!.end.character}` : "all"}`, {
        type: "file",
        mime: "text/plain",
        url: `data:text/plain;base64,${bytes.toString("base64")}`,
        filename: name,
      }, { name, detail: selected ? this.selectionLines(selection!) ?? "Selection" : "Unsaved buffer", kind: selected ? "selection" : "buffer" }, document.uri.toString(), {
        kind: selected ? "selection" : "unsaved-buffer",
        uri: document.uri.toString(),
        range: selected ? receiptRange(selection!) : undefined,
        revision: String(document.version),
        contentHash: receiptHash(bytes),
        bytes: bytes.byteLength,
      })
      return
    }
    const attachment = await this.workspaceAttachment(document.uri, selection)
    this.storeContextAttachment(sessionID, attachment.key, attachment.file, attachment.summary, document.uri.toString(), attachment.receipt)
  }

  private async resolveDroppedUris(sessionID: string, values: string[]): Promise<void> {
    const uris: vscode.Uri[] = []
    for (const value of values.slice(0, 10)) {
      const uri = vscode.Uri.parse(value, true)
      if (uri.scheme !== "file" && uri.scheme !== "untitled") continue
      const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === uri.toString())
      const document = editor?.document ?? vscode.workspace.textDocuments.find((candidate) => !candidate.isClosed && candidate.uri.toString() === uri.toString())
      if (document && (document.isDirty || document.isUntitled || uri.scheme !== "file")) await this.storeDocumentAttachment(sessionID, document)
      else if (uri.scheme === "file") uris.push(uri)
    }
    if (uris.length) {
      for (const uri of uris) {
        const attachment = await this.workspaceAttachment(uri)
        this.storeContextAttachment(sessionID, attachment.key, attachment.file, attachment.summary, uri.toString(), attachment.receipt)
      }
    }
    await this.publishContextAttachments(sessionID)
  }

  private storeContextAttachment(
    sessionID: string,
    key: string,
    file: PromptFilePart,
    summary: Omit<ContextAttachmentSummary, "id">,
    sourceUri?: string,
    receipt?: Omit<ContextReceiptItem, "id" | "label">,
  ): void {
    if ([...this.contextAttachments.values()].some((attachment) => attachment.sessionID === sessionID && attachment.key === key)) return
    if (this.contextSummaries(sessionID).length >= 20) throw new Error("This prompt already has 20 context attachments")
    const id = randomUUID()
    const payload = dataUrlPayload(file.url)
    const kind = summary.kind === "selection" ? "selection" : summary.kind === "buffer" ? "unsaved-buffer" : summary.kind === "notebook" ? "notebook" : summary.kind === "resource" ? "mcp-resource" : "file"
    this.contextAttachments.set(id, {
      sessionID,
      key,
      file,
      summary: { id, ...summary },
      sourceUri,
      receipt: receipt ?? { kind, uri: sourceUri, bytes: payload?.byteLength, contentHash: payload && receiptHash(payload) },
    })
  }

  private async addWorkspaceAttachments(sessionID: string, uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      const attachment = await this.workspaceAttachment(uri)
      this.storeContextAttachment(sessionID, attachment.key, attachment.file, attachment.summary, uri.toString(), attachment.receipt)
    }
    await this.publishContextAttachments(sessionID)
  }

  async attachResources(uris: vscode.Uri[]): Promise<void> {
    const sessionID = this.controller?.snapshot.selectedID
    if (!sessionID) throw new Error("Create or select an OpenCode session first")
    const workspace: vscode.Uri[] = []
    for (const uri of uris.slice(0, 20)) {
      if (uri.scheme === "untitled") {
        const document = vscode.workspace.textDocuments.find((candidate) => !candidate.isClosed && candidate.uri.toString() === uri.toString())
        if (!document) throw new Error("Untitled editor is no longer open")
        await this.storeDocumentAttachment(sessionID, document)
      } else workspace.push(uri)
    }
    if (workspace.length) await this.addWorkspaceAttachments(sessionID, workspace)
    else await this.publishContextAttachments(sessionID)
  }

  private async searchFiles(sessionID: string, query: string, requestID: number, source: vscode.Webview): Promise<void> {
    if (!this.workspaceFiles || this.workspaceFiles.expiresAt < Date.now()) {
      if (!this.workspaceRoot) throw new Error("Open a workspace before searching files")
      const root = await realpath(this.workspaceRoot)
      const candidates = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), "**/*"), "**/{.git,.cache,.local,.npm,.cargo,.rustup,node_modules,.gradle,build,dist}/**", 10_000)
      const files = candidates.map((uri) => path.relative(root, uri.fsPath).replaceAll(path.sep, "/"))
      this.workspaceFiles = {
        expiresAt: Date.now() + 15_000,
        index: prepareFzf(workspaceSearchPaths(files)),
      }
    }
    const files = rankPreparedFzf(query, this.workspaceFiles.index)
    await this.postTo(source, { type: "fileSuggestions", sessionID, requestID, files })
  }

  private async workspaceMentions(text: string): Promise<PromptFilePart[]> {
    if (/@<[^>\r\n]+>/.test(text) && !this.controller?.canAttachWorkspaceFiles()) {
      throw new Error("Workspace references require a local OpenCode server")
    }
    const files: PromptFilePart[] = []
    const seen = new Set<string>()
    const add = async (rawValue: string, required: boolean): Promise<void> => {
      const raw = rawValue.trim()
      const range = /#(\d+)(?:-(\d+))?$/.exec(raw)
      const file = range ? raw.slice(0, range.index) : raw
      if (!file || seen.has(raw) || files.length >= 10) return
      let uri: vscode.Uri
      try {
        uri = await this.workspaceFile(file)
      } catch (error) {
        if (required) throw error
        return
      }
      const info = await stat(uri.fsPath)
      const url = pathToFileURL(uri.fsPath)
      if (range) {
        url.searchParams.set("start", range[1]!)
        url.searchParams.set("end", range[2] ?? range[1]!)
      }
      files.push({ type: "file", mime: info.isDirectory() ? "application/x-directory" : "text/plain", url: url.toString(), filename: path.basename(uri.fsPath) })
      seen.add(raw)
    }
    for (const match of text.matchAll(/@<([^>\r\n]+)>/g)) await add(match[1]!, true)
    for (const match of text.matchAll(/(?:^|[\s(])@([A-Za-z0-9._~/-]+(?:#\d+(?:-\d+)?)?)/g)) {
      await add(match[1]!, false)
    }
    return files
  }

  private async openWorkspaceFile(file: string, line?: number, column?: number, endLine?: number, endColumn?: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(await this.workspaceFile(file))
    const editor = await vscode.window.showTextDocument(document)
    if (line === undefined) return
    const targetLine = Math.min(Math.max(0, line - 1), Math.max(0, document.lineCount - 1))
    const targetColumn = Math.min(Math.max(0, (column ?? 1) - 1), document.lineAt(targetLine).text.length)
    const position = new vscode.Position(targetLine, targetColumn)
    const finalLine = endLine === undefined ? targetLine : Math.min(Math.max(targetLine, endLine - 1), Math.max(0, document.lineCount - 1))
    const finalColumn = endLine === undefined
      ? targetColumn
      : Math.min(Math.max(0, endColumn === undefined ? document.lineAt(finalLine).text.length : endColumn - 1), document.lineAt(finalLine).text.length)
    const finalPosition = new vscode.Position(finalLine, finalColumn)
    editor.selection = new vscode.Selection(position, finalPosition)
    editor.revealRange(new vscode.Range(position, finalPosition), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  private async handleSessionAction(
    sessionID: string,
    action: Extract<WebviewToHostMessage, { type: "sessionAction" }>["action"],
    source: vscode.Webview,
    messageID?: string,
  ): Promise<void> {
    const controller = this.controller!
    const session = controller.snapshot.sessions[sessionID]
    if (!session) throw new Error("Unknown OpenCode session")
    if (action === "rename") {
      const title = await vscode.window.showInputBox({
        title: "Rename OpenCode session",
        value: session.info.title,
        validateInput: (value) => value.trim() ? undefined : "Enter a session title",
      })
      if (title !== undefined) await controller.renameSession(sessionID, title)
      return
    }
    if (action === "delete") {
      const choice = await vscode.window.showWarningMessage(
        `Delete "${session.info.title || sessionID}"?`,
        { modal: true, detail: "This permanently deletes the OpenCode session and its transcript." },
        "Delete",
      )
      if (choice === "Delete") await controller.deleteSession(sessionID)
      return
    }
    if (action === "fork") {
      await controller.forkSession(sessionID, messageID)
      return
    }
    if (action === "undo") {
      await this.deliverRecoveryPreview(source, { sessionID, status: session.status, messages: session.messages, changes: session.changes, intent: "recover", revertMessageID: session.info.revert?.messageID })
      return
    }
    if (action === "redo") {
      await this.deliverRecoveryPreview(source, { sessionID, status: session.status, messages: session.messages, changes: session.changes, intent: "redo", revertMessageID: session.info.revert?.messageID })
      return
    }
    if (action === "retry") {
      await controller.retrySession(sessionID, messageID)
      return
    }
    if (action === "compact") {
      await controller.compactSession(sessionID)
      return
    }
    if (action === "share") {
      const choice = await vscode.window.showWarningMessage(
        "Share this OpenCode session publicly?",
        { modal: true, detail: "Anyone with the generated link can read the shared transcript. Review it for secrets before continuing." },
        "Share publicly",
      )
      if (choice !== "Share publicly") return
      const url = await controller.shareSession(sessionID)
      if (url) {
        await vscode.env.clipboard.writeText(url)
      }
      return
    }
    if (action === "unshare") {
      await controller.unshareSession(sessionID)
      return
    }
    if (action === "copyLast") {
      const last = controller.chatSnapshot().session?.messages.slice().reverse().find((entry) => entry.info.role === "assistant")
      const text = last?.parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n\n")
      if (!text) throw new Error("This session has no assistant response to copy")
      await vscode.env.clipboard.writeText(text)
      return
    }
    if (action === "copyTranscript") {
      await vscode.env.clipboard.writeText(this.sessionMarkdown(sessionID))
      return
    }
    if (action === "export") await this.exportSession(sessionID)
  }

  private async openInSidebar(): Promise<void> {
    this.panel?.dispose()
    await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
  }

  private sessionMarkdown(sessionID: string): string {
    const session = this.controller?.chatSnapshot().session
    if (!session || session.id !== sessionID) throw new Error("Select the session before copying or exporting it")
    const blocks = [`# ${session.title}`]
    for (const entry of session.messages) {
      blocks.push(`## ${entry.info.role === "user" ? "User" : "OpenCode"}`)
      for (const part of entry.parts) {
        if ((part.type === "text" || part.type === "reasoning") && part.text) {
          blocks.push(part.type === "reasoning" ? `<details>\n<summary>Reasoning</summary>\n\n${part.text}\n\n</details>` : part.text)
        } else if (part.type === "tool") {
          blocks.push(`\`\`\`text\n${part.tool || "tool"} [${part.state?.status || "unknown"}]\n${part.state?.output || part.state?.error || ""}\n\`\`\``)
        }
      }
    }
    return `${blocks.join("\n\n")}\n`
  }

  private async exportSession(sessionID: string): Promise<void> {
    const session = this.controller?.chatSnapshot().session
    if (!session || session.id !== sessionID) throw new Error("Select the session before exporting it")
    const safeTitle = session.title.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "opencode-session"
    const target = await vscode.window.showSaveDialog({
      title: "Export OpenCode transcript",
      defaultUri: this.workspaceRoot ? vscode.Uri.file(path.join(this.workspaceRoot, `${safeTitle}.md`)) : undefined,
      filters: { Markdown: ["md"] },
    })
    if (!target) return
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(this.sessionMarkdown(sessionID)))
  }

  private async publishUpdate(message: HostToWebviewMessage | undefined): Promise<void> {
    if (!message) return
    if (message.type === "snapshot" && this.view) {
      const snapshot = message.snapshot
      this.view.description = snapshot.session?.title
      const attention = snapshot.attentionItems?.length ?? 0
      this.view.badge = attention ? { value: attention, tooltip: `${attention} OpenCode item${attention === 1 ? " needs" : "s need"} attention` } : undefined
    }
    if (message.type === "snapshot" && this.panel) this.panel.title = message.snapshot.session?.title ? `OpenCode · ${message.snapshot.session.title}` : "OpenCode Task Workbench"
    const publish = async (webview: vscode.Webview): Promise<void> => {
      await this.postTo(webview, message)
      if (message.type === "snapshot") await this.postEditorContext(webview)
    }
    const shouldPublish = (webview: vscode.Webview, visible: boolean): boolean => {
      const surfaceID = this.surfaceIDs.get(webview)
      return visible || Boolean(surfaceID && this.protocol.isV2(surfaceID))
    }
    await Promise.all([
      this.view && shouldPublish(this.view.webview, this.view.visible) ? publish(this.view.webview) : undefined,
      this.panel && shouldPublish(this.panel.webview, this.panel.visible) ? publish(this.panel.webview) : undefined,
    ].filter(Boolean))
  }

  dispose(): void {
    this.updates.dispose()
    this.recoveryPreviews.clear()
    for (const surfaceID of this.surfaceIDs.values()) this.protocol.detach(surfaceID)
    this.surfaceIDs.clear()
    // VS Code owns the editor panel. Keeping it alive allows the registered
    // WebviewPanelSerializer to restore it with the newly activated extension
    // after a window reload or extension update.
    this.disposeAll(this.panelDisposables)
    this.disposeAll(this.viewDisposables)
    this.disposeAll(this.disposables)
    this.contextAttachments.clear()
    this.composerPayloads.clear()
    this.view = undefined
    this.panel = undefined
  }
}
