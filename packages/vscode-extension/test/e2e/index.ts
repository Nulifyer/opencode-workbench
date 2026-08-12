import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import * as vscode from "vscode"
import type { SyntheticOpenCodeState } from "./synthetic-opencode-server.ts"

const EXTENSION_ID = "nulifyer.opencode-workbench"
const EXPECTED_COMMANDS = [
  "opencodeWorkbench.openChat",
  "opencodeWorkbench.openChatInEditor",
  "opencodeWorkbench.focusComposer",
  "opencodeWorkbench.toggleTaskWorkbench",
  "opencodeWorkbench.toggleSessions",
  "opencodeWorkbench.toggleJobs",
  "opencodeWorkbench.showAttention",
  "opencodeWorkbench.nextAttention",
  "opencodeWorkbench.openHelp",
  "opencodeWorkbench.newSession",
  "opencodeWorkbench.planTask",
  "opencodeWorkbench.handoffPlan",
  "opencodeWorkbench.handoffGitHub",
  "opencodeWorkbench.captureBrowserContext",
  "opencodeWorkbench.fuseRuns",
  "opencodeWorkbench.showHealth",
  "opencodeWorkbench.showTrace",
  "opencodeWorkbench.newIsolatedSession",
  "opencodeWorkbench.removeWorktree",
  "opencodeWorkbench.deleteWorktreeBranch",
  "opencodeWorkbench.compareModels",
  "opencodeWorkbench.refreshRunGroups",
  "opencodeWorkbench.cancelRunGroup",
  "opencodeWorkbench.openRun",
  "opencodeWorkbench.openRunDiff",
  "opencodeWorkbench.compareRunResults",
  "opencodeWorkbench.discardRun",
  "opencodeWorkbench.generateWalkthrough",
  "opencodeWorkbench.openWalkthroughStop",
  "opencodeWorkbench.reviewChanges",
  "opencodeWorkbench.openReviewFinding",
  "opencodeWorkbench.captureTaskEvidence",
  "opencodeWorkbench.verifyGoal",
  "opencodeWorkbench.refresh",
  "opencodeWorkbench.deleteSession",
  "opencodeWorkbench.abortSession",
  "opencodeWorkbench.launchTerminal",
  "opencodeWorkbench.attachResource",
  "opencodeWorkbench.setServerPassword",
] as const

async function eventually<T>(
  operation: () => T | undefined | Promise<T | undefined>,
  description: string,
  milliseconds = 15_000,
): Promise<T> {
  const deadline = Date.now() + milliseconds
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await operation()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ""
  throw new Error(`Timed out waiting for ${description}${detail}`)
}

async function serverState(serverUrl: string, authorization: string): Promise<SyntheticOpenCodeState> {
  const response = await fetch(new URL("/__workbench_e2e/state", serverUrl), {
    headers: { authorization },
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`Synthetic OpenCode state failed (${response.status})`)
  return await response.json() as SyntheticOpenCodeState
}

function chatEditorTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => {
    const input = tab.input as { viewType?: unknown }
    return typeof input.viewType === "string" &&
      (input.viewType === "opencodeWorkbench.chatEditor" || input.viewType.endsWith("-opencodeWorkbench.chatEditor"))
  })
}

export async function run(): Promise<void> {
  const serverUrl = process.env.OPENCODE_WORKBENCH_E2E_SERVER_URL
  const username = process.env.OPENCODE_WORKBENCH_E2E_SERVER_USERNAME
  const password = process.env.OPENCODE_WORKBENCH_E2E_SERVER_PASSWORD
  if (!serverUrl || !username || !password) throw new Error("VS Code E2E server configuration is missing")
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  assert.equal(vscode.workspace.isTrusted, true, "E2E workspace must be trusted")
  assert.equal(vscode.workspace.workspaceFolders?.length, 1, "E2E must open one isolated workspace")

  const extension = vscode.extensions.getExtension(EXTENSION_ID)
  assert.ok(extension, `Extension ${EXTENSION_ID} was not discovered`)
  await extension.activate()
  assert.equal(extension.isActive, true, "Actual extension did not activate")

  const ready = await eventually(async () => {
    const state = await serverState(serverUrl, authorization)
    const paths = new Set(state.requests.map((request) => request.path))
    return paths.has("/global/health") && paths.has("/event") && paths.has("/session") ? state : undefined
  }, "extension activation and OpenCode reconciliation")
  assert.deepEqual(ready.promptRequests, [], "Extension activation issued an OpenCode prompt")

  const manifestCommands = (extension.packageJSON.contributes?.commands as Array<{ command?: unknown }> | undefined)
    ?.map((entry) => entry.command)
    .filter((command): command is string => typeof command === "string") ?? []
  assert.deepEqual(new Set(manifestCommands), new Set(EXPECTED_COMMANDS), "Contributed command fixture is out of date")
  const registered = new Set(await vscode.commands.getCommands(true))
  for (const command of manifestCommands) {
    assert.ok(registered.has(command), `Contributed command is not registered: ${command}`)
  }

  await vscode.commands.executeCommand("opencodeWorkbench.openChatInEditor")
  await eventually(() => chatEditorTab(), "OpenCode editor chat tab")

  const beforeSession = await serverState(serverUrl, authorization)
  assert.deepEqual(beforeSession.promptRequests, [], "Opening editor chat issued an OpenCode prompt")
  await vscode.commands.executeCommand("opencodeWorkbench.newSession")
  const afterSession = await eventually(async () => {
    const state = await serverState(serverUrl, authorization)
    return state.sessions.length === 1 ? state : undefined
  }, "new OpenCode session")
  assert.equal(afterSession.sessions[0]?.directory, vscode.workspace.workspaceFolders[0]!.uri.fsPath)
  assert.deepEqual(afterSession.promptRequests, [], "Creating an empty session issued an OpenCode prompt")
  assert.deepEqual(
    afterSession.unhandled,
    [],
    `Extension made unhandled OpenCode requests: ${afterSession.unhandled.join(", ")}`,
  )
}
