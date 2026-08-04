import * as vscode from "vscode"
import type { SessionController } from "../session-controller.js"
import { sessionTreeEntries } from "./session-tree-model.js"

export class SessionItem extends vscode.TreeItem {
  readonly contextValue = "opencodeWorkbench.session"

  constructor(readonly sessionID: string, label: string, status: string, unread: number) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.command = { command: "opencodeWorkbench.selectSession", title: "Select Session", arguments: [sessionID] }
    this.description = [status !== "idle" ? status : "", unread ? `${unread} unread` : ""].filter(Boolean).join(" | ")
    this.iconPath = new vscode.ThemeIcon(status === "busy" ? "loading~spin" : status === "error" ? "error" : unread ? "circle-filled" : "comment")
    this.tooltip = `${label}\n${sessionID}`
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SessionItem | undefined | null | void>()
  readonly onDidChangeTreeData = this.changed.event
  private subscription?: { dispose(): void }

  constructor(private readonly controller?: SessionController) {
    this.subscription = controller?.subscribe(() => this.changed.fire())
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element
  }

  getChildren(): SessionItem[] {
    const controller = this.controller
    if (!controller) return []
    return sessionTreeEntries(controller).map((session) => new SessionItem(session.id, session.title, session.status, session.unread))
  }

  refresh(): void {
    this.changed.fire()
  }

  dispose(): void {
    this.subscription?.dispose()
    this.changed.dispose()
  }
}
