import { randomBytes } from "node:crypto"
import * as vscode from "vscode"
import type { HostToWebviewMessage } from "@opencode-workbench/shared"
import { parseWebviewMessage } from "@opencode-workbench/shared"
import type { SessionController } from "../session-controller.js"

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private subscription?: { dispose(): void }
  private messageSubscription?: vscode.Disposable

  constructor(private readonly extensionUri: vscode.Uri, private readonly controller?: SessionController) {
    this.subscription = controller?.subscribe(() => void this.postSnapshot())
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    this.messageSubscription?.dispose()
    const media = vscode.Uri.joinPath(this.extensionUri, "media")
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    view.webview.html = this.html(view.webview)
    this.messageSubscription = view.webview.onDidReceiveMessage((raw) => void this.handleMessage(raw))
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString("base64")
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"))
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>OpenCode Chat</title>
</head>
<body>
  <header class="chat-header">
    <div class="session-picker">
      <label class="visually-hidden" for="session">Current session</label>
      <select id="session" aria-label="Current session"><option value="">No session</option></select>
      <button id="create-header" class="icon-action" type="button" title="New session" aria-label="New session">New</button>
    </div>
    <span id="connection" class="connection offline" role="status">Offline</span>
  </header>
  <main id="messages" role="log" aria-label="OpenCode conversation" aria-live="polite" aria-relevant="additions text"></main>
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
  <footer class="composer-region">
    <div class="composer" id="composer">
      <textarea id="draft" rows="2" placeholder="Ask OpenCode..." aria-label="Message OpenCode"></textarea>
      <div class="composer-toolbar">
        <div class="selectors">
          <label class="visually-hidden" for="agent">Agent</label>
          <select id="agent" aria-label="Agent"><option value="">Default agent</option></select>
          <label class="visually-hidden" for="model">Model</label>
          <select id="model" aria-label="Model"><option value="">Default model</option></select>
        </div>
        <div class="actions">
          <span id="status" role="status" aria-live="polite">Idle</span>
          <button id="abort" class="secondary" type="button">Stop</button>
          <button id="send" type="button" title="Send (Ctrl+Enter)">Send</button>
        </div>
      </div>
    </div>
    <div class="composer-hint">Ctrl+Enter to send</div>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw)
    if (!message) {
      await this.post({ type: "error", message: "Ignored an invalid webview message" })
      return
    }
    try {
      switch (message.type) {
        case "ready":
          await this.postSnapshot()
          break
        case "setDraft":
          if (this.controller?.snapshot.selectedID !== message.sessionID) throw new Error("Session changed before the draft update completed")
          this.controller?.setDraft(message.draft)
          break
        case "setPreference":
          if (this.controller?.snapshot.selectedID !== message.sessionID) throw new Error("Session changed before the preference update completed")
          this.controller?.setPreference(message.agent, message.model)
          break
        case "send":
          if (!this.controller) throw new Error("Open a folder to use OpenCode")
          if (this.controller.snapshot.selectedID !== message.sessionID) throw new Error("Session changed before the prompt was sent")
          await this.controller.send(message.text, message.agent, message.model)
          break
        case "abort":
          if (this.controller?.snapshot.selectedID !== message.sessionID) throw new Error("Session changed before the abort request completed")
          await this.controller?.abortSelected()
          break
        case "createSession":
          if (!this.controller) throw new Error("Open a folder to create a session")
          await this.controller.createSession(undefined, message.draft)
          break
        case "selectSession":
          if (!this.controller) throw new Error("Open a folder to select a session")
          if (!Object.hasOwn(this.controller.snapshot.sessions, message.sessionID)) throw new Error("Unknown OpenCode session")
          await this.controller.select(message.sessionID)
          break
        case "openLink": {
          const url = new URL(message.url)
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP links can be opened")
          await vscode.env.openExternal(vscode.Uri.parse(url.toString()))
          break
        }
      }
    } catch (error) {
      await this.post({ type: "error", message: errorText(error) })
    }
  }

  private postSnapshot(): Thenable<boolean> | undefined {
    const snapshot = this.controller?.chatSnapshot() ?? { connected: false, sessions: [], agents: [], models: [] }
    if (this.view) {
      this.view.description = snapshot.session?.title
      const unread = snapshot.sessions.reduce((total, session) => total + session.unread, 0)
      this.view.badge = unread ? { value: unread, tooltip: `${unread} unread OpenCode message${unread === 1 ? "" : "s"}` } : undefined
    }
    return this.post({
      type: "snapshot",
      snapshot,
    })
  }

  private post(message: HostToWebviewMessage): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage(message)
  }

  dispose(): void {
    this.subscription?.dispose()
    this.messageSubscription?.dispose()
    this.view = undefined
  }
}
