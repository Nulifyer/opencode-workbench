import { randomBytes, randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import * as vscode from "vscode"
import type { ContextAttachmentSummary, EditorContextSummary, HostToWebviewMessage, InlineAttachment, PastedTextBlock, WebviewToHostMessage } from "@opencode-workbench/shared"
import { parseWebviewMessage, PROMPT_ATTACHMENT_CHARACTER_LIMIT, PROMPT_ATTACHMENT_COUNT_LIMIT } from "@opencode-workbench/shared"
import type { PromptFilePart } from "../opencode-client.js"
import type { ControllerUpdate, SessionController } from "../session-controller.js"
import { prepareFzf, rankPreparedFzf, workspaceSearchPaths, type PreparedFzfIndex } from "../fuzzy.js"
import { LatestUpdatePump } from "../latest-update-pump.js"

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
  rail: icon("M2 2.5h12v11H2v-11Zm1.5 1.5v8h6V4h-6Zm7.5 0v8h1.5V4H11Z"),
  send: icon("M2.2 2.4 14 8 2.2 13.6 3.5 8.8 9 8 3.5 7.2 2.2 2.4Z"),
  stop: icon("M4 4h8v8H4V4Z"),
  more: icon("M3 6.75A1.25 1.25 0 1 1 3 9.25a1.25 1.25 0 0 1 0-2.5Zm5 0A1.25 1.25 0 1 1 8 9.25a1.25 1.25 0 0 1 0-2.5Zm5 0A1.25 1.25 0 1 1 13 9.25a1.25 1.25 0 0 1 0-2.5Z"),
  back: icon("m9.8 3.2 1 1L7 8l3.8 3.8-1 1L5 8l4.8-4.8Z"),
}

interface StoredContextAttachment {
  sessionID: string
  key: string
  file: PromptFilePart
  summary: ContextAttachmentSummary
  sourceUri?: string
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
  private lastEditor = vscode.window.activeTextEditor
  private lastDocumentUri = vscode.window.activeTextEditor?.document.uri
  private editorContextSignature = ""
  private workspaceFiles?: { expiresAt: number; index: PreparedFzfIndex }
  private fullUpdatePending = false
  private readonly draftRevisions = new Map<string, number>()
  private knownSessionIDs = new Set<string>()

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller?: SessionController,
    private readonly workspaceRoot?: string,
    private connectionError?: string,
    private readonly showLogs?: () => void,
    private readonly reportError?: (message: string) => void,
  ) {
    this.knownSessionIDs = new Set(Object.keys(controller?.snapshot.sessions ?? {}))
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
      this.queueUpdate(update)
    })
    if (subscription) this.disposables.push(subscription)
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.lastEditor = editor
          this.lastDocumentUri = editor.document.uri
        }
        void this.publishEditorContext()
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === this.lastEditor) void this.publishEditorContext()
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.lastEditor?.document === document) {
          this.lastEditor = vscode.window.visibleTextEditors.find((editor) => editor.document !== document)
          this.lastDocumentUri = this.lastEditor?.document.uri
          void this.publishEditorContext()
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === this.lastEditor?.document) void this.publishEditorContext()
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === this.lastEditor?.document) void this.publishEditorContext()
      }),
      vscode.window.onDidChangeActiveNotebookEditor(() => void this.publishEditorContext()),
      vscode.window.onDidChangeNotebookEditorSelection(() => void this.publishEditorContext()),
    )
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeAll(this.viewDisposables)
    this.view = view
    this.configure(view.webview, "sidebar")
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((raw) => void this.handleMessage(raw, view.webview)),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.queueFullUpdate()
          void this.postEditorContext(view.webview)
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined
        this.disposeAll(this.viewDisposables)
      }),
    )
  }

  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal()
      void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar")
      return
    }
    const panel = vscode.window.createWebviewPanel(
      "opencodeWorkbench.chatEditor",
      this.controller?.chatSnapshot().session?.title || "OpenCode Chat",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] },
    )
    this.attachEditorPanel(panel)
    void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar")
  }

  restoreEditor(panel: vscode.WebviewPanel): void {
    this.attachEditorPanel(panel)
  }

  private attachEditorPanel(panel: vscode.WebviewPanel): void {
    this.disposeAll(this.panelDisposables)
    this.panel = panel
    this.configure(panel.webview, "editor")
    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((raw) => void this.handleMessage(raw, panel.webview)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) {
          this.queueFullUpdate()
          void this.postEditorContext(panel.webview)
        }
      }),
      panel.onDidDispose(() => {
        if (this.panel === panel) this.panel = undefined
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

  private configure(webview: vscode.Webview, mode: "sidebar" | "editor"): void {
    const media = vscode.Uri.joinPath(this.extensionUri, "media")
    webview.options = { enableScripts: true, localResourceRoots: [media] }
    webview.html = this.html(webview, mode)
  }

  private html(webview: vscode.Webview, mode: "sidebar" | "editor"): string {
    const nonce = randomBytes(18).toString("base64")
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"))
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>OpenCode Chat</title>
</head>
<body data-mode="${mode}">
  <div class="app-shell">
    <header class="chat-header">
      <button id="back-parent" class="icon-action" type="button" title="Back to parent session" aria-label="Back to parent session" hidden>${ICONS.back}</button>
      <button id="session-current" class="session-current" type="button" aria-haspopup="dialog" aria-expanded="false" title="Search session history">
        <span class="session-title" id="session-title">No session</span><span class="session-state" id="session-state"></span>${ICONS.chevron}
      </button>
      <span id="connection" class="connection offline" role="status" hidden>Offline</span>
      <div class="header-actions">
        <button id="create-header" class="icon-action" type="button" title="New session" aria-label="New session">${ICONS.add}</button>
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
      <button type="button" role="menuitem" data-context-action="rename">Rename</button>
      <button type="button" role="menuitem" data-context-action="fork">Fork session</button>
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

    <div class="work-area">
      <section class="conversation-column">
        <section id="notice" class="notice" role="alert" hidden>
          <div class="notice-copy"><strong id="notice-title"></strong><p id="notice-message"></p></div>
          <div class="notice-actions"><button id="notice-retry" type="button">Retry</button><button id="notice-logs" type="button">Open Logs</button><button id="notice-copy" type="button">Copy details</button><button id="notice-dismiss" type="button" aria-label="Dismiss message">×</button></div>
        </section>
        <main id="messages" role="log" aria-label="OpenCode conversation"></main>
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
          <button id="create-empty" class="primary-action" type="button">New session</button>
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
          <section id="model-picker" class="model-picker" role="dialog" aria-labelledby="model-picker-title" hidden>
            <div class="model-picker-header"><strong id="model-picker-title">Model settings</strong><label><span class="visually-hidden">Search models</span><input id="model-search" type="search" placeholder="Search models" autocomplete="off"></label></div>
            <div id="reasoning-options" class="picker-options reasoning-options"></div>
            <div id="model-options" class="picker-options model-options"></div>
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
                <span id="status" role="status" aria-live="polite">Idle</span>
                <button id="attach-files" class="icon-action" type="button" title="Attach files or folders" aria-label="Attach files or folders">${ICONS.attach}</button>
                <div id="send-group" class="send-group">
                  <button id="send" class="round-action send-action" type="button" title="Send (Enter)" aria-label="Send message">${ICONS.send}</button>
                  <details id="send-options" hidden>
                    <summary aria-label="More send options" title="More send options">⌄</summary>
                    <div role="menu">
                      <button type="button" role="menuitem" data-send-delivery="replace"><strong>Stop and Send</strong><small>Cancel the current response and send immediately.</small></button>
                      <button type="button" role="menuitem" data-send-delivery="queue"><strong>Add to Queue</strong><small>Let the current response finish first.</small></button>
                      <button type="button" role="menuitem" data-send-delivery="steer"><strong>Steer with Message</strong><small>Ask the current response to yield at the next opportunity.</small></button>
                    </div>
                  </details>
                </div>
              </div>
            </div>
          </div>
          <div id="workspace-strip" class="workspace-strip" aria-label="Workspace status"></div>
        </footer>
      </section>

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

  private contextSummaries(sessionID: string): ContextAttachmentSummary[] {
    return [...this.contextAttachments.values()].filter((attachment) => attachment.sessionID === sessionID).map((attachment) => attachment.summary)
  }

  private async postEditorContext(webview: vscode.Webview): Promise<void> {
    await webview.postMessage({ type: "editorContextChanged", context: this.editorContext() } satisfies HostToWebviewMessage)
    const sessionID = this.controller?.snapshot.selectedID
    if (sessionID) {
      await webview.postMessage({ type: "contextAttachmentsChanged", sessionID, attachments: this.contextSummaries(sessionID) } satisfies HostToWebviewMessage)
      const payload = this.composerPayloads.get(sessionID) ?? { revision: 0, attachments: [], pastedText: [] }
      await webview.postMessage({ type: "composerPayloadChanged", sessionID, ...payload } satisfies HostToWebviewMessage)
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

  private async handleMessage(raw: unknown, source: vscode.Webview): Promise<void> {
    const message = parseWebviewMessage(raw)
    if (!message) {
      await source.postMessage({ type: "error", message: "Ignored an invalid webview message" } satisfies HostToWebviewMessage)
      return
    }
    try {
      switch (message.type) {
        case "ready":
          await source.postMessage({ type: "snapshot", snapshot: this.snapshot() } satisfies HostToWebviewMessage)
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
              await source.postMessage({ type: "composerPayloadChanged", sessionID: message.sessionID, ...current, conflict: true, mutationID: message.mutationID } satisfies HostToWebviewMessage)
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
          if (message.action === "edit") {
            const current = this.controller!.chatSnapshot().session?.goal?.objective
            const objective = await vscode.window.showInputBox({ title: "Edit goal", prompt: "Update the objective", value: current, validateInput: (value) => value.trim() ? undefined : "Enter a goal objective" })
            if (objective !== undefined) await this.controller!.send(`/goal edit ${objective.trim()}`)
          } else if (message.action === "cancel") {
            const confirmed = await vscode.window.showWarningMessage("Cancel and clear this goal?", { modal: true }, "Cancel goal")
            if (confirmed === "Cancel goal") await this.controller!.send("/goal cancel")
          } else {
            await this.controller!.send(`/goal ${message.action}`)
          }
          break
        case "send":
          this.requireSelected(message.sessionID)
          const composerPayload = this.composerPayloads.get(message.sessionID) ?? { revision: 0, attachments: [], pastedText: [] }
          if ((message.composerRevision ?? 0) !== composerPayload.revision) {
            await source.postMessage({ type: "composerPayloadChanged", sessionID: message.sessionID, ...composerPayload } satisfies HostToWebviewMessage)
            throw new Error("Composer attachments changed in another chat view; review them before sending")
          }
          const contextFiles = (message.contextIDs ?? []).map((id) => {
            const attachment = this.contextAttachments.get(id)
            if (!attachment || attachment.sessionID !== message.sessionID) throw new Error("Context attachment is no longer available")
            return attachment.file
          })
          const contextUrls = new Set(contextFiles.map((file) => file.url))
          const files = [
            ...(await this.workspaceMentions(message.text)).filter((file) => !contextUrls.has(file.url)),
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
          await this.controller!.send(message.text, message.agent, message.model, message.variant, uniqueFiles, this.controller!.mentionedAgents(message.text), message.promptID, message.delivery)
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
        case "attachWorkspacePath":
          this.requireSelected(message.sessionID)
          await this.addWorkspaceAttachments(message.sessionID, [await this.workspaceFile(message.path)])
          break
        case "attachResource": {
          this.requireSelected(message.sessionID)
          const file = this.controller!.resourceAttachment(message.uri)
          if (!file) throw new Error("MCP resource is no longer available")
          this.storeContextAttachment(message.sessionID, `resource:${message.uri}`, file, { name: file.filename, detail: message.uri.slice(0, 255), kind: "resource" })
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
          await this.handleSessionAction(message.sessionID, message.action, message.messageID)
          break
        case "setAutoApproval":
          if (!this.controller) throw new Error("Open a folder to change approval behavior")
          this.requireKnown(message.sessionID)
          this.controller.setAutoApproval(message.sessionID, message.enabled)
          break
        case "openInEditor":
          this.openInEditor()
          break
        case "openInSidebar":
          await this.openInSidebar()
          break
        case "navigateBack":
          await vscode.commands.executeCommand("workbench.action.navigateBack")
          break
        case "refresh":
          if (!this.controller) throw new Error("Open a folder to refresh OpenCode")
          await this.controller.refresh()
          break
        case "openLogs":
          this.showLogs?.()
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
          break
      }
    } catch (error) {
      const message = errorText(error)
      this.reportError?.(`Webview request failed: ${message}`)
      await source.postMessage({ type: "error", message } satisfies HostToWebviewMessage)
    }
  }

  private snapshot() {
    const snapshot = this.controller?.chatSnapshot() ?? { connected: false, connectionState: this.connectionError ? "failed" as const : "connecting" as const, sessions: [], agents: [], models: [] }
    return !snapshot.connected && this.connectionError ? { ...snapshot, connectionError: this.connectionError } : snapshot
  }

  private queueUpdate(update: ControllerUpdate): void {
    this.publishRemovedSessions()
    if (update.type === "draft") return
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
    const publications: Thenable<boolean>[] = []
    if (this.view) publications.push(this.view.webview.postMessage(message))
    if (this.panel) publications.push(this.panel.webview.postMessage(message))
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

  private async workspaceAttachment(uri: vscode.Uri, range?: vscode.Range): Promise<{ key: string; file: PromptFilePart; summary: Omit<ContextAttachmentSummary, "id"> }> {
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
    for (const range of editor.selections) for (let index = range.start; index < range.end && selected.size < 50; index += 1) selected.add(index)
    const indexes = selected.size ? [...selected] : Array.from({ length: Math.min(20, notebook.cellCount) }, (_, index) => index)
    const chunks: string[] = []
    let characters = 0
    for (const index of indexes) {
      const cell = notebook.cellAt(index)
      const source = cell.document.getText()
      const chunk = `Cell ${index + 1} (${cell.document.languageId})\n${source}`
      if (characters + chunk.length > 750_000) break
      chunks.push(chunk)
      characters += chunk.length
    }
    if (!chunks.length) throw new Error("Notebook context is empty or exceeds Workbench limits")
    const text = chunks.join("\n\n---\n\n")
    const name = (path.basename(notebook.uri.fsPath) || "Untitled notebook").slice(0, 255)
    const bytes = Buffer.from(text, "utf8")
    this.storeContextAttachment(sessionID, `notebook:${notebook.uri}:${notebook.version}:${indexes.join(",")}`, {
      type: "file",
      mime: "text/plain",
      url: `data:text/plain;base64,${bytes.toString("base64")}`,
      filename: `${name}.txt`.slice(0, 255),
    }, { name, detail: `${chunks.length} cell${chunks.length === 1 ? "" : "s"}`, kind: "notebook" }, notebook.uri.toString())
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
      }, { name, detail: selected ? this.selectionLines(selection!) ?? "Selection" : "Unsaved buffer", kind: selected ? "selection" : "buffer" }, document.uri.toString())
      return
    }
    const attachment = await this.workspaceAttachment(document.uri, selection)
    this.storeContextAttachment(sessionID, attachment.key, attachment.file, attachment.summary, document.uri.toString())
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
        this.storeContextAttachment(sessionID, attachment.key, attachment.file, attachment.summary, uri.toString())
      }
    }
    await this.publishContextAttachments(sessionID)
  }

  private storeContextAttachment(sessionID: string, key: string, file: PromptFilePart, summary: Omit<ContextAttachmentSummary, "id">, sourceUri?: string): void {
    if ([...this.contextAttachments.values()].some((attachment) => attachment.sessionID === sessionID && attachment.key === key)) return
    if (this.contextSummaries(sessionID).length >= 20) throw new Error("This prompt already has 20 context attachments")
    const id = randomUUID()
    this.contextAttachments.set(id, { sessionID, key, file, summary: { id, ...summary }, sourceUri })
  }

  private async addWorkspaceAttachments(sessionID: string, uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      const attachment = await this.workspaceAttachment(uri)
      this.storeContextAttachment(sessionID, attachment.key, attachment.file, attachment.summary, uri.toString())
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
    await source.postMessage({ type: "fileSuggestions", sessionID, requestID, files } satisfies HostToWebviewMessage)
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
      await controller.undoSession(sessionID)
      return
    }
    if (action === "redo") {
      await controller.redoSession(sessionID)
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
      const attention = snapshot.sessions.reduce((total, session) => total + session.unread + (session.attention ?? 0), 0)
      this.view.badge = attention ? { value: attention, tooltip: `${attention} OpenCode item${attention === 1 ? "" : "s"} need attention` } : undefined
    }
    if (message.type === "snapshot" && this.panel) this.panel.title = message.snapshot.session?.title || "OpenCode Chat"
    const publish = async (webview: vscode.Webview): Promise<void> => {
      await webview.postMessage(message)
      if (message.type === "snapshot") await this.postEditorContext(webview)
    }
    await Promise.all([
      this.view?.visible ? publish(this.view.webview) : undefined,
      this.panel?.visible ? publish(this.panel.webview) : undefined,
    ].filter(Boolean))
  }

  dispose(): void {
    this.updates.dispose()
    this.panel?.dispose()
    this.disposeAll(this.panelDisposables)
    this.disposeAll(this.viewDisposables)
    this.disposeAll(this.disposables)
    this.contextAttachments.clear()
    this.composerPayloads.clear()
    this.view = undefined
    this.panel = undefined
  }
}
