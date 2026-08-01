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
  <header>
    <div class="session-line"><strong id="session-title">No session</strong><span id="connection" class="pill offline">offline</span></div>
    <div class="selectors">
      <label>Agent<select id="agent" aria-label="Agent"><option value="">Default</option></select></label>
      <label>Model<select id="model" aria-label="Model"><option value="">Default</option></select></label>
    </div>
  </header>
  <main id="messages" aria-live="polite"></main>
  <section id="empty" class="empty"><p>Select a session or create a new one.</p><button id="create">New session</button></section>
  <footer>
    <textarea id="draft" rows="3" placeholder="Ask OpenCode..." aria-label="Prompt"></textarea>
    <div class="actions"><span id="status">idle</span><button id="abort" class="secondary">Abort</button><button id="send">Send</button></div>
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
          if (message.draft !== undefined) this.controller?.setDraft(message.draft)
          await this.postSnapshot()
          break
        case "setDraft":
          this.controller?.setDraft(message.draft)
          break
        case "setPreference":
          this.controller?.setPreference(message.agent, message.model)
          break
        case "send":
          if (!this.controller) throw new Error("Open a folder to use OpenCode")
          await this.controller.send(message.text, message.agent, message.model)
          break
        case "abort":
          await this.controller?.abortSelected()
          break
        case "createSession":
          if (!this.controller) throw new Error("Open a folder to create a session")
          await this.controller.createSession()
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
    return this.post({
      type: "snapshot",
      snapshot: this.controller?.chatSnapshot() ?? { connected: false, agents: [], models: [] },
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
