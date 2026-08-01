import * as vscode from "vscode"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PermissionRequest } from "@opencode-workbench/shared"
import { VsCodeBridge } from "./bridge.js"
import { OpenCodeClient, type OpenCodeConnection, validateServerUrl } from "./opencode-client.js"
import { SessionController } from "./session-controller.js"
import { ChatViewProvider } from "./views/chat-view.js"
import { SessionItem, SessionTreeProvider } from "./views/session-tree.js"

const PASSWORD_SECRET = "opencodeWorkbench.serverPassword"
let activeBridge: VsCodeBridge | undefined

async function serverEnvironment(file: string): Promise<Record<string, string>> {
  if ((process.platform as string) === "win32") return {}
  const expanded = file === "~" ? os.homedir() : file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file
  try {
    const info = await fs.lstat(expanded)
    if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      ((process.platform as string) !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error(`OpenCode server environment must be an owner-only regular file: ${expanded}`)
    }
    const values: Record<string, string> = {}
    for (const line of (await fs.readFile(expanded, "utf8")).split(/\r?\n/)) {
      const match = /^(OPENCODE_SERVER_(?:USERNAME|PASSWORD))=(.*)$/.exec(line)
      if (match) values[match[1]!] = match[2]!
    }
    return values
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {}
    throw error
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function executeInTerminal(terminal: vscode.Terminal, executable: string, args: string[]): Promise<vscode.TerminalShellExecution> {
  terminal.show()
  let integration = terminal.shellIntegration
  if (!integration) {
    integration = await new Promise<vscode.TerminalShellIntegration>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.dispose()
        reject(new Error("Terminal shell integration did not become available"))
      }, 5_000)
      const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal !== terminal || !event.shellIntegration) return
        clearTimeout(timer)
        subscription.dispose()
        resolve(event.shellIntegration)
      })
      if (terminal.shellIntegration) {
        clearTimeout(timer)
        subscription.dispose()
        resolve(terminal.shellIntegration)
      }
    })
  }
  return integration.executeCommand(executable, args)
}

async function connection(context: vscode.ExtensionContext, directory: string): Promise<OpenCodeConnection> {
  const configuration = vscode.workspace.getConfiguration("opencodeWorkbench")
  const environment = await serverEnvironment(configuration.get<string>("serverEnvironmentFile", "~/.config/opencode-workbench/server.env"))
  const configuredPassword = await context.secrets.get(PASSWORD_SECRET)
  return {
    baseUrl: configuration.get<string>("serverUrl", "http://127.0.0.1:4096").trim(),
    username: configuration.get<string>("serverUsername") || environment.OPENCODE_SERVER_USERNAME || "opencode",
    password: configuredPassword || environment.OPENCODE_SERVER_PASSWORD || "",
    directory,
  }
}

async function confirmPermission(request: PermissionRequest): Promise<"once" | "always" | "reject"> {
  if (!vscode.workspace.getConfiguration("opencodeWorkbench").get<boolean>("confirmPermissions", true)) return "reject"
  const pattern = Array.isArray(request.pattern) ? request.pattern.join("\n") : request.pattern
  const always = request.always?.join("\n")
  const metadata = request.metadata && Object.keys(request.metadata).length ? JSON.stringify(request.metadata, null, 2) : undefined
  const detail = [`Session: ${request.sessionID}`, request.type ? `Permission: ${request.type}` : undefined, pattern ? `Current scope: ${pattern}` : undefined, always ? `Persistent scope: ${always}` : undefined, metadata].filter(Boolean).join("\n\n")
  if (detail.length > 8_000) {
    void vscode.window.showErrorMessage("OpenCode permission request was rejected because its full details exceed the 8,000-character display limit")
    return "reject"
  }
  const choices = request.always?.length ? ["Allow once", "Always allow", "Reject"] as const : ["Allow once", "Reject"] as const
  const choice = await vscode.window.showWarningMessage(
    request.title,
    { modal: true, detail: detail || "OpenCode needs permission to continue." },
    ...choices,
  )
  if (choice === "Allow once") return "once"
  if (choice === "Always allow") return "always"
  return "reject"
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  let client: OpenCodeClient | undefined
  let controller: SessionController | undefined

  if (workspacePath) {
    try {
      client = new OpenCodeClient(await connection(context, workspacePath))
      controller = new SessionController(client, {
        permission: confirmPermission,
        error: (message) => void vscode.window.showErrorMessage(message),
      })
      controller.start()
      context.subscriptions.push(controller)
    } catch (error) {
      void vscode.window.showErrorMessage(`OpenCode connection setup failed: ${errorMessage(error)}`)
    }
    try {
      activeBridge = new VsCodeBridge(workspacePath)
      await activeBridge.start()
      context.subscriptions.push(activeBridge)
    } catch (error) {
      activeBridge = undefined
      void vscode.window.showErrorMessage(`OpenCode VS Code bridge failed: ${errorMessage(error)}`)
    }
  }

  const treeProvider = new SessionTreeProvider(controller)
  const chatProvider = new ChatViewProvider(context.extensionUri, controller)
  context.subscriptions.push(
    treeProvider,
    chatProvider,
    vscode.window.registerTreeDataProvider("opencodeWorkbench.sessions", treeProvider),
    vscode.window.registerWebviewViewProvider("opencodeWorkbench.chat", chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),
  )

  const run = (operation: () => Promise<unknown>) => async (): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeWorkbench.selectSession", async (sessionID: string) => {
      if (controller && typeof sessionID === "string") await controller.select(sessionID)
    }),
    vscode.commands.registerCommand("opencodeWorkbench.newSession", run(async () => {
      if (!controller) throw new Error("Open a workspace folder before creating an OpenCode session")
      await controller.createSession()
    })),
    vscode.commands.registerCommand("opencodeWorkbench.refresh", run(async () => {
      if (!controller) throw new Error("Open a workspace folder before refreshing OpenCode")
      await controller.reconcile()
      treeProvider.refresh()
    })),
    vscode.commands.registerCommand("opencodeWorkbench.deleteSession", async (value: SessionItem | string) => {
      const sessionID = value instanceof SessionItem ? value.sessionID : value
      if (!controller || typeof sessionID !== "string") return
      const session = controller.snapshot.sessions[sessionID]
      const choice = await vscode.window.showWarningMessage(
        `Delete "${session?.info.title || sessionID}"?`,
        { modal: true, detail: "This permanently deletes the OpenCode session and its transcript." },
        "Delete",
      )
      if (choice === "Delete") await run(() => controller.deleteSession(sessionID))()
    }),
    vscode.commands.registerCommand("opencodeWorkbench.abortSession", run(async () => {
      await controller?.abortSelected()
    })),
    vscode.commands.registerCommand("opencodeWorkbench.setServerPassword", async () => {
      const password = await vscode.window.showInputBox({ title: "OpenCode server password", password: true, prompt: "Leave empty to remove the stored password" })
      if (password === undefined) return
      if (password) await context.secrets.store(PASSWORD_SECRET, password)
      else await context.secrets.delete(PASSWORD_SECRET)
      if (client && controller && workspacePath) {
        client.update(await connection(context, workspacePath))
        controller.reconnect()
      }
    }),
    vscode.commands.registerCommand("opencodeWorkbench.launchTerminal", run(async () => {
      const terminal = vscode.window.createTerminal({ name: "OpenCode", cwd: workspacePath })
      await executeInTerminal(terminal, "opencode", [])
    })),
    vscode.commands.registerCommand("opencodeWorkbench.attachTerminal", run(async () => {
      if (!workspacePath) throw new Error("Open a workspace folder before attaching OpenCode")
      const settings = await connection(context, workspacePath)
      const url = new URL(settings.baseUrl)
      validateServerUrl(url.toString())
      const terminal = vscode.window.createTerminal({
        name: "OpenCode Attach",
        cwd: workspacePath,
        env: {
          OPENCODE_SERVER_USERNAME: settings.username,
          OPENCODE_SERVER_PASSWORD: settings.password,
        },
      })
      try {
        await executeInTerminal(terminal, "opencode", ["attach", url.toString(), "--dir", workspacePath])
      } catch (error) {
        terminal.dispose()
        throw error
      }
    })),
  )

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("opencodeWorkbench.serverUrl") && !event.affectsConfiguration("opencodeWorkbench.serverUsername") && !event.affectsConfiguration("opencodeWorkbench.serverEnvironmentFile")) return
    if (!client || !controller || !workspacePath) return
    void connection(context, workspacePath).then((next) => {
      client?.update(next)
      controller?.reconnect()
    }).catch((error) => void vscode.window.showErrorMessage(errorMessage(error)))
  }))
}

export async function deactivate(): Promise<void> {
  const bridge = activeBridge
  activeBridge = undefined
  await bridge?.stop()
}
