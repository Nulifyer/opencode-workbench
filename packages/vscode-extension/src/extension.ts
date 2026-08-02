import * as vscode from "vscode"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { VsCodeBridge } from "./bridge.js"
import { DeferredOpenCodeReload, type OpenCodeReloadRequest } from "./deferred-reload.js"
import { ManagedOpenCodeServer } from "./managed-server.js"
import { OpenCodeClient, type OpenCodeConnection } from "./opencode-client.js"
import { SessionController, type ComposerPreferences } from "./session-controller.js"
import { ChatViewProvider } from "./views/chat-view.js"

const PASSWORD_SECRET = "opencodeWorkbench.serverPassword"
let activeBridge: VsCodeBridge | undefined
let activeManagedServer: ManagedOpenCodeServer | undefined

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

function serverMode(): "managed" | "external" {
  return vscode.workspace.getConfiguration("opencodeWorkbench").get<"managed" | "external">("serverMode", "managed")
}

async function waitForControllerConnection(controller: SessionController, timeoutMilliseconds = 30_000): Promise<void> {
  if (controller.snapshot.connected) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      subscription.dispose()
      if (error) reject(error)
      else resolve()
    }
    const subscription = controller.subscribe(() => {
      if (controller.snapshot.connected) finish()
    })
    const timeout = setTimeout(() => finish(new Error("OpenCode did not reconnect after reload")), timeoutMilliseconds)
    if (controller.snapshot.connected) finish()
  })
}

async function reloadController(controller: SessionController, request: OpenCodeReloadRequest): Promise<void> {
  const selectedID = controller.snapshot.selectedID
  await controller.refresh()
  await waitForControllerConnection(controller)
  await controller.reconcile()
  const restoreID = selectedID && Object.hasOwn(controller.snapshot.sessions, selectedID) ? selectedID : request.sessionID
  if (restoreID && Object.hasOwn(controller.snapshot.sessions, restoreID) && controller.snapshot.selectedID !== restoreID) {
    await controller.select(restoreID)
  }
}

async function externalConnection(context: vscode.ExtensionContext, directory: string): Promise<OpenCodeConnection> {
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("OpenCode Workbench", { log: true })
  context.subscriptions.push(output)
  const report = (message: string): void => output.appendLine(message)
  const folders = vscode.workspace.workspaceFolders ?? []
  let workspaceFolder = folders[0]
  if (folders.length > 1) {
    const remembered = context.workspaceState.get<string>("opencodeWorkbench.workspaceRoot")
    workspaceFolder = folders.find((folder) => folder.uri.toString() === remembered) ?? await vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the workspace root for OpenCode Workbench" })
    if (workspaceFolder) await context.workspaceState.update("opencodeWorkbench.workspaceRoot", workspaceFolder.uri.toString())
  }
  const workspacePath = workspaceFolder?.uri.fsPath
  let client: OpenCodeClient | undefined
  let controller: SessionController | undefined
  let chatProvider: ChatViewProvider | undefined
  let deferredReload: DeferredOpenCodeReload | undefined

  if (workspacePath) {
    const mode = serverMode()
    activeBridge = new VsCodeBridge(workspacePath, {
      requestOpenCodeReload: mode === "managed" ? (request) => {
        if (!deferredReload) throw new Error("Managed OpenCode reload is not ready")
        return deferredReload.request(request)
      } : undefined,
    })
    try {
      let initialConnection: OpenCodeConnection
      if (mode === "managed") {
        const configuration = vscode.workspace.getConfiguration("opencodeWorkbench")
        activeManagedServer = new ManagedOpenCodeServer({
          directory: workspacePath,
          extensionPath: context.extensionPath,
          executablePath: configuration.get<string>("executablePath")?.trim() || undefined,
          bridgeID: activeBridge.bridgeID,
          output,
          onRestart: (next) => {
            client?.update(next)
            controller?.reconnect()
          },
          onFailure: (message) => report(`Managed OpenCode server failed: ${message}`),
        })
        initialConnection = await activeManagedServer.start()
        context.subscriptions.push(activeManagedServer)
      } else initialConnection = await externalConnection(context, workspacePath)
      client = new OpenCodeClient(initialConnection)
      const globalPreferences = context.globalState.get<ComposerPreferences>("opencodeWorkbench.composerPreferences")
      const preferences = globalPreferences ?? context.workspaceState.get<ComposerPreferences>("opencodeWorkbench.composerPreferences")
      if (!globalPreferences && preferences) await context.globalState.update("opencodeWorkbench.composerPreferences", preferences)
      controller = new SessionController(client, {
        error: report,
        preferencesChanged: (preferences) => void context.globalState.update("opencodeWorkbench.composerPreferences", preferences),
      }, preferences)
      controller.start()
      context.subscriptions.push(controller)
      if (mode === "managed") {
        deferredReload = new DeferredOpenCodeReload(controller, {
          reload: async (request) => await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: "Reloading OpenCode", cancellable: false },
            () => reloadController(controller!, request),
          ),
          completed: () => report("OpenCode reloaded and restored the current Workbench session"),
          failed: (_request, error) => report(`Could not reload OpenCode: ${errorMessage(error)}`),
        })
        context.subscriptions.push(deferredReload)
      }
    } catch (error) {
      report(`OpenCode connection setup failed: ${errorMessage(error)}`)
    }
    try {
      await activeBridge.start()
      context.subscriptions.push(activeBridge)
    } catch (error) {
      activeBridge = undefined
      report(`OpenCode VS Code bridge failed: ${errorMessage(error)}`)
    }
  }

  chatProvider = new ChatViewProvider(context.extensionUri, controller, workspacePath)
  context.subscriptions.push(
    chatProvider,
    vscode.window.registerWebviewViewProvider("opencodeWorkbench.chat", chatProvider),
  )

  const updateSessionContext = (): void => {
    const selected = controller?.snapshot.selectedID
    const status = selected ? controller?.snapshot.sessions[selected]?.status.type : undefined
    void vscode.commands.executeCommand("setContext", "opencodeWorkbench.sessionBusy", status === "busy" || status === "retry")
  }
  updateSessionContext()
  const contextSubscription = controller?.subscribe(updateSessionContext)
  if (contextSubscription) context.subscriptions.push(contextSubscription)

  const run = (operation: () => Promise<unknown>) => async (): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      report(errorMessage(error))
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeWorkbench.openChat", async () => {
      await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
    }),
    vscode.commands.registerCommand("opencodeWorkbench.openChatInEditor", () => {
      chatProvider.openInEditor()
    }),
    vscode.commands.registerCommand("opencodeWorkbench.attachResource", run(async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const resources = selected?.length ? selected : uri ? [uri] : []
      if (!resources.length) throw new Error("Select a workspace file or folder to attach")
      await chatProvider.attachResources(resources)
      await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
    })),
    vscode.commands.registerCommand("opencodeWorkbench.selectSession", async (sessionID: string) => {
      if (controller && typeof sessionID === "string") {
        await controller.select(sessionID)
        await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
      }
    }),
    vscode.commands.registerCommand("opencodeWorkbench.newSession", run(async () => {
      if (!controller) throw new Error("Open a workspace folder before creating an OpenCode session")
      await controller.createSession()
      await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
    })),
    vscode.commands.registerCommand("opencodeWorkbench.refresh", run(async () => {
      if (!controller) throw new Error("Open a workspace folder before refreshing OpenCode")
      await controller.refresh()
    })),
    vscode.commands.registerCommand("opencodeWorkbench.deleteSession", async (value: string) => {
      const sessionID = value
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
      if (serverMode() !== "external") {
        vscode.window.setStatusBarMessage("OpenCode server passwords apply only in external mode", 4_000)
        return
      }
      const password = await vscode.window.showInputBox({ title: "OpenCode server password", password: true, prompt: "Leave empty to remove the stored password" })
      if (password === undefined) return
      if (password) await context.secrets.store(PASSWORD_SECRET, password)
      else await context.secrets.delete(PASSWORD_SECRET)
      if (client && controller && workspacePath) {
        client.update(await externalConnection(context, workspacePath))
        controller.reconnect()
      }
    }),
    vscode.commands.registerCommand("opencodeWorkbench.launchTerminal", run(async () => {
      const terminal = vscode.window.createTerminal({ name: "OpenCode", cwd: workspacePath })
      const executable = vscode.workspace.getConfiguration("opencodeWorkbench").get<string>("executablePath")?.trim() || "opencode"
      await executeInTerminal(terminal, executable, [])
    })),
  )

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("opencodeWorkbench.serverMode") || event.affectsConfiguration("opencodeWorkbench.executablePath")) {
      vscode.window.setStatusBarMessage("Reload this VS Code window to apply the OpenCode server change", 6_000)
      return
    }
    if (serverMode() !== "external" || (!event.affectsConfiguration("opencodeWorkbench.serverUrl") && !event.affectsConfiguration("opencodeWorkbench.serverUsername") && !event.affectsConfiguration("opencodeWorkbench.serverEnvironmentFile"))) return
    if (!client || !controller || !workspacePath) return
    void externalConnection(context, workspacePath).then((next) => {
      client?.update(next)
      controller?.reconnect()
    }).catch((error) => report(errorMessage(error)))
  }))
}

export async function deactivate(): Promise<void> {
  const managed = activeManagedServer
  activeManagedServer = undefined
  const bridge = activeBridge
  activeBridge = undefined
  await Promise.all([managed?.stop(), bridge?.stop()])
}
