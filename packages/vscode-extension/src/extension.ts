import * as vscode from "vscode"
import { createOpenCodeMessageID, type ContextReceipt, type DiffAnchor } from "@opencode-workbench/shared"
import type { PlanReference } from "@opencode-workbench/shared"
import type { WorktreeJournalEntry } from "@opencode-workbench/shared"
import type { RunGroup } from "@opencode-workbench/shared"
import type { WalkthroughDocument } from "@opencode-workbench/shared"
import type { EvidenceReference, ReviewDocument } from "@opencode-workbench/shared"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { VsCodeBridge } from "./bridge.js"
import { DeferredOpenCodeReload, type OpenCodeReloadRequest } from "./deferred-reload.js"
import { ManagedOpenCodeServer, supportedVersion } from "./managed-server.js"
import { OpenCodeClient, type OpenCodeConnection } from "./opencode-client.js"
import { SessionController, type ComposerPreferences } from "./session-controller.js"
import { ChatViewProvider } from "./views/chat-view.js"
import { resolveWorkspaceRoot } from "./workspace-root.js"
import { ContextReceiptService } from "./application/context-service.js"
import { createPlanReference, generatedPlanDisposition, planArtifact, structuredPlanPrompt } from "./application/plan-service.js"
import { HealthService, workbenchHealthSummary } from "./application/health-service.js"
import { controllerTraceCategory, TraceService } from "./application/trace-service.js"
import { TypedGitRunner, WorktreeService } from "./application/worktree-service.js"
import { MultiRunOrchestrator, RunGroupService } from "./application/run-group-service.js"
import { RunComparisonService } from "./application/run-comparison-service.js"
import { diffFileChangeKind, DiffService, type DiffCapture } from "./application/diff-service.js"
import { EvidenceService } from "./application/evidence-service.js"
import { WalkthroughService } from "./application/walkthrough-service.js"
import { ReviewService } from "./application/review-service.js"
import { boundedVerifierEvidence, GoalVerifierService } from "./application/goal-verifier-service.js"
import { createOpenCodeGoalVerifierInvocation } from "./application/goal-verifier-invocation.js"
import { assertSelectedEditorContextWithinLimit, AuthenticatedGitHubRestProvider, detectGitHubSurfaces, githubContextDocument, githubHandoffPrompt, githubPullRequestChangesUri, hasExplicitGitHubContextLimits, NativeGitHubContextService, parseGitHubReference } from "./application/native-integration-service.js"
import { assertBrowserScreenshotFileBeforeRead, captureBrowserContext, requestedBrowserEditorSelection, type BrowserContextSource, type BrowserScreenshotMime } from "./application/browser-context-service.js"
import { boundedFusionContinuityEvidence, boundedFusionSourceEvidence, buildFusionBundle, type FusionMode } from "./application/fusion-service.js"
import { executeAndCaptureTask } from "./application/task-evidence-service.js"
import { diffNavigationPaths } from "./application/diff-navigation.js"
import { captureDiagnostics, diagnosticsDelta, diagnosticsSummary, type DiagnosticsSnapshot } from "./application/diagnostics-evidence-service.js"
import { observeRunMessages } from "./application/run-observation-service.js"
import { promptFileReceiptItems } from "./application/context-receipt-builders.js"
import { isUserCancellation, userFacingError } from "./application/error-presentation.js"
import { GitCommonDirectoryHandoffStore, HandoffContinuityService } from "./application/handoff-continuity-service.js"
import { SerializedStateWriter } from "./application/serialized-state-writer.js"
import { assistantTurnFailed } from "./application/session-turn-outcome.js"
import { createIsolatedWorktreeIdentity } from "./application/isolated-worktree-identity.js"
import { TaskArtifactService } from "./application/task-artifact-service.js"
import { SessionPresentationService } from "./application/session-presentation-service.js"
import { RecoveryPreviewService } from "./application/recovery-preview-service.js"

const PASSWORD_SECRET = "opencodeWorkbench.serverPassword"
const SELECTED_SESSION_STATE = "opencodeWorkbench.selectedSessionID"
const RECOVERED_SESSIONS_STATE = "opencodeWorkbench.recoveredSessions"
const CONTEXT_RECEIPTS_STATE = "opencodeWorkbench.contextReceipts.v1"
const PLAN_REFERENCES_STATE = "opencodeWorkbench.planReferences.v1"
const WORKTREE_JOURNAL_STATE = "opencodeWorkbench.worktreeJournal.v1"
const RUN_GROUPS_STATE = "opencodeWorkbench.runGroups.v1"
const WALKTHROUGHS_STATE = "opencodeWorkbench.walkthroughs.v1"
const EVIDENCE_STATE = "opencodeWorkbench.evidence.v1"
const TASK_ARTIFACTS_STATE = "opencodeWorkbench.taskArtifacts.v1"
const SESSION_PRESENTATION_STATE = "opencodeWorkbench.sessionPresentation.v1"
let activeBridge: VsCodeBridge | undefined
let activeManagedServer: ManagedOpenCodeServer | undefined
let activeHandoffContinuity: HandoffContinuityService | undefined
let activeStateWriter: SerializedStateWriter | undefined
let activeMultiRun: MultiRunOrchestrator | undefined
let activeDurableMetadataFlush: (() => Promise<void>) | undefined

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

async function waitForAssistantResult(runtime: OpenCodeClient, sessionID: string, timeoutMilliseconds = 300_000): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const [statuses, messages] = await Promise.all([runtime.sessionStatuses(), runtime.messages(sessionID)])
    const status = statuses[sessionID]
    if (status?.type === "error" || assistantTurnFailed(messages)) throw new Error("OpenCode failed while generating the plan")
    const assistant = messages.slice().reverse().find((entry) => entry.info.role === "assistant")
    const result = assistant?.parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n").trim()
    if (result && status?.type !== "busy" && status?.type !== "retry") return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("OpenCode did not finish the plan within five minutes")
}

async function executeTaskWithExitCode(task: vscode.Task, timeoutMilliseconds = 600_000): Promise<number | undefined> {
  return await executeAndCaptureTask(
    () => vscode.tasks.executeTask(task),
    (listener) => vscode.tasks.onDidEndTaskProcess(listener),
    timeoutMilliseconds,
  )
}

async function taskRepository(task: vscode.Task): Promise<string | undefined> {
  if (typeof task.scope === "object") return await fs.realpath(task.scope.uri.fsPath).catch(() => undefined)
  if (task.scope !== vscode.TaskScope.Workspace) return undefined
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length !== 1) return undefined
  return await fs.realpath(folders[0]!.uri.fsPath).catch(() => undefined)
}

async function currentDebugContext(repository: string): Promise<string> {
  const root = await fs.realpath(repository).catch(() => path.resolve(repository))
  const containedPath = async (candidate: string): Promise<string | undefined> => {
    const resolved = await fs.realpath(candidate).catch(() => path.resolve(candidate))
    const relative = path.relative(root, resolved)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
    return relative || "."
  }
  const active = vscode.debug.activeDebugSession
  const activeFolder = active?.workspaceFolder ? await containedPath(active.workspaceFolder.uri.fsPath) : undefined
  const breakpoints = (await Promise.all(vscode.debug.breakpoints.slice(0, 100).map(async (breakpoint) => {
    if (!(breakpoint instanceof vscode.SourceBreakpoint) || breakpoint.location.uri.scheme !== "file") return undefined
    const file = await containedPath(breakpoint.location.uri.fsPath)
    if (!file) return undefined
    return {
      file: file.replaceAll(path.sep, "/"),
      line: breakpoint.location.range.start.line + 1,
      column: breakpoint.location.range.start.character + 1,
      enabled: breakpoint.enabled,
    }
  }))).filter((entry) => entry !== undefined)
  return JSON.stringify({
    activeSession: active && activeFolder !== undefined
      ? { name: active.name.slice(0, 500), type: active.type.slice(0, 200), workspaceFolder: activeFolder.replaceAll(path.sep, "/") }
      : undefined,
    sourceBreakpoints: breakpoints,
    sourceBreakpointCount: vscode.debug.breakpoints.filter((entry) => entry instanceof vscode.SourceBreakpoint).length,
    truncated: vscode.debug.breakpoints.length > 100 || undefined,
  }, null, 2)
}

interface BoundedOpenCodeResult {
  text: string
  sessionID: string
  messageID?: string
  model: string
}

async function invokeBoundedOpenCode(runtime: OpenCodeClient, title: string, prompt: string, model: string, file: { filename: string; mime: string; url: string }, timeoutMilliseconds = 300_000): Promise<BoundedOpenCodeResult> {
  const session = await runtime.createSession(title)
  await runtime.sendPrompt(session.id, createOpenCodeMessageID(), prompt, "steer", "plan", model, undefined, [{ type: "file", ...file }])
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const status = (await runtime.sessionStatuses())[session.id]
    if (!status || status.type === "idle" || status.type === "error") {
      const messages = await runtime.messages(session.id)
      if (assistantTurnFailed(messages)) throw new Error("OpenCode generation failed")
      const assistant = messages.slice().reverse().find((message) => message.info.role === "assistant")
      const text = assistant?.parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n").trim()
      if (text) return { text, sessionID: session.id, messageID: assistant?.info.id, model }
      if (status?.type === "error") throw new Error("OpenCode generation failed")
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  await runtime.abort(session.id).catch(() => false)
  throw new Error("OpenCode generation timed out")
}

function repositoryPath(root: string, relativePath: string, label: string): string {
  const candidate = path.resolve(root, relativePath)
  const relative = path.relative(root, candidate)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} is outside the repository`)
  return candidate
}

async function nativeDiffText(diffs: DiffService, capture: DiffCapture, filePath: string): Promise<{ base: string; modified: string; basePath: string; modifiedPath: string }> {
  if (!capture.snapshot.complete) throw new Error(`Diff is incomplete: ${capture.snapshot.truncationReason ?? "unknown limitation"}`)
  const summary = capture.snapshot.files.find((file) => file.path === filePath)
  if (!summary) throw new Error(`Diff references an unknown file: ${filePath}`)
  if (summary.binary) throw new Error("Binary files are not available in the text diff editor")
  const root = await fs.realpath(capture.snapshot.repository)
  const baseCandidate = repositoryPath(root, summary.previousPath ?? summary.path, "Base-side diff path")
  const modifiedCandidate = repositoryPath(root, summary.path, "Modified-side diff path")
  const basePath = path.relative(root, baseCandidate).split(path.sep).join("/")
  const modifiedPath = path.relative(root, modifiedCandidate).split(path.sep).join("/")
  const kind = diffFileChangeKind(capture, summary.path)
  const base = kind === "added" ? "" : await diffs.readRevisionText(root, capture.snapshot.baseRef ?? "HEAD", basePath)
  let modified = ""
  if (kind !== "deleted") {
    if (capture.snapshot.headRef) modified = await diffs.readRevisionText(root, capture.snapshot.headRef, modifiedPath)
    else {
      const canonicalParent = await fs.realpath(path.dirname(modifiedCandidate))
      const parentRelative = path.relative(root, canonicalParent)
      if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) throw new Error("Modified-side diff path escapes the repository")
      modified = await diffs.readWorkingTreeText(modifiedCandidate)
    }
  }
  return { base, modified, basePath, modifiedPath }
}

async function openDiffAnchor(diffs: DiffService, capture: DiffCapture, anchor: DiffAnchor, title: string): Promise<void> {
  const paths = diffNavigationPaths(capture.snapshot, anchor)
  const content = await nativeDiffText(diffs, capture, paths.modifiedPath)
  const language = path.extname(anchor.side === "base" ? content.basePath : content.modifiedPath).slice(1)
  const baseDocument = await vscode.workspace.openTextDocument({ language, content: content.base })
  const modifiedDocument = await vscode.workspace.openTextDocument({ language, content: content.modified })
  await vscode.commands.executeCommand("vscode.diff", baseDocument.uri, modifiedDocument.uri, title)
  const targetUri = anchor.side === "base" ? baseDocument.uri : modifiedDocument.uri
  const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === targetUri.toString())
  if (!editor) throw new Error(`The diff opened, but VS Code did not expose its ${anchor.side} editor for navigation`)
  const firstLine = Math.min(Math.max(0, anchor.startLine - 1), Math.max(0, editor.document.lineCount - 1))
  const lastLine = Math.min(Math.max(firstLine, anchor.endLine - 1), Math.max(0, editor.document.lineCount - 1))
  const selection = new vscode.Range(firstLine, 0, lastLine, editor.document.lineAt(lastLine).text.length)
  editor.selection = new vscode.Selection(selection.start, selection.end)
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenter)
  await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false, selection })
}

async function startIsolatedTask(client: OpenCodeClient, worktrees: WorktreeService, workspacePath: string, input: {
  title: string
  prompt: string
  slug: string
  agent?: string
  files?: Array<{ type: "file"; filename: string; mime: string; url: string }>
  admission?: {
    prepare(sessionID: string, promptID: string): void
    admit(sessionID: string, promptID: string): void
    reject(promptID: string): void
  }
}): Promise<WorktreeJournalEntry> {
  const repository = await worktrees.repository(workspacePath)
  const identity = createIsolatedWorktreeIdentity(input.slug)
  const entry = await worktrees.create({ directory: repository.root, path: path.join(path.dirname(repository.root), `.${path.basename(repository.root)}-worktrees`, identity.name), branch: identity.branch, baseRef: "HEAD", mutationID: identity.mutationID })
  let promptID: string | undefined
  try {
    await worktrees.markDurably(entry.id, "session-creating")
    const runtime = client.forDirectory(entry.path)
    const session = await runtime.createSession(input.title.slice(0, 500))
    await worktrees.markDurably(entry.id, "session-ready", { sessionID: session.id })
    promptID = createOpenCodeMessageID()
    await worktrees.markDurably(entry.id, "prompt-admitting", { sessionID: session.id, promptID })
    input.admission?.prepare(session.id, promptID)
    await runtime.sendPrompt(session.id, promptID, input.prompt, "steer", input.agent ?? "build", undefined, undefined, input.files)
    input.admission?.admit(session.id, promptID)
    await worktrees.markDurably(entry.id, "prompt-admitted", { sessionID: session.id, promptID })
    return { ...entry, sessionID: session.id, promptID, phase: "prompt-admitted" }
  } catch (error) {
    if (promptID) input.admission?.reject(promptID)
    await worktrees.failDurably(entry.id, {
      code: "INTERNAL",
      message: promptID ? "OpenCode prompt admission failed for this isolated worktree" : "OpenCode session creation failed for this isolated worktree",
      retryable: true,
    })
    throw error
  }
}

function currentDiagnostics(repository: string): DiagnosticsSnapshot {
  return captureDiagnostics(repository, vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => {
    if (uri.scheme !== "file" && uri.scheme !== "vscode-remote") return []
    const fileErrors = diagnostics.filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length
    const fileWarnings = diagnostics.filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Warning).length
    return [{ file: uri.fsPath, errors: fileErrors, warnings: fileWarnings }]
  }))
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
    const selected = folders.find((folder) => folder.uri.toString() === remembered) ?? await vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the workspace root for OpenCode Workbench" })
    if (selected) workspaceFolder = selected
    if (workspaceFolder) await context.workspaceState.update("opencodeWorkbench.workspaceRoot", workspaceFolder.uri.toString())
  }
  const workspacePath = resolveWorkspaceRoot(workspaceFolder?.uri.fsPath)
  if (!workspacePath) {
    const provider = new ChatViewProvider(context.extensionUri, undefined, undefined, "Open a trusted workspace folder to use OpenCode Workbench", () => output.show(true), report)
    const participant = vscode.chat.createChatParticipant("opencodeWorkbench.opencode", async (request, _chatContext, stream) => {
      if (request.command === "open") {
        await vscode.commands.executeCommand("opencodeWorkbench.openChat")
        stream.markdown("Opened OpenCode Workbench. Open a trusted workspace folder before starting an OpenCode session.")
        return
      }
      stream.markdown("Open a trusted workspace folder before handing a task to OpenCode. No model request was run in VS Code Chat.")
    })
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "opencodeWorkbench.png")
    context.subscriptions.push(
      provider,
      participant,
      vscode.window.registerWebviewPanelSerializer("opencodeWorkbench.chatEditor", { deserializeWebviewPanel: async (panel) => provider.restoreEditor(panel) }),
      vscode.window.registerWebviewViewProvider("opencodeWorkbench.chat", provider),
      vscode.commands.registerCommand("opencodeWorkbench.openChat", async () => vscode.commands.executeCommand("opencodeWorkbench.chat.focus")),
      vscode.commands.registerCommand("opencodeWorkbench.openChatInEditor", () => provider.openInEditor()),
      vscode.commands.registerCommand("opencodeWorkbench.focusComposer", () => provider.focusComposer()),
      vscode.commands.registerCommand("opencodeWorkbench.toggleTaskWorkbench", () => provider.toggleEditor()),
      vscode.commands.registerCommand("opencodeWorkbench.toggleSessions", () => provider.toggleSessions()),
      vscode.commands.registerCommand("opencodeWorkbench.toggleJobs", () => provider.toggleJobs()),
      vscode.commands.registerCommand("opencodeWorkbench.showAttention", () => provider.showAttention()),
      vscode.commands.registerCommand("opencodeWorkbench.nextAttention", () => provider.openNextAttention()),
      vscode.commands.registerCommand("opencodeWorkbench.openHelp", () => vscode.commands.executeCommand("workbench.action.openWalkthrough", "nulifyer.opencode-workbench#opencodeWorkbench.gettingStarted", false)),
    )
    return
  }
  const canonicalWorkspace = await fs.realpath(workspacePath).catch(() => path.resolve(workspacePath))
  let client: OpenCodeClient | undefined
  let controller: SessionController | undefined
  let chatProvider: ChatViewProvider | undefined
  let deferredReload: DeferredOpenCodeReload | undefined
  let connectionError: string | undefined
  let openCodeVersion: string | undefined
  const mode = serverMode()
  const trace = new TraceService()
  let handoffContinuity: HandoffContinuityService | undefined
  const continuitySessions = new Set<string>()
  const publishedContinuityEvidence = new Set<string>()
  const pendingContinuityEvidence = new Map<string, EvidenceReference>()
  const queuedContinuityEvidence = new Set<string>()
  const runReceiptOrigins = new Map<string, string | undefined>()
  const stateWriter = new SerializedStateWriter((key, value) => context.workspaceState.update(key, value))
  activeStateWriter = stateWriter
  const taskArtifacts = new TaskArtifactService(
    context.workspaceState.get(TASK_ARTIFACTS_STATE),
    (state) => stateWriter.write(TASK_ARTIFACTS_STATE, state),
    (message) => report(`Task artifacts: ${message}`),
  )
  const sessionPresentation = new SessionPresentationService(
    context.workspaceState.get<unknown[]>(SESSION_PRESENTATION_STATE) ?? [],
    (pins) => stateWriter.write(SESSION_PRESENTATION_STATE, pins),
  )
  const recovery = new RecoveryPreviewService()
  const contextReceipts = new ContextReceiptService(
    context.workspaceState.get<ContextReceipt[]>(CONTEXT_RECEIPTS_STATE) ?? [],
    (receipts) => stateWriter.write(CONTEXT_RECEIPTS_STATE, receipts),
  )
  const gitRunner = new TypedGitRunner()
  const worktrees = new WorktreeService(
    gitRunner,
    context.workspaceState.get<WorktreeJournalEntry[]>(WORKTREE_JOURNAL_STATE) ?? [],
    async (entries) => {
      stateWriter.write(WORKTREE_JOURNAL_STATE, entries)
      await stateWriter.flush()
    },
  )
  const runGroups = new RunGroupService(
    context.workspaceState.get<RunGroup[]>(RUN_GROUPS_STATE) ?? [],
    async (groups) => {
      stateWriter.write(RUN_GROUPS_STATE, groups)
      await stateWriter.flush()
    },
  )
  const runComparison = new RunComparisonService(gitRunner)
  const diffs = new DiffService(gitRunner)
  const queueContinuityEvidence = (entry: EvidenceReference): void => {
    if (!handoffContinuity || !entry.sessionID || !continuitySessions.has(entry.sessionID) || publishedContinuityEvidence.has(entry.id)) return
    pendingContinuityEvidence.set(entry.id, entry)
    if (queuedContinuityEvidence.has(entry.id)) return
    queuedContinuityEvidence.add(entry.id)
    handoffContinuity.queueHandoff({ targetDirectory: canonicalWorkspace, targetSessionID: entry.sessionID, evidence: [entry] })
  }
  const queueLatestContinuityEvidence = (entries: readonly EvidenceReference[]): void => {
    const grouped = new Map<string, EvidenceReference[]>()
    for (const entry of entries) {
      if (!entry.sessionID || !continuitySessions.has(entry.sessionID)) continue
      const values = grouped.get(entry.sessionID) ?? []
      values.push(entry)
      grouped.set(entry.sessionID, values)
    }
    for (const values of grouped.values()) {
      for (const entry of values.sort((left, right) => right.observedAt - left.observedAt || left.id.localeCompare(right.id)).slice(0, 199)) queueContinuityEvidence(entry)
    }
  }
  const flushContinuityEvidence = async (): Promise<void> => {
    if (!handoffContinuity) return
    for (const entry of pendingContinuityEvidence.values()) queueContinuityEvidence(entry)
    const attempted = [...queuedContinuityEvidence]
    try {
      await handoffContinuity.flush()
    } catch (error) {
      for (const id of attempted) queuedContinuityEvidence.delete(id)
      throw error
    }
    for (const id of attempted) {
      queuedContinuityEvidence.delete(id)
      pendingContinuityEvidence.delete(id)
      publishedContinuityEvidence.add(id)
    }
  }
  const evidence = new EvidenceService(
    context.workspaceState.get<EvidenceReference[]>(EVIDENCE_STATE) ?? [],
    (entries) => {
      stateWriter.write(EVIDENCE_STATE, entries)
      queueLatestContinuityEvidence(entries)
    },
  )
  const walkthroughs = new WalkthroughService(
    context.workspaceState.get<WalkthroughDocument[]>(WALKTHROUGHS_STATE) ?? [],
    (documents) => stateWriter.write(WALKTHROUGHS_STATE, documents),
  )
  const diffCaptures = new Map<string, DiffCapture>()
  const turnBaselines = new Map<string, { promptID: string; headRef: string; clean: boolean }>()
  const latestTurnDiffs = new Map<string, DiffCapture>()
  const reviews = new ReviewService()
  let multiRun: MultiRunOrchestrator | undefined
  let goalVerifier: GoalVerifierService | undefined
  try {
    const store = await GitCommonDirectoryHandoffStore.create(gitRunner, canonicalWorkspace)
    handoffContinuity = new HandoffContinuityService(store)
    activeHandoffContinuity = handoffContinuity
    const imported = await handoffContinuity.importHandoff(canonicalWorkspace)
    for (const record of imported.records) continuitySessions.add(record.targetSessionID)
    const newReceipts = imported.receipts.filter((entry) => !contextReceipts.get(entry.id))
    const localEvidenceIDs = new Set(evidence.list().map((entry) => entry.id))
    const newEvidence = imported.evidence.filter((entry) => !localEvidenceIDs.has(entry.id))
    for (const entry of newEvidence) publishedContinuityEvidence.add(entry.id)
    contextReceipts.merge(newReceipts)
    evidence.merge(newEvidence)
    queueLatestContinuityEvidence(evidence.list())
    await flushContinuityEvidence()
    await stateWriter.flush()
    for (const limitation of imported.limitations) report(`Cross-workspace continuity: ${limitation}`)
  } catch (error) {
    handoffContinuity = undefined
    activeHandoffContinuity = undefined
    report(`Cross-workspace continuity is unavailable: ${userFacingError(error)}`)
  }
  const requireContinuity = (): HandoffContinuityService => {
    if (!handoffContinuity) throw new Error("Private cross-workspace continuity is unavailable; isolated Workbench workflows are disabled for this repository")
    return handoffContinuity
  }
  const flushDurableMetadata = async (): Promise<void> => {
    await sessionPresentation.flush()
    await stateWriter.flush()
    await flushContinuityEvidence()
  }
  activeDurableMetadataFlush = flushDurableMetadata
  const publishIsolatedHandoff = async (entry: WorktreeJournalEntry, originReceiptIDs: string[] = [], extraEvidence: EvidenceReference[] = []): Promise<void> => {
    const continuity = requireContinuity()
    if (!entry.sessionID) throw new Error("The isolated handoff did not retain its session identity")
    const receipt = entry.promptID ? contextReceipts.get(`context:${entry.promptID}`) : undefined
    if (entry.promptID && !receipt) throw new Error("The isolated handoff context receipt was not committed")
    const targetDirectory = await fs.realpath(entry.path)
    await flushDurableMetadata()
    await continuity.exportHandoff({ targetDirectory, targetSessionID: entry.sessionID, trackingOnly: !receipt && !extraEvidence.length, originReceiptIDs, receipts: receipt ? [receipt] : [], evidence: extraEvidence })
    await continuity.flush()
  }
  const publishRunContinuity = async (group: RunGroup): Promise<void> => {
    const continuity = requireContinuity()
    await flushDurableMetadata()
    await Promise.all(group.runs.flatMap((run) => {
      if (!run.worktreeID || run.session.sessionID === "pending") return []
      const journal = worktrees.get(run.worktreeID)
      if (journal?.phase !== "prompt-admitted") return []
      const receipt = journal?.promptID ? contextReceipts.get(`context:${journal.promptID}`) : undefined
      if (!journal?.promptID || !receipt) throw new Error(`Run ${run.id} did not commit its per-message context receipt`)
      return [fs.realpath(run.session.directory).then((targetDirectory) => continuity.exportHandoff({ targetDirectory, targetSessionID: run.session.sessionID, originReceiptIDs: [group.promptReceiptID], receipts: [receipt] }))]
    }))
    await continuity.flush()
  }
  const collectRunObservations = async (group: RunGroup): Promise<Record<string, ReturnType<typeof observeRunMessages> & { evidence: EvidenceReference[] }>> => {
    if (!client) return {}
    const entries = await Promise.all(group.runs.map(async (run) => {
      if (handoffContinuity && run.session.sessionID !== "pending") {
        const imported = await handoffContinuity.importHandoff(await fs.realpath(run.session.directory), run.session.sessionID)
        const newReceipts = imported.receipts.filter((entry) => !contextReceipts.get(entry.id))
        const localEvidenceIDs = new Set(evidence.list().map((entry) => entry.id))
        const newEvidence = imported.evidence.filter((entry) => !localEvidenceIDs.has(entry.id))
        for (const entry of newEvidence) publishedContinuityEvidence.add(entry.id)
        contextReceipts.merge(newReceipts)
        evidence.merge(newEvidence)
        for (const limitation of imported.limitations) report(`Run ${run.id} continuity: ${limitation}`)
      }
      const messages = run.session.sessionID === "pending" ? [] : await client!.forDirectory(run.session.directory).messages(run.session.sessionID).catch(() => [])
      const scoped = [...evidence.list({ sessionID: run.session.sessionID }), ...evidence.list({ runGroupID: group.id, runID: run.id })]
      const uniqueEvidence = [...new Map(scoped.map((entry) => [entry.id, entry])).values()]
      return [run.id, { ...observeRunMessages(messages), evidence: uniqueEvidence }] as const
    }))
    return Object.fromEntries(entries)
  }
  void worktrees.recover().catch((error) => report(`Worktree recovery failed: ${errorMessage(error)}`))

  {
    activeBridge = new VsCodeBridge(workspacePath, {
      requestOpenCodeReload: mode === "managed" ? (request) => {
        if (!deferredReload) throw new Error("Managed OpenCode reload is not ready")
        return deferredReload.request(request)
      } : undefined,
      terminalEvidence: ({ sessionID, exitCode }) => {
        evidence.record({ kind: "terminal", label: "OpenCode terminal command", status: exitCode === 0 ? "passed" : exitCode === undefined ? "unknown" : "failed", sessionID, repository: workspacePath, summary: exitCode === undefined ? "Terminal execution ended without a reported exit code" : `Terminal execution exited with code ${exitCode}` })
      },
      taskEvidence: ({ sessionID, name, source, group, exitCode }) => {
        evidence.record({ kind: group === vscode.TaskGroup.Test.id ? "test" : "task", label: name, status: exitCode === 0 ? "passed" : exitCode === undefined ? "unknown" : "failed", sourceID: source, sessionID, repository: workspacePath, summary: exitCode === undefined ? "Task ended without a reported exit code" : `Task exited with code ${exitCode}` })
      },
    })
    try {
      let initialConnection: OpenCodeConnection
      if (mode === "managed") {
        const configuration = vscode.workspace.getConfiguration("opencodeWorkbench")
        activeManagedServer = new ManagedOpenCodeServer({
          directory: workspacePath,
          extensionPath: context.extensionPath,
          executablePath: configuration.get<string>("executablePath")?.trim() || undefined,
          startupTimeoutMilliseconds: configuration.get<number>("managedServerStartupTimeout", 120) * 1_000,
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
      goalVerifier = new GoalVerifierService(createOpenCodeGoalVerifierInvocation(() => client!.forDirectory(workspacePath)))
      multiRun = new MultiRunOrchestrator(runGroups, worktrees, {
        forDirectory: (directory) => {
          const runtime = client!.forDirectory(directory)
          return {
            createSession: (title) => runtime.createSession(title),
            sendPrompt: (...args) => runtime.sendPrompt(...args),
            abort: (sessionID) => runtime.abort(sessionID),
            statuses: () => runtime.sessionStatuses(),
            needsInput: async (sessionID) => {
              const [permissions, questions] = await Promise.all([runtime.pendingPermissions(), runtime.pendingQuestions()])
              return permissions.some((request) => request.sessionID === sessionID) || questions.some((request) => request.sessionID === sessionID)
            },
            inspectSession: async (sessionID) => {
              const exists = (await runtime.listSessions()).some((session) => session.id === sessionID)
              return { exists, messages: exists ? await runtime.messages(sessionID) : [] }
            },
          }
        },
      }, {
        monitorIntervalMilliseconds: 1_000,
        admission: {
          prepare: (sourceReceiptID, sessionID, promptID) => {
            const source = sourceReceiptID ? contextReceipts.get(sourceReceiptID) : undefined
            runReceiptOrigins.set(promptID, sourceReceiptID)
            contextReceipts.stage(sessionID, promptID, source?.items ?? [], source?.truncation ?? "none")
          },
          admit: (sessionID, promptID) => {
            const receipt = contextReceipts.admit(sessionID, promptID)
            const sourceReceiptID = runReceiptOrigins.get(promptID)
            runReceiptOrigins.delete(promptID)
            const journal = receipt ? worktrees.journal().find((entry) => entry.sessionID === sessionID && entry.promptID === promptID) : undefined
            if (receipt && journal && handoffContinuity) {
              handoffContinuity.queueHandoff({ targetDirectory: journal.path, targetSessionID: sessionID, originReceiptIDs: sourceReceiptID ? [sourceReceiptID] : [], receipts: [receipt] })
            }
          },
          reject: (promptID) => {
            runReceiptOrigins.delete(promptID)
            contextReceipts.reject(promptID)
          },
        },
      })
      activeMultiRun = multiRun
      context.subscriptions.push({ dispose: () => multiRun?.dispose() })
      void Promise.all(runGroups.list().map(async (group) => {
        const refreshed = await multiRun!.refresh(group.id)
        if (handoffContinuity) await publishRunContinuity(refreshed)
      })).catch((error) => report(`Run-group recovery failed: ${errorMessage(error)}`))
      const validateExternalVersion = async (): Promise<void> => {
        const health = await client!.health()
        openCodeVersion = health.version
        if (!supportedVersion(health.version)) throw new Error(`OpenCode ${health.version} is not supported; install a compatible 1.18.x release at or above 1.18.11`)
      }
      if (mode === "external") {
        try {
          await validateExternalVersion()
        } catch (error) {
          connectionError = errorMessage(error)
          report(`OpenCode initial connection failed: ${connectionError}`)
        }
      }
      if (mode === "managed") openCodeVersion = (await client.health()).version
      const globalPreferences = context.globalState.get<ComposerPreferences>("opencodeWorkbench.composerPreferences")
      const preferences = globalPreferences ?? context.workspaceState.get<ComposerPreferences>("opencodeWorkbench.composerPreferences")
      if (!globalPreferences && preferences) await context.globalState.update("opencodeWorkbench.composerPreferences", preferences)
      controller = new SessionController(client, {
        error: (message) => {
          trace.record({ type: "controller.error", error: "Controller operation failed; inspect the extension output for sanitized operational details" })
          report(message)
        },
        preferencesChanged: (preferences) => void context.globalState.update("opencodeWorkbench.composerPreferences", preferences),
        selectionChanged: (sessionID) => {
          trace.record({ type: "session.selected", sessionID, transition: "selection" })
          void context.workspaceState.update(SELECTED_SESSION_STATE, sessionID)
        },
        sessionRecovered: (sourceSessionID, recoveredSessionID) => {
          trace.record({ type: "session.recovered", sessionID: recoveredSessionID, requestID: sourceSessionID, transition: "legacy->compatible-fork" })
          const recovered = context.workspaceState.get<Record<string, string>>(RECOVERED_SESSIONS_STATE) ?? {}
          void context.workspaceState.update(RECOVERED_SESSIONS_STATE, { ...recovered, [sourceSessionID]: recoveredSessionID })
        },
        promptAdmitted: (sessionID, promptID, admittedAt) => {
          trace.record({ type: "admission.committed", sessionID, requestID: promptID, timestamp: admittedAt, transition: "pending->admitted" })
          const receipt = contextReceipts.admit(sessionID, promptID, admittedAt)
          if (receipt?.items.length) {
            try {
              taskArtifacts.create({
                kind: "context-capture",
                sessionID,
                lifecycle: "active",
                payload: {
                  promptID,
                  receiptID: receipt.id,
                  admittedAt: receipt.admittedAt,
                  truncation: receipt.truncation,
                  estimatedTokens: receipt.estimatedTokens,
                  sources: receipt.items.map((item) => ({
                    id: item.id,
                    kind: item.kind,
                    label: item.label,
                    uri: item.uri,
                    range: item.range,
                    revision: item.revision,
                    contentHash: item.contentHash,
                    estimatedTokens: item.estimatedTokens,
                    truncated: item.truncated,
                  })),
                },
              }, `context-capture:${promptID}`)
            } catch (error) {
              report(`Could not persist context receipt metadata: ${errorMessage(error)}`)
            }
          }
          const directory = controller?.snapshot.sessions[sessionID]?.info.directory
          if (directory) void diffs.captureTurnBaseline(directory).then((baseline) => turnBaselines.set(sessionID, { promptID, ...baseline })).catch((error) => report(`Could not capture turn diff baseline: ${errorMessage(error)}`))
        },
        validateConnection: mode === "external" ? validateExternalVersion : undefined,
        openExternal: async (value) => {
          const url = new URL(value)
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OpenCode requested an unsupported external URL")
          const choice = await vscode.window.showWarningMessage("OpenCode could not launch the MCP authentication page.", "Open in browser")
          if (choice !== "Open in browser") return
          if (!await vscode.env.openExternal(vscode.Uri.parse(url.toString()))) throw new Error("VS Code did not open the external URL")
        },
      }, preferences, context.workspaceState.get<string>(SELECTED_SESSION_STATE), context.workspaceState.get<Record<string, string>>(RECOVERED_SESSIONS_STATE))
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
      connectionError = errorMessage(error)
      report(`OpenCode connection setup failed: ${connectionError}`)
    }
    try {
      await activeBridge.start()
      context.subscriptions.push(activeBridge)
    } catch (error) {
      activeBridge = undefined
      report(`OpenCode VS Code bridge failed: ${errorMessage(error)}`)
    }
  }

  let health: HealthService | undefined
  const openRawHealth = async (): Promise<void> => {
    if (!health) return
    const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(health.snapshot(), null, 2) })
    await vscode.window.showTextDocument(document, { preview: false })
  }
  const openRawTrace = async (): Promise<void> => {
    const document = await vscode.workspace.openTextDocument({ language: "jsonl", content: trace.toJsonLines() || "" })
    await vscode.window.showTextDocument(document, { preview: false })
  }
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    controller,
    workspacePath,
    connectionError,
    () => output.show(true),
    report,
    contextReceipts,
    runGroups,
    multiRun,
    walkthroughs,
    worktrees,
    (observation) => trace.record(observation),
    {
      artifacts: taskArtifacts,
      evidence,
      recovery,
      sessionPresentation,
      health: () => health ? workbenchHealthSummary(health.snapshot()) : undefined,
      trace: () => trace.snapshot().slice(-100).map((entry) => ({
        type: entry.type,
        timestamp: entry.timestamp,
        sessionID: entry.sessionID,
        transition: entry.transition,
        durationMilliseconds: entry.durationMilliseconds,
      })),
      captureBrowserContext: async (request) => { await vscode.commands.executeCommand("opencodeWorkbench.captureBrowserContext", request) },
      openHealth: openRawHealth,
      openTrace: openRawTrace,
    },
  )
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer("opencodeWorkbench.chatEditor", {
    deserializeWebviewPanel: async (panel) => chatProvider!.restoreEditor(panel),
  }))
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
  health = new HealthService(() => {
    const state = controller?.snapshot
    const protocolHealth = chatProvider!.protocolHealth()
    return {
      workbenchVersion: String(context.extension.packageJSON.version ?? "unknown"),
      vscodeVersion: vscode.version,
      experienceMode: "workbench" as const,
      openCodeVersion,
      transportMode: "http-sse" as const,
      serverMode: mode,
      serverState: connectionError ? "failed" as const : state?.connected ? "connected" as const : state?.connectionState === "reconnecting" ? "reconnecting" as const : "disconnected" as const,
      pluginState: protocolHealth.runtime.companion === "connected" ? "available" as const : "unavailable" as const,
      capabilities: protocolHealth.capabilities,
      eventStreamState: state?.connectionState ?? "disconnected",
      requestQueueDepth: protocolHealth.requestQueueDepth,
      protocol: protocolHealth.protocol,
      authorizedRoots: [workspacePath],
    }
  })
  let lastConnectionState = controller?.snapshot.connectionState
  const telemetrySubscription = controller?.subscribe((update) => {
    const event = update.type === "event" ? update.event : undefined
    const sessionID = "sessionID" in update && typeof update.sessionID === "string"
      ? update.sessionID
      : event && typeof event.properties.sessionID === "string" ? event.properties.sessionID : undefined
    const transition = event?.type === "session.status" && typeof event.properties.status === "object" && event.properties.status !== null && "type" in event.properties.status
      ? String(event.properties.status.type).slice(0, 256)
      : update.type === "permissions" ? `${update.permissions.length} pending`
      : update.type === "questions" ? `${update.questions.length} pending`
      : update.type === "queue" ? update.prompt.delivery
      : undefined
    trace.record({ type: controllerTraceCategory(update.type, event?.type), sessionID, transition })
    if (update.type === "event") health.eventObserved()
    if (update.type === "reconcile") health.reconciled()
    if (update.type === "changes") {
      const directory = controller?.snapshot.sessions[update.sessionID]?.info.directory
      const baseline = turnBaselines.get(update.sessionID)
      if (directory && baseline) void diffs.capture({ repository: directory, scope: "turn", baseRef: baseline.headRef, baselineClean: baseline.clean }).then((capture) => {
        latestTurnDiffs.set(`${update.sessionID}:${baseline.promptID}`, capture)
        evidence.recordDiff(capture.snapshot, { sessionID: update.sessionID })
        trace.record({ type: "diff.captured", sessionID: update.sessionID, requestID: baseline.promptID, diffHash: capture.snapshot.unifiedDiffHash, transition: capture.snapshot.complete ? "complete" : "incomplete" })
      }).catch((error) => report(`Could not capture per-turn changes: ${errorMessage(error)}`))
    }
    const next = controller?.snapshot.connectionState
    if (next === "connected") connectionError = undefined
    if (next === "connected" && lastConnectionState === "reconnecting") {
      health.reconnected()
      trace.record({ type: "connection.recovered", transition: "reconnecting->connected" })
    }
    lastConnectionState = next
  })
  if (telemetrySubscription) context.subscriptions.push(telemetrySubscription)

  const run = <TArgs extends unknown[]>(operation: (...args: TArgs) => Promise<unknown>) => async (...args: TArgs): Promise<void> => {
    const mutationID = randomUUID()
    const startedAt = Date.now()
    trace.record({ type: "command.started", mutationID })
    try {
      await operation(...args)
      trace.record({ type: "command.completed", mutationID, durationMilliseconds: Date.now() - startedAt })
    } catch (error) {
      trace.record({ type: "command.failed", mutationID, durationMilliseconds: Date.now() - startedAt, error: "Command failed; inspect the extension output for operational details" })
      report(errorMessage(error))
      if (!isUserCancellation(error)) await vscode.window.showErrorMessage(`OpenCode Workbench: ${userFacingError(error)}`)
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeWorkbench.openChat", async () => {
      await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
    }),
    vscode.commands.registerCommand("opencodeWorkbench.openChatInEditor", () => {
      chatProvider.openInEditor()
    }),
    vscode.commands.registerCommand("opencodeWorkbench.focusComposer", () => chatProvider.focusComposer()),
    vscode.commands.registerCommand("opencodeWorkbench.toggleTaskWorkbench", () => chatProvider.toggleEditor()),
    vscode.commands.registerCommand("opencodeWorkbench.toggleSessions", () => chatProvider.toggleSessions()),
    vscode.commands.registerCommand("opencodeWorkbench.toggleJobs", () => chatProvider.toggleJobs()),
    vscode.commands.registerCommand("opencodeWorkbench.showAttention", () => chatProvider.showAttention()),
    vscode.commands.registerCommand("opencodeWorkbench.nextAttention", () => chatProvider.openNextAttention()),
    vscode.commands.registerCommand("opencodeWorkbench.openHelp", async () => {
      await vscode.commands.executeCommand("workbench.action.openWalkthrough", "nulifyer.opencode-workbench#opencodeWorkbench.gettingStarted", false)
    }),
    vscode.commands.registerCommand("opencodeWorkbench.showHealth", async () => {
      chatProvider.openInEditor("health")
    }),
    vscode.commands.registerCommand("opencodeWorkbench.showTrace", async () => {
      chatProvider.openInEditor("health")
    }),
    vscode.commands.registerCommand("opencodeWorkbench.openRawHealth", openRawHealth),
    vscode.commands.registerCommand("opencodeWorkbench.openRawTrace", openRawTrace),
    vscode.commands.registerCommand("opencodeWorkbench.taskArtifactAction", run(async (raw: unknown) => {
      if (!raw || typeof raw !== "object") throw new Error("Invalid task artifact action")
      const action = raw as { sessionID?: unknown; artifactID?: unknown; action?: unknown; expectedRevision?: unknown; findingID?: unknown; disposition?: unknown }
      if (typeof action.sessionID !== "string" || typeof action.artifactID !== "string" || typeof action.action !== "string") throw new Error("Invalid task artifact action")
      const artifact = taskArtifacts.get(action.sessionID, action.artifactID)
      if (!artifact) throw new Error("Task artifact is no longer available")
      const expectedRevision = Number.isSafeInteger(action.expectedRevision) ? Number(action.expectedRevision) : artifact.revision
      if (action.action === "set-finding-disposition") {
        if (artifact.kind !== "review" || typeof action.findingID !== "string" || !["open", "fixed", "dismissed", "accepted-risk"].includes(String(action.disposition))) throw new Error("Invalid review finding disposition")
        const findingID = action.findingID
        if (!artifact.payload.document.findings.some((finding) => finding.id === findingID)) throw new Error("Review finding is no longer available")
        const capture = await diffs.capture({ repository: artifact.payload.repository, scope: artifact.payload.scope, baseRef: artifact.payload.baseRef })
        if (!capture.snapshot.complete || capture.snapshot.unifiedDiffHash !== artifact.payload.diffHash || artifact.payload.stale) {
          if (!artifact.payload.stale && artifact.revision === expectedRevision) {
            taskArtifacts.update(artifact.sessionID, artifact.id, expectedRevision, (draft) => {
              if (draft.kind === "review") draft.payload.stale = true
            })
            await stateWriter.flush()
          }
          throw new Error("The reviewed diff changed; regenerate the review before changing a finding disposition")
        }
        const disposition = action.disposition as "open" | "fixed" | "dismissed" | "accepted-risk"
        taskArtifacts.update(artifact.sessionID, artifact.id, expectedRevision, (draft) => {
          if (draft.kind !== "review") return
          draft.payload.dispositions = [
            ...draft.payload.dispositions.filter((entry) => entry.findingID !== findingID),
            { findingID, state: disposition, updatedAt: Date.now() },
          ]
        })
        await stateWriter.flush()
        return
      }
      if (action.action === "open-finding") {
        await vscode.commands.executeCommand("opencodeWorkbench.openReviewFinding", artifact.sessionID, artifact.id, action.findingID)
        return
      }
      if (action.action === "regenerate") {
        if (artifact.kind !== "review") throw new Error("Only review artifacts can be regenerated")
        await vscode.commands.executeCommand("opencodeWorkbench.reviewChanges", artifact.payload.repository, artifact.payload.baseRef, artifact.sessionID)
        return
      }
      if (action.action === "approve") {
        if (artifact.kind !== "plan") throw new Error("Only plan artifacts can be approved")
        const document = vscode.window.activeTextEditor?.document
        if (!document) throw new Error("Open the plan document before approving it")
        if (document.uri.scheme === "untitled") throw new Error("Save the plan to a user-owned Markdown file before approving it")
        const storedUri = vscode.Uri.parse(artifact.payload.uri, true)
        if (storedUri.scheme !== "untitled" && document.uri.toString() !== artifact.payload.uri) throw new Error("Open the plan document before approving it")
        const planSessionID = /^> OpenCode session:\s*(\S+)\s*$/m.exec(document.getText())?.[1]
        if (planSessionID !== artifact.sessionID) throw new Error("The open Markdown document does not belong to this OpenCode plan session")
        const reference = createPlanReference(document.uri.toString(), document.getText(), Date.now())
        taskArtifacts.update(artifact.sessionID, artifact.id, expectedRevision, (draft) => {
          if (draft.kind !== "plan") return
          draft.payload.phase = "approved"
          draft.payload.uri = reference.uri
          draft.payload.revision = reference.revision
          draft.payload.approvedAt = reference.approvedAt
          delete draft.payload.handoffs
        })
        await stateWriter.flush()
        return
      }
      const openArtifact = async (): Promise<void> => {
        if (artifact.kind === "plan") {
          const uri = vscode.Uri.parse(artifact.payload.uri, true)
          if (uri.scheme !== "untitled") {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false })
            return
          }
          if (!client) throw new Error("OpenCode is unavailable")
          const directory = controller?.snapshot.sessions[artifact.sessionID]?.info.directory ?? workspacePath
          const messages = await client.forDirectory(directory).messages(artifact.sessionID)
          const result = messages.slice().reverse().find((message) => message.info.role === "assistant")?.parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n").trim()
          if (!result) throw new Error("The OpenCode plan transcript is no longer available")
          const document = await vscode.workspace.openTextDocument({ language: "markdown", content: `# OpenCode Plan\n\n> OpenCode session: ${artifact.sessionID}\n\n${result}\n` })
          await vscode.window.showTextDocument(document, { preview: false })
          return
        }
        if (artifact.kind === "review") {
          const review = artifact.payload.document
          const markdown = [`# OpenCode Review Findings`, ``, `Diff: \`${review.diffHash}\`${artifact.payload.stale ? " · **STALE**" : ""}`, ``, ...(review.findings.length ? review.findings.flatMap((finding) => [`## [${finding.severity.toUpperCase()}] ${finding.title}`, ``, finding.detail, ``, ...finding.anchors.map((anchor) => `- ${anchor.file}:${anchor.startLine}-${anchor.endLine} (${anchor.side})`), ``]) : ["No findings were returned."])].join("\n")
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "markdown", content: markdown }), { preview: false })
          return
        }
        if (artifact.kind === "run-comparison") {
          const group = runGroups.get(artifact.payload.groupID)
          const content = group ? runComparison.markdown(group, artifact.payload.rows) : JSON.stringify(artifact.payload, null, 2)
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: group ? "markdown" : "json", content }), { preview: false })
          return
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(artifact.payload, null, 2) }), { preview: false })
      }
      if (action.action === "handoff") {
        if (artifact.kind !== "plan") throw new Error("Only plan artifacts can be handed off")
        await openArtifact()
        await vscode.commands.executeCommand("opencodeWorkbench.handoffPlan")
        return
      }
      if (action.action === "open") await openArtifact()
    })),
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
    vscode.commands.registerCommand("opencodeWorkbench.planTask", run(async () => {
      if (!controller || !client) throw new Error("Open a workspace folder before planning with OpenCode")
      chatProvider.openInEditor("plan")
      const objective = await vscode.window.showInputBox({ title: "Plan Task", prompt: "What should OpenCode plan?", ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : "Enter a task to plan" })
      if (!objective) return
      const sessionID = await controller.createSession(`Plan: ${objective.trim().slice(0, 120)}`)
      controller.setPreference("plan")
      const initialContent = planArtifact(objective, undefined, sessionID)
      const document = await vscode.workspace.openTextDocument({ language: "markdown", content: initialContent })
      await vscode.window.showTextDocument(document, { preview: false })
      const initialReference = createPlanReference(document.uri.toString(), initialContent)
      const planRecord = taskArtifacts.create({
        kind: "plan",
        sessionID,
        lifecycle: "active",
        producer: { sessionID },
        payload: { phase: "generating", uri: initialReference.uri, revision: initialReference.revision },
      })
      const initialVersion = document.version
      const promptID = createOpenCodeMessageID()
      contextReceipts.stage(sessionID, promptID, [], "none")
      try {
        await controller.send(structuredPlanPrompt(objective), "plan", undefined, undefined, [], [], promptID)
      } catch (error) {
        contextReceipts.reject(promptID)
        throw error
      }
      void waitForAssistantResult(client.forDirectory(workspacePath), sessionID).then(async (result) => {
        const updated = planArtifact(objective, result, sessionID)
        let targetUri = document.uri
        if (generatedPlanDisposition(initialVersion, document.version) === "preserve-user-draft") {
          const generated = await vscode.workspace.openTextDocument({ language: "markdown", content: updated })
          await vscode.window.showTextDocument(generated, { preview: false })
          targetUri = generated.uri
          void vscode.window.showInformationMessage("Your edited plan draft was preserved. OpenCode's completed plan opened in a separate document for review.")
        } else if (!document.isClosed) {
          const edit = new vscode.WorkspaceEdit()
          const last = document.lineAt(document.lineCount - 1).range.end
          edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), last), updated)
          if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code did not apply the generated plan to its untitled document")
        }
        const current = taskArtifacts.get(sessionID, planRecord.id)
        if (current?.kind === "plan" && current.payload.phase === "generating") {
          const ready = createPlanReference(targetUri.toString(), updated)
          taskArtifacts.update(sessionID, current.id, current.revision, (draft) => {
            if (draft.kind !== "plan") return
            draft.payload.phase = "ready"
            draft.payload.uri = ready.uri
            draft.payload.revision = ready.revision
          })
          await stateWriter.flush()
        }
      }).catch((error) => {
        const current = taskArtifacts.get(sessionID, planRecord.id)
        if (current?.kind === "plan" && current.payload.phase === "generating") taskArtifacts.update(sessionID, current.id, current.revision, (draft) => {
          if (draft.kind === "plan") draft.payload.phase = "failed"
        })
        report(`Plan generation failed: ${errorMessage(error)}`)
      })
    })),
    vscode.commands.registerCommand("opencodeWorkbench.handoffPlan", run(async () => {
      if (!controller) throw new Error("Open a workspace folder before handing off a plan")
      const document = vscode.window.activeTextEditor?.document
      if (!document || document.languageId !== "markdown") throw new Error("Open the approved Markdown plan before handing it off")
      if (document.uri.scheme === "untitled") throw new Error("Save and approve the plan before handing it off")
      const content = document.getText()
      if (!content.trim()) throw new Error("The approved plan is empty")
      const reference = createPlanReference(document.uri.toString(), content, Date.now())
      const planSessionID = /^> OpenCode session:\s*(\S+)\s*$/m.exec(content)?.[1]
      if (!planSessionID) throw new Error("The open Markdown document is not linked to an OpenCode plan session")
      const planArtifactRecord = taskArtifacts.list(planSessionID).find((artifact) => artifact.kind === "plan" && artifact.lifecycle === "active")
      if (!planArtifactRecord || planArtifactRecord.kind !== "plan") throw new Error("The approved OpenCode plan artifact is no longer available")
      if (!["approved", "handed-off"].includes(planArtifactRecord.payload.phase)) throw new Error("Approve this saved plan in the Task Workbench before handing it off")
      if (planArtifactRecord.payload.uri !== reference.uri || planArtifactRecord.payload.revision !== reference.revision) {
        throw new Error("The plan changed after approval; approve the current saved revision before handing it off")
      }
      chatProvider.openInEditor("plan")
      const choice = await vscode.window.showQuickPick([
        { label: "Implementation session", description: "Implement in the current checkout", value: "implementation" },
        { label: "Isolated worktree session", description: "Implement in a new Workbench-owned worktree", value: "isolated" },
        { label: "Multi-run", description: "Run the approved plan with two to five models", value: "multi-run" },
        { label: "Active goal", description: "Create a goal and implement the approved plan", value: "goal" },
      ], { title: "Handoff Approved Plan", placeHolder: "Choose the next OpenCode workflow" })
      if (!choice) return
      const references = context.workspaceState.get<PlanReference[]>(PLAN_REFERENCES_STATE) ?? []
      await context.workspaceState.update(PLAN_REFERENCES_STATE, [...references, reference].slice(-100))
      const recordPlanHandoff = (handoff: { mode: "implementation" | "isolated" | "multi-run" | "goal"; sessionIDs?: string[]; runGroupID?: string; worktreeID?: string }): void => {
        if (!planArtifactRecord) return
        const current = taskArtifacts.get(planArtifactRecord.sessionID, planArtifactRecord.id)
        if (!current || current.kind !== "plan") return
        const relatedSessionIDs = [...new Set([...(current.payload.relatedSessionIDs ?? []), ...(handoff.sessionIDs ?? [])])]
        taskArtifacts.update(current.sessionID, current.id, current.revision, (draft) => {
          if (draft.kind !== "plan") return
          draft.payload.phase = "handed-off"
          draft.payload.uri = reference.uri
          draft.payload.revision = reference.revision
          draft.payload.approvedAt = reference.approvedAt
          draft.payload.relatedSessionIDs = relatedSessionIDs.length ? relatedSessionIDs : undefined
          draft.payload.handoffs = [...(draft.payload.handoffs ?? []), { ...handoff, createdAt: Date.now() }]
        })
      }
      const file = { type: "file" as const, mime: "text/markdown", filename: "approved-plan.md", url: `data:text/markdown;base64,${Buffer.from(content).toString("base64")}` }
      const implementationPrompt = `Implement the approved plan referenced by ${reference.id}. Preserve its acceptance criteria and report validation evidence.`
      if (choice.value === "isolated") {
        if (!client) throw new Error("OpenCode runtime is unavailable")
        requireContinuity()
        const entry = await startIsolatedTask(client, worktrees, workspacePath, {
          title: "Implement approved plan",
          prompt: implementationPrompt,
          slug: "plan",
          agent: "build",
          files: [file],
          admission: {
            prepare: (sessionID, promptID) => contextReceipts.stage(sessionID, promptID, promptFileReceiptItems([file], reference.id), "none"),
            admit: (sessionID, promptID) => { contextReceipts.admit(sessionID, promptID) },
            reject: (promptID) => contextReceipts.reject(promptID),
          },
        })
        await publishIsolatedHandoff(entry)
        recordPlanHandoff({ mode: "isolated", sessionIDs: entry.sessionID ? [entry.sessionID] : undefined, worktreeID: entry.id })
        await stateWriter.flush()
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(entry.path), true)
        return
      }
      if (choice.value === "multi-run") {
        if (!multiRun) throw new Error("OpenCode Multi-run is unavailable")
        requireContinuity()
        const models = controller.chatSnapshot().models.map((model) => ({ label: model.name, description: model.providerID, value: `${model.providerID}/${model.id}` }))
        const selected = await vscode.window.showQuickPick(models, { canPickMany: true, title: "Plan Multi-run", placeHolder: "Select two to five models" })
        if (!selected || selected.length < 2 || selected.length > 5) throw new Error("Select two to five models")
        const repository = await worktrees.repository(workspacePath)
        const baseRef = (await gitRunner.run(["rev-parse", "HEAD"], repository.root)).stdout.trim()
        const mutationID = randomUUID()
        contextReceipts.stage(`run-group:${mutationID}`, mutationID, [{ id: reference.id, kind: "attachment", label: "Approved plan", contentHash: reference.revision, bytes: Buffer.byteLength(content) }], "none")
        const receipt = contextReceipts.admit(`run-group:${mutationID}`, mutationID)!
        const group = await multiRun.start({ mutationID, title: "Implement approved plan", repository: repository.root, baseRef, promptReceiptID: receipt.id, prompt: implementationPrompt, files: [file], runs: selected.map((model, index) => ({ id: `run-${index + 1}`, model: model.value, agent: "build" })), worktreeParent: path.join(path.dirname(repository.root), `.${path.basename(repository.root)}-worktrees`, `run-${mutationID.slice(0, 8)}`), runtimeEpoch: `http-sse:${Date.now()}` })
        await publishRunContinuity(group)
        recordPlanHandoff({ mode: "multi-run", sessionIDs: group.runs.flatMap((run) => run.session.sessionID === "pending" ? [] : [run.session.sessionID]), runGroupID: group.id })
        await stateWriter.flush()
        return
      }
      const implementationSessionID = await controller.createSession("Implement approved plan")
      controller.setPreference("build")
      if (choice.value === "goal") {
        const objective = /^> Objective:\s*(.+)$/m.exec(content)?.[1]?.trim() || "Implement the approved plan"
        const goalPromptID = createOpenCodeMessageID()
        contextReceipts.stage(implementationSessionID, goalPromptID, [], "none")
        try {
          await controller.send(`/goal ${objective}`, "build", undefined, undefined, [], [], goalPromptID)
        } catch (error) {
          contextReceipts.reject(goalPromptID)
          throw error
        }
      }
      const implementationPromptID = createOpenCodeMessageID()
      contextReceipts.stage(implementationSessionID, implementationPromptID, promptFileReceiptItems([file], reference.id), "none")
      try {
        await controller.send(implementationPrompt, "build", undefined, undefined, [file], [], implementationPromptID, "queue")
      } catch (error) {
        contextReceipts.reject(implementationPromptID)
        throw error
      }
      recordPlanHandoff({ mode: choice.value === "goal" ? "goal" : "implementation", sessionIDs: [implementationSessionID] })
      await stateWriter.flush()
      await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
    })),
    vscode.commands.registerCommand("opencodeWorkbench.handoffGitHub", run(async () => {
      if (!client || !controller) throw new Error("Open a Git workspace before handing off GitHub work")
      const commandIDs = await vscode.commands.getCommands(true)
      const capabilities = detectGitHubSurfaces(vscode.extensions.all.map((extension) => ({ id: extension.id, version: typeof extension.packageJSON.version === "string" ? extension.packageJSON.version : undefined })), commandIDs)
      const value = await vscode.window.showInputBox({ title: "GitHub Issue or Pull Request Handoff", prompt: "Canonical https://github.com/owner/repository/issues/N or /pull/N URL", ignoreFocusOut: true, validateInput: (input) => { try { parseGitHubReference(input); return undefined } catch (error) { return errorMessage(error) } } })
      if (!value) return
      const reference = parseGitHubReference(value)
      const editor = vscode.window.activeTextEditor
      const selectedText = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : ""
      const selectedContext = editor && selectedText ? { uri: editor.document.uri.toString(), startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1, text: selectedText } : undefined
      assertSelectedEditorContextWithinLimit(selectedContext)
      const github = new NativeGitHubContextService(new AuthenticatedGitHubRestProvider({
        getSession: () => vscode.authentication.getSession("github", ["repo"], { createIfNone: true }),
      }))
      const githubContext = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Loading bounded GitHub ${reference.kind} context…`, cancellable: false }, () => github.load(reference))
      const prompt = githubHandoffPrompt(githubContext, selectedContext)
      const contextDocument = githubContextDocument(githubContext, selectedContext)
      const file = { type: "file" as const, filename: "github-handoff.md", mime: "text/markdown", url: `data:text/markdown;base64,${Buffer.from(contextDocument).toString("base64")}` }
      const explicitLimits = hasExplicitGitHubContextLimits(githubContext)
      const receiptItems = promptFileReceiptItems([file], `github:${reference.owner}/${reference.repository}:${reference.kind}:${reference.number}`).map((item) => ({ ...item, truncated: explicitLimits || undefined }))
      const receiptCoverage = explicitLimits ? "explicit" as const : "none" as const
      const mode = await vscode.window.showQuickPick([
        { label: "Isolated worktree session (Recommended)", description: "Implement in a new Workbench-owned branch and checkout", value: "isolated" },
        { label: "Current checkout session", description: "Create a normal Workbench session in this checkout", value: "current" },
      ], { title: `Handoff #${reference.number}: ${githubContext.title.text.slice(0, 100)}`, placeHolder: "Choose where OpenCode should implement this bounded GitHub snapshot" })
      if (!mode) return
      if (mode.value === "isolated") {
        requireContinuity()
        const entry = await startIsolatedTask(client, worktrees, workspacePath, {
          title: `GitHub ${reference.kind} #${reference.number}`,
          prompt,
          slug: `${reference.kind}-${reference.number}`,
          files: [file],
          admission: {
            prepare: (sessionID, promptID) => contextReceipts.stage(sessionID, promptID, receiptItems, receiptCoverage),
            admit: (sessionID, promptID) => { contextReceipts.admit(sessionID, promptID) },
            reject: (promptID) => contextReceipts.reject(promptID),
          },
        })
        await publishIsolatedHandoff(entry)
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(entry.path), true)
      } else {
        const sessionID = await controller.createSession(`GitHub ${reference.kind} #${reference.number}`)
        controller.setPreference("build")
        const promptID = createOpenCodeMessageID()
        contextReceipts.stage(sessionID, promptID, receiptItems, receiptCoverage)
        try {
          await controller.send(prompt, "build", undefined, undefined, [file], [], promptID)
        } catch (error) {
          contextReceipts.reject(promptID)
          throw error
        }
        await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
      }
      const nativeActions = [
        ...(reference.kind === "pull-request" && capabilities.openPullRequestChanges ? ["Open PR changes in VS Code"] : []),
        ...(capabilities.openView ? ["Open GitHub view"] : []),
      ]
      if (nativeActions.length) {
        const open = await vscode.window.showInformationMessage("Bounded GitHub context was handed to OpenCode.", ...nativeActions)
        if (open === "Open GitHub view") await vscode.commands.executeCommand("workbench.view.extension.github-pull-requests")
        if (open === "Open PR changes in VS Code") {
          const uri = githubPullRequestChangesUri(reference, vscode.env.uriScheme)
          if (!uri || !await vscode.env.openExternal(vscode.Uri.parse(uri))) throw new Error("The GitHub Pull Requests extension did not open the pull request changes surface")
        }
      }
    })),
    vscode.commands.registerCommand("opencodeWorkbench.captureBrowserContext", run(async (request?: {
      sessionID?: string
      task?: string
      sources?: BrowserContextSource[]
      approvedUrl?: string
    }) => {
      if (!controller) throw new Error("Open a workspace before attaching browser context")
      const originSessionID = request?.sessionID ?? controller.chatSnapshot().session?.id
      if (request?.sessionID && !Object.hasOwn(controller.snapshot.sessions, request.sessionID)) throw new Error("The originating OpenCode session is no longer available")
      const originDirectory = originSessionID ? controller.snapshot.sessions[originSessionID]?.info.directory : undefined
      const rememberedSelection = chatProvider.captureEditorSelection()
      chatProvider.openInEditor("context")
      const hasSelection = Boolean(rememberedSelection)
      const selectedSources = request?.task?.trim() && request.sources?.length
        ? request.sources.map((value) => ({ value }))
        : await vscode.window.showQuickPick([
        ...(hasSelection ? [{ label: "Selected editor/debug text", description: "Attach only the current explicit selection", value: "selection" as const }] : []),
        { label: "Clipboard console output", description: "Read the clipboard once after this explicit choice", value: "console" as const },
        { label: "Clipboard element metadata", description: "Read the clipboard once after this explicit choice", value: "element" as const },
        { label: "Terminal or task excerpt", description: "Read one explicitly chosen excerpt from the clipboard", value: "terminal-task" as const },
        { label: "Workspace diagnostics summary", description: "Attach counts and repository-contained diagnostic paths", value: "diagnostics" as const },
        { label: "VS Code debug state", description: "Attach bounded active-session metadata and repository breakpoints", value: "debug" as const },
        { label: "Approved page URL", description: "Attach one HTTP(S) URL you approve; the page is not fetched", value: "url" as const },
        { label: "Screenshot file", description: "Choose a PNG, JPEG, or WebP explicitly", value: "screenshot" as const },
      ], { canPickMany: true, title: "Attach Browser/Debug Context", placeHolder: "No browser proxy or navigation is used" })
      if (!selectedSources?.length) return
      if (selectedSources.filter((source) => source.value === "console" || source.value === "element" || source.value === "terminal-task").length > 1) throw new Error("Choose only one clipboard-backed context source")
      const editorSelection = requestedBrowserEditorSelection(selectedSources.map((source) => source.value), rememberedSelection)
      const task = request?.task?.trim() || await vscode.window.showInputBox({ title: "Browser-context task", prompt: "What should OpenCode do with this context?", validateInput: (value) => value.trim() ? undefined : "Enter a task" })
      if (!task) return
      const clipboardSource = selectedSources.find((source) => source.value === "console" || source.value === "element" || source.value === "terminal-task")
      const clipboardKind = clipboardSource?.value as "console" | "element" | "terminal-task" | undefined
      const clipboardText = clipboardSource ? await vscode.env.clipboard.readText() : undefined
      const approvedUrl = selectedSources.some((source) => source.value === "url")
        ? request?.approvedUrl ?? await vscode.window.showInputBox({ title: "Approved page URL", prompt: "HTTP(S) URL to identify in the context receipt (the page will not be fetched)", ignoreFocusOut: true })
        : undefined
      if (selectedSources.some((source) => source.value === "url") && !approvedUrl) return
      let screenshot: { name: string; mime: BrowserScreenshotMime; bytes: Uint8Array } | undefined
      if (selectedSources.some((source) => source.value === "screenshot")) {
        const selected = await vscode.window.showOpenDialog({ title: "Choose browser screenshot", canSelectMany: false, filters: { "Browser screenshots": ["png", "jpg", "jpeg", "webp"] } })
        if (!selected?.[0]) return
        const extension = path.extname(selected[0].fsPath).toLowerCase()
        const mime = extension === ".png" ? "image/png" as const : extension === ".webp" ? "image/webp" as const : "image/jpeg" as const
        const name = path.basename(selected[0].fsPath)
        const screenshotStat = await vscode.workspace.fs.stat(selected[0])
        assertBrowserScreenshotFileBeforeRead({
          name,
          mime,
          size: screenshotStat.size,
          isFile: (screenshotStat.type & vscode.FileType.File) !== 0 && (screenshotStat.type & vscode.FileType.SymbolicLink) === 0,
        })
        screenshot = { name, mime, bytes: await vscode.workspace.fs.readFile(selected[0]) }
      }
      const capture = captureBrowserContext({
        task,
        editorSelection,
        clipboardText: clipboardKind && clipboardText !== undefined ? { kind: clipboardKind, text: clipboardText } : undefined,
        diagnostics: selectedSources.some((source) => source.value === "diagnostics") ? diagnosticsSummary(currentDiagnostics(originDirectory ?? workspacePath)) : undefined,
        debugState: selectedSources.some((source) => source.value === "debug") ? await currentDebugContext(originDirectory ?? workspacePath) : undefined,
        approvedUrl,
        screenshot,
      })
      const browserSessionID = originSessionID ?? await controller.createSession(`Browser context: ${task.slice(0, 100)}`)
      if (controller.snapshot.selectedID !== browserSessionID) throw new Error("The selected OpenCode session changed while browser context was being captured; nothing was sent")
      const browserPromptID = createOpenCodeMessageID()
      contextReceipts.stage(browserSessionID, browserPromptID, capture.receiptItems, "none")
      try {
        await controller.send(capture.prompt, undefined, undefined, undefined, capture.files, [], browserPromptID)
      } catch (error) {
        contextReceipts.reject(browserPromptID)
        throw error
      }
      await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
    })),
    vscode.commands.registerCommand("opencodeWorkbench.newIsolatedSession", run(async () => {
      chatProvider.openInEditor("runs")
      if (!client || !vscode.workspace.workspaceFolders?.length) throw new Error("Open a Git workspace before creating an isolated session")
      const prompt = await vscode.window.showInputBox({ title: "New Isolated Session", prompt: "Initial task (optional)", ignoreFocusOut: true })
      if (prompt === undefined) return
      requireContinuity()
      let entry: WorktreeJournalEntry
      if (prompt.trim()) {
        entry = await startIsolatedTask(client, worktrees, workspacePath, {
          title: `Isolated: ${prompt.trim().slice(0, 120)}`,
          prompt,
          slug: prompt,
          admission: {
            prepare: (sessionID, promptID) => contextReceipts.stage(sessionID, promptID, [], "none"),
            admit: (sessionID, promptID) => { contextReceipts.admit(sessionID, promptID) },
            reject: (promptID) => contextReceipts.reject(promptID),
          },
        })
      } else {
        const repository = await worktrees.repository(workspacePath)
        const identity = createIsolatedWorktreeIdentity("session")
        entry = await worktrees.create({ directory: repository.root, path: path.join(path.dirname(repository.root), `.${path.basename(repository.root)}-worktrees`, identity.name), branch: identity.branch, baseRef: "HEAD", mutationID: identity.mutationID })
        try {
          await worktrees.markDurably(entry.id, "session-creating")
          const session = await client.forDirectory(entry.path).createSession("Isolated session")
          entry = await worktrees.markDurably(entry.id, "session-ready", { sessionID: session.id })
        } catch (error) {
          await worktrees.failDurably(entry.id, { code: "INTERNAL", message: "OpenCode session creation failed for this isolated worktree", retryable: true })
          throw error
        }
      }
      await publishIsolatedHandoff(entry)
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(entry.path), true)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.removeWorktree", run(async () => {
      const candidates = worktrees.journal().filter((entry) => entry.phase !== "removed")
      const selected = await vscode.window.showQuickPick(candidates.map((entry) => ({ label: entry.branch, description: entry.path, entry })), { title: "Remove Worktree", placeHolder: "Dirty worktrees are always retained" })
      if (!selected) return
      await worktrees.remove(selected.entry.id)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.deleteWorktreeBranch", run(async () => {
      const candidates = worktrees.journal().filter((entry) => entry.phase === "removed")
      const selected = await vscode.window.showQuickPick(candidates.map((entry) => ({ label: entry.branch, description: entry.repository, entry })), { title: "Delete Removed Worktree Branch" })
      if (!selected) return
      await worktrees.deleteBranch(selected.entry.id)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.compareModels", run(async () => {
      chatProvider.openInEditor("runs")
      if (!controller || !multiRun) throw new Error("Open a Git workspace before comparing models")
      requireContinuity()
      const choices = controller.chatSnapshot().models.map((model) => ({ label: model.name, description: model.providerID, value: `${model.providerID}/${model.id}` }))
      const selected = await vscode.window.showQuickPick(choices, { canPickMany: true, title: "Compare Models", placeHolder: "Select two to five models" })
      if (!selected || selected.length < 2 || selected.length > 5) throw new Error("Select two to five models")
      const prompt = await vscode.window.showInputBox({ title: "Compare Models", prompt: "Task for every run", ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : "Enter a task" })
      if (!prompt) return
      const repository = await worktrees.repository(workspacePath)
      const baseRef = (await gitRunner.run(["rev-parse", "HEAD"], repository.root)).stdout.trim()
      const mutationID = randomUUID()
      contextReceipts.stage(`run-group:${mutationID}`, mutationID, [], "none")
      const receipt = contextReceipts.admit(`run-group:${mutationID}`, mutationID)!
      const group = await multiRun.start({
        mutationID, title: prompt.trim().slice(0, 160), repository: repository.root, baseRef, promptReceiptID: receipt.id,
        prompt, runs: selected.map((choice, index) => ({ id: `run-${index + 1}`, model: choice.value })),
        worktreeParent: path.join(path.dirname(repository.root), `.${path.basename(repository.root)}-worktrees`, `run-${mutationID.slice(0, 8)}`),
        runtimeEpoch: `http-sse:${Date.now()}`,
      })
      await publishRunContinuity(group)
      const failed = group.runs.filter((entry) => entry.phase === "failed").length
      void vscode.window.showInformationMessage(`Started ${group.runs.length - failed}/${group.runs.length} isolated OpenCode runs${failed ? `; ${failed} failed to start` : ""}.`)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.refreshRunGroups", run(async () => {
      if (!multiRun) throw new Error("OpenCode Multi-run is unavailable")
      for (const group of runGroups.list()) {
        const refreshed = await multiRun.refresh(group.id)
        if (handoffContinuity) await publishRunContinuity(refreshed)
      }
    })),
    vscode.commands.registerCommand("opencodeWorkbench.cancelRunGroup", run(async () => {
      if (!multiRun) throw new Error("OpenCode Multi-run is unavailable")
      const selected = await vscode.window.showQuickPick(runGroups.list().map((group) => ({ label: group.title, description: group.id, group })), { title: "Cancel Run Group" })
      if (selected) await multiRun.cancel(selected.group.id)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.openRun", run(async (groupID?: unknown, runID?: unknown) => {
      const runs = runGroups.list().flatMap((group) => group.runs.filter((entry) => !entry.discarded && entry.session.sessionID !== "pending").map((entry) => ({ label: `${group.title}: ${entry.model}`, description: `${entry.phase} · ${entry.session.directory}`, group, entry })))
      const directRequested = groupID !== undefined || runID !== undefined
      if (directRequested && (typeof groupID !== "string" || typeof runID !== "string")) throw new Error("An exact run group and run ID are required")
      const direct = typeof groupID === "string" && typeof runID === "string" ? runs.find((candidate) => candidate.group.id === groupID && candidate.entry.id === runID) : undefined
      if (directRequested && !direct) throw new Error("The requested run is no longer available to open")
      const selected = direct ?? await vscode.window.showQuickPick(runs, { title: "Open Multi-run Result" })
      if (selected) {
        if (handoffContinuity) await publishRunContinuity(selected.group)
        await flushDurableMetadata()
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(selected.entry.session.directory), true)
      }
    })),
    vscode.commands.registerCommand("opencodeWorkbench.openRunDiff", run(async (groupID?: unknown, runID?: unknown) => {
      const directRequested = groupID !== undefined || runID !== undefined
      if (directRequested && (typeof groupID !== "string" || typeof runID !== "string")) throw new Error("An exact run group and run ID are required")
      const directGroup = typeof groupID === "string" ? runGroups.get(groupID) : undefined
      const directRun = directGroup && typeof runID === "string" ? directGroup.runs.find((entry) => entry.id === runID) : undefined
      const direct = directRun && directRun.session.sessionID !== "pending" && !directRun.discarded ? { group: directGroup!, entry: directRun } : undefined
      if (directRequested && !direct) throw new Error("The requested run is no longer available for diff")
      const picked = direct ?? await vscode.window.showQuickPick(runGroups.list().flatMap((group) => group.runs.filter((entry) => entry.session.sessionID !== "pending" && !entry.discarded).map((entry) => ({ label: `${group.title}: ${entry.model}`, description: entry.session.directory, group, entry }))), { title: "Open Run Native Diff" })
      if (!picked) return
      const capture = await diffs.capture({ repository: picked.entry.session.directory, scope: "branch", baseRef: picked.group.baseRef })
      if (!capture.snapshot.complete) throw new Error(`Run diff is incomplete: ${capture.snapshot.truncationReason ?? "unknown limitation"}`)
      const names = capture.snapshot.files.map((file) => file.path).slice(0, 500)
      const selected = names.length === 1 ? names[0] : (await vscode.window.showQuickPick(names, { title: "Open Run Native Diff", placeHolder: "Select a changed file" }))
      if (!selected) throw new Error("This run has no tracked changes against its base")
      const content = await nativeDiffText(diffs, capture, selected)
      const original = await vscode.workspace.openTextDocument({ content: content.base })
      const current = await vscode.workspace.openTextDocument({ content: content.modified })
      await vscode.commands.executeCommand("vscode.diff", original.uri, current.uri, `${picked.entry.model}: ${content.modifiedPath}`)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.compareRunResults", run(async (groupID?: unknown) => {
      chatProvider.openInEditor("runs")
      const direct = typeof groupID === "string" ? runGroups.get(groupID) : undefined
      const selected = direct ? { group: direct } : await vscode.window.showQuickPick(runGroups.list().map((group) => ({ label: group.title, description: `${group.runs.length} runs`, group })), { title: "Objective Run Comparison" })
      if (!selected) return
      const observations = await collectRunObservations(selected.group)
      const rows = await runComparison.compare(selected.group, observations)
      const ownerSessionID = selected.group.runs.find((run) => run.session.sessionID !== "pending")?.session.sessionID
      if (!ownerSessionID) throw new Error("Run comparison has no OpenCode session owner")
      const existing = taskArtifacts.list(ownerSessionID).find((artifact) => artifact.kind === "run-comparison" && artifact.payload.groupID === selected.group.id)
      if (existing?.kind === "run-comparison") taskArtifacts.update(ownerSessionID, existing.id, existing.revision, (draft) => {
        if (draft.kind === "run-comparison") draft.payload.rows = rows
      })
      else taskArtifacts.create({ kind: "run-comparison", sessionID: ownerSessionID, lifecycle: "active", payload: { groupID: selected.group.id, rows } })
      await stateWriter.flush()
      void vscode.window.showInformationMessage("Objective comparison refreshed in the Runs workbench. No winner was inferred.")
    })),
    vscode.commands.registerCommand("opencodeWorkbench.fuseRuns", run(async (groupID?: unknown) => {
      if (!client) throw new Error("OpenCode Fusion is unavailable")
      chatProvider.openInEditor("runs")
      requireContinuity()
      const candidates = runGroups.list().filter((group) => group.runs.filter((run) => run.session.sessionID !== "pending" && !run.discarded).length >= 2)
      const direct = typeof groupID === "string" ? candidates.find((group) => group.id === groupID) : undefined
      const selected = direct ? { group: direct } : await vscode.window.showQuickPick(candidates.map((group) => ({ label: group.title, description: `${group.runs.length} source runs · ${group.id}`, group })), { title: "Fusion Source Group" })
      if (!selected) return
      const selectedMode = await vscode.window.showQuickPick([
        { label: "Synthesize implementation plan", description: "Create a plan without implementing", value: "plan" as FusionMode, agent: "plan" },
        { label: "Build combined implementation", description: "Implement in a new isolated worktree", value: "build" as FusionMode, agent: "build" },
        { label: "Review and choose approach", description: "Assess sources without implementing", value: "review" as FusionMode, agent: "plan" },
      ], { title: "Fusion Mode" })
      if (!selectedMode) return
      const sourceRuns = selected.group.runs.filter((run) => run.session.sessionID !== "pending" && !run.discarded)
      const observations = await collectRunObservations(selected.group)
      const comparisonRows = new Map((await runComparison.compare(selected.group, observations)).map((row) => [row.runID, row]))
      const artifacts = await Promise.all(sourceRuns.map(async (run) => {
        const capture = await diffs.capture({ repository: run.session.directory, scope: "branch", baseRef: selected.group.baseRef })
        if (!capture.snapshot.complete) throw new Error(`Fusion source ${run.id} has an incomplete diff: ${capture.snapshot.truncationReason ?? "unknown limitation"}`)
        const objectiveSummary = comparisonRows.get(run.id)
        if (!objectiveSummary) throw new Error(`Fusion source ${run.id} has no objective comparison row`)
        const observation = observations[run.id]
        return { runID: run.id, directory: run.session.directory, sessionID: run.session.sessionID, model: run.model, agent: run.agent, variant: run.variant, phase: run.phase, unifiedDiff: capture.unifiedDiff, diffSnapshot: capture.snapshot, evidence: boundedFusionSourceEvidence(observation?.evidence ?? [], run.id, run.session.sessionID), objectiveSummary, assistantSummary: observation?.assistantSummary }
      }))
      const bundle = buildFusionBundle(selected.group, selectedMode.value, artifacts)
      const receiptItems = promptFileReceiptItems(bundle.files, `fusion:${selected.group.id}`)
      const entry = await startIsolatedTask(client, worktrees, selected.group.repository, {
        title: `Fusion: ${selected.group.title}`,
        prompt: bundle.prompt,
        slug: `fusion-${selected.group.id.slice(0, 8)}`,
        agent: selectedMode.agent,
        files: bundle.files,
        admission: {
          prepare: (sessionID, promptID) => contextReceipts.stage(sessionID, promptID, receiptItems, "none"),
          admit: (sessionID, promptID) => { contextReceipts.admit(sessionID, promptID) },
          reject: (promptID) => contextReceipts.reject(promptID),
        },
      })
      const continuityEvidence = boundedFusionContinuityEvidence(artifacts, entry.sessionID!, bundle.provenanceHash)
      await publishIsolatedHandoff(entry, [selected.group.promptReceiptID], continuityEvidence)
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(entry.path), true)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.discardRun", run(async (groupID?: unknown, runID?: unknown) => {
      if (!multiRun) throw new Error("OpenCode Multi-run is unavailable")
      const candidates = runGroups.list().flatMap((group) => group.runs.filter((entry) => entry.worktreeID && entry.session.sessionID !== "pending" && !entry.retained && !entry.discarded).map((entry) => ({ label: `${group.title}: ${entry.model}`, description: entry.session.directory, group, entry })))
      const directRequested = groupID !== undefined || runID !== undefined
      if (directRequested && (typeof groupID !== "string" || typeof runID !== "string")) throw new Error("An exact run group and run ID are required")
      const direct = typeof groupID === "string" && typeof runID === "string" ? candidates.find((candidate) => candidate.group.id === groupID && candidate.entry.id === runID) : undefined
      if (directRequested && !direct) throw new Error("The requested run is no longer safely discardable")
      const selected = direct ?? await vscode.window.showQuickPick(candidates, { title: "Discard Run Safely", placeHolder: "Dirty results are retained" })
      if (!selected) return
      await multiRun.cancel(selected.group.id, selected.entry.id)
      await worktrees.remove(selected.entry.worktreeID!)
      runGroups.update(selected.group.id, selected.entry.id, { phase: "cancelled", discarded: true })
      await runGroups.flush()
    })),
    vscode.commands.registerCommand("opencodeWorkbench.generateWalkthrough", run(async () => {
      if (!client || !controller) throw new Error("OpenCode is unavailable")
      chatProvider.openInEditor("walkthrough")
      const repository = await worktrees.repository(workspacePath)
      const capture = await diffs.capture({ repository: repository.root, scope: "session", baseRef: "HEAD" })
      const session = controller.chatSnapshot().session
      evidence.recordDiff(capture.snapshot, session?.directory === repository.root ? { sessionID: session.id } : {})
      await flushDurableMetadata()
      const selected = await vscode.window.showQuickPick(controller.chatSnapshot().models.map((model) => ({ label: model.name, description: model.providerID, value: `${model.providerID}/${model.id}` })), { title: "Generate Changes Walkthrough" })
      if (!selected) return
      const walkthrough = await walkthroughs.generate(capture, selected.value, async ({ prompt, unifiedDiff, model }) => (await invokeBoundedOpenCode(client!.forDirectory(repository.root), "Changes walkthrough", prompt, model, { filename: "changes.diff", mime: "text/x-diff", url: `data:text/x-diff;base64,${Buffer.from(unifiedDiff).toString("base64")}` })).text)
      diffCaptures.set(walkthrough.diffHash, capture)
      const markdown = [`# Changes Walkthrough`, ``, `Diff: \`${walkthrough.diffHash}\``, `Coverage: **${walkthrough.coverage}**`, ...(walkthrough.uncoveredFiles?.length ? [`Uncovered: ${walkthrough.uncoveredFiles.join(", ")}`] : []), ``, ...walkthrough.stops.flatMap((stop, index) => [`## ${index + 1}. ${stop.title}`, ``, `_${stop.importance}_`, ``, stop.explanation, ``, ...stop.anchors.map((anchor) => `- ${anchor.file}:${anchor.startLine}-${anchor.endLine} (${anchor.side})`), ``])].join("\n")
      const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown })
      await vscode.window.showTextDocument(document, { preview: false })
    })),
    vscode.commands.registerCommand("opencodeWorkbench.openWalkthroughStop", run(async (documentID?: string, stopID?: string) => {
      const documents = walkthroughs.list()
      const selectedDocument = documentID ? (() => { const document = documents.find((candidate) => candidate.id === documentID); return document ? { document } : undefined })() : await vscode.window.showQuickPick(documents.map((document) => ({ label: new Date(document.generatedAt).toLocaleString(), description: `${document.coverage} · ${document.model}`, document })), { title: "Open Walkthrough Stop" })
      if (!selectedDocument) return
      const selectedStop = stopID ? (() => { const stop = selectedDocument.document.stops.find((candidate) => candidate.id === stopID); return stop ? { stop } : undefined })() : await vscode.window.showQuickPick(selectedDocument.document.stops.map((stop) => ({ label: stop.title, description: stop.importance, stop })), { title: "Walkthrough Stop" })
      const anchor = selectedStop?.stop.anchors[0]
      if (!anchor) return
      const repository = await worktrees.repository(workspacePath)
      let capture = diffCaptures.get(selectedDocument.document.diffHash)
      if (!capture) capture = await diffs.capture({ repository: repository.root, scope: "session", baseRef: "HEAD" })
      if (!capture.snapshot.complete || capture.snapshot.unifiedDiffHash !== selectedDocument.document.diffHash) throw new Error("Walkthrough is stale; regenerate it for the current complete diff")
      await openDiffAnchor(diffs, capture, anchor, `${anchor.file} (Walkthrough)`)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.reviewChanges", run(async (directory?: unknown, baseRef?: unknown, requestedOwnerSessionID?: unknown) => {
      if (!client || !controller) throw new Error("OpenCode is unavailable")
      const originatingSession = controller.chatSnapshot().session
      chatProvider.openInEditor("review")
      const targetDirectory = typeof directory === "string" ? directory : workspacePath
      const repository = await worktrees.repository(targetDirectory)
      const capture = await diffs.capture({ repository: repository.root, scope: "session", baseRef: typeof baseRef === "string" ? baseRef : "HEAD" })
      if (requestedOwnerSessionID !== undefined && typeof requestedOwnerSessionID !== "string") throw new Error("Invalid review owner session")
      const explicitOwner = typeof requestedOwnerSessionID === "string" ? controller.snapshot.sessions[requestedOwnerSessionID] : undefined
      if (typeof requestedOwnerSessionID === "string" && !explicitOwner) throw new Error("The requested OpenCode review owner is no longer available")
      const explicitOwnerDirectory = explicitOwner ? await fs.realpath(explicitOwner.info.directory).catch(() => undefined) : undefined
      if (explicitOwner && explicitOwnerDirectory !== repository.root) throw new Error("The requested OpenCode review owner belongs to a different repository")
      const originatingDirectory = originatingSession?.directory ? await fs.realpath(originatingSession.directory).catch(() => undefined) : undefined
      const ownerSessionID = explicitOwner?.info.id ?? (originatingDirectory === repository.root ? originatingSession?.id : undefined)
      evidence.recordDiff(capture.snapshot, ownerSessionID ? { sessionID: ownerSessionID } : {})
      await flushDurableMetadata()
      const selected = await vscode.window.showQuickPick(controller.chatSnapshot().models.map((model) => ({ label: model.name, description: model.providerID, value: `${model.providerID}/${model.id}` })), { title: "Review Changes" })
      if (!selected) return
      let producer: BoundedOpenCodeResult | undefined
      const review = await reviews.generate(capture, selected.value, async ({ prompt, unifiedDiff, model }) => {
        producer = await invokeBoundedOpenCode(client!.forDirectory(repository.root), "Code review", prompt, model, { filename: "changes.diff", mime: "text/x-diff", url: `data:text/x-diff;base64,${Buffer.from(unifiedDiff).toString("base64")}` })
        return producer.text
      })
      if (!producer) throw new Error("OpenCode did not return review provenance")
      taskArtifacts.create({
        kind: "review",
        sessionID: ownerSessionID ?? producer.sessionID,
        lifecycle: "active",
        producer: { sessionID: producer.sessionID, messageID: producer.messageID, model: producer.model },
        payload: { document: review, repository: repository.root, baseRef: capture.snapshot.baseRef, scope: capture.snapshot.scope, diffHash: capture.snapshot.unifiedDiffHash, stale: false, dispositions: [] },
      })
      await stateWriter.flush()
      const markdown = [`# OpenCode Review Findings`, ``, `> These are model findings, not deterministic facts. Diff: \`${review.diffHash}\``, ``, ...(review.findings.length ? review.findings.flatMap((finding) => [`## [${finding.severity.toUpperCase()}] ${finding.title}`, ``, `Category: ${finding.category}`, ``, finding.detail, ``, ...finding.anchors.map((anchor) => `- ${anchor.file}:${anchor.startLine}-${anchor.endLine} (${anchor.side})`), ``]) : ["No findings were returned."])].join("\n")
      const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown })
      await vscode.window.showTextDocument(document, { preview: false })
    })),
    vscode.commands.registerCommand("opencodeWorkbench.openReviewFinding", run(async (sessionID?: unknown, artifactID?: unknown, findingID?: unknown) => {
      const reviews = taskArtifacts.list().filter((artifact) => artifact.kind === "review")
      const direct = typeof sessionID === "string" && typeof artifactID === "string"
        ? reviews.find((artifact) => artifact.sessionID === sessionID && artifact.id === artifactID)
        : undefined
      const selectedArtifact = direct ?? (await vscode.window.showQuickPick(reviews.map((artifact) => ({ label: new Date(artifact.payload.document.generatedAt).toLocaleString(), description: `${artifact.payload.document.findings.length} findings · ${artifact.payload.document.model}`, artifact })), { title: "Open Review Finding" }))?.artifact
      if (!selectedArtifact) return
      const directFinding = typeof findingID === "string" ? selectedArtifact.payload.document.findings.find((finding) => finding.id === findingID) : undefined
      const selectedFinding = directFinding ?? (await vscode.window.showQuickPick(selectedArtifact.payload.document.findings.map((finding) => ({ label: `[${finding.severity}] ${finding.title}`, description: finding.category, finding })), { title: "Review Finding" }))?.finding
      const anchor = selectedFinding?.anchors[0]
      if (!anchor) return
      const current = await diffs.capture({ repository: selectedArtifact.payload.repository, scope: selectedArtifact.payload.scope, baseRef: selectedArtifact.payload.baseRef })
      if (!current.snapshot.complete || current.snapshot.unifiedDiffHash !== selectedArtifact.payload.diffHash || selectedArtifact.payload.stale) {
        if (!selectedArtifact.payload.stale) taskArtifacts.update(selectedArtifact.sessionID, selectedArtifact.id, selectedArtifact.revision, (draft) => {
          if (draft.kind === "review") draft.payload.stale = true
        })
        await stateWriter.flush()
        throw new Error("Review finding is stale; rerun Review Changes")
      }
      await openDiffAnchor(diffs, current, anchor, `${anchor.file} (Review finding)`)
    })),
    vscode.commands.registerCommand("opencodeWorkbench.captureTaskEvidence", run(async () => {
      chatProvider.openInEditor("evidence")
      const session = controller?.chatSnapshot().session
      const repository = session?.directory ?? workspacePath
      const repositoryRoot = await fs.realpath(repository).catch(() => undefined)
      if (!repositoryRoot) throw new Error("The selected session repository is not available")
      const tasks = await Promise.all((await vscode.tasks.fetchTasks()).map(async (task) => ({ task, repository: await taskRepository(task) })))
      const available = tasks.filter((entry) => entry.repository === repositoryRoot)
      if (!available.length) throw new Error("No VS Code tasks are scoped to the selected session repository")
      const selected = await vscode.window.showQuickPick(available.map(({ task }) => ({ label: task.name, description: [task.source, task.group?.id].filter(Boolean).join(" · "), task })), { title: "Run Task and Capture Evidence" })
      if (!selected) return
      const diagnosticsBefore = currentDiagnostics(repository)
      const exitCode = await executeTaskWithExitCode(selected.task)
      const diagnosticsAfter = currentDiagnostics(repository)
      const testTask = selected.task.group?.id === vscode.TaskGroup.Test.id
      const evidenceScope = { sessionID: session?.id, repository }
      evidence.record({ kind: testTask ? "test" : "task", label: selected.task.name, status: exitCode === 0 ? "passed" : exitCode === undefined ? "unknown" : "failed", sourceID: selected.task.definition.type, ...evidenceScope, summary: exitCode === undefined ? "Task ended without a reported exit code" : `Task exited with code ${exitCode}` })
      const diagnosticEvidence = diagnosticsDelta(diagnosticsBefore, diagnosticsAfter)
      evidence.record({ kind: "diagnostics", label: "VS Code diagnostics delta", ...diagnosticEvidence, ...evidenceScope })
      await flushDurableMetadata()
      const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(evidence.list(evidenceScope), null, 2) })
      await vscode.window.showTextDocument(document, { preview: false })
    })),
    vscode.commands.registerCommand("opencodeWorkbench.verifyGoal", run(async () => {
      if (!controller || !goalVerifier) throw new Error("OpenCode goal verification is unavailable")
      chatProvider.openInEditor("goal")
      const session = controller.chatSnapshot().session
      const goal = session?.goal
      if (!session || !goal?.objective) throw new Error("Select a session with an active goal")
      if (session.todos?.length) {
        const completed = session.todos.filter((todo) => todo.status.toLowerCase() === "completed").length
        evidence.record({
          kind: "todo",
          label: "OpenCode todo state",
          status: completed === session.todos.length ? "passed" : "warning",
          sessionID: session.id,
          repository: session.directory ?? workspacePath,
          summary: `${completed} of ${session.todos.length} todos completed`,
        })
      }
      const scopedEvidence = boundedVerifierEvidence(evidence.list({ sessionID: session.id }))
      const latestAssistantResult = session.messages.slice().reverse().find((message) => message.info.role === "assistant")?.parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n")
      const turnDiff = [...latestTurnDiffs.entries()].filter(([key]) => key.startsWith(`${session.id}:`)).at(-1)?.[1]
      const verificationInput = {
        objective: goal.objective,
        acceptanceCriteria: goal.acceptanceCriteria?.length ? goal.acceptanceCriteria : [goal.objective],
        latestAssistantResult,
        evidence: scopedEvidence,
        diffSummary: turnDiff ? `${turnDiff.snapshot.files.length} files · ${turnDiff.snapshot.unifiedDiffHash} · ${turnDiff.snapshot.complete ? "complete" : `incomplete: ${turnDiff.snapshot.truncationReason}`}` : undefined,
        diagnostics: diagnosticsSummary(currentDiagnostics(session.directory ?? workspacePath)),
        checkpoints: goal.checkpoint ? [goal.checkpoint] : undefined,
        remainingLimits: { tokens: goal.remainingTokens, autoTurns: goal.maxAutoTurns === undefined ? undefined : Math.max(0, goal.maxAutoTurns - (goal.autoTurns ?? 0)), durationSeconds: goal.maxDurationSeconds === undefined ? undefined : Math.max(0, goal.maxDurationSeconds - (goal.timeUsedSeconds ?? 0)) },
        configuration: goal.verifier,
      }
      const verification = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Verifying OpenCode goal", cancellable: true },
        async (_progress, cancellation) => {
          const abort = new AbortController()
          const subscription = cancellation.onCancellationRequested(() => abort.abort(new Error("Goal verification cancelled")))
          try {
            return await goalVerifier!.verifyDetailed(verificationInput, abort.signal)
          } finally {
            subscription.dispose()
          }
        },
      )
      const verdict = verification.verdict
      const finalAttempt = verification.attempts.at(-1)
      const verifierEvidence = evidence.record({
        kind: "criterion",
        label: "Independent goal verifier",
        status: verdict.verdict === "complete" ? "passed" : verdict.verdict === "continue" || verdict.verdict === "blocked" ? "warning" : "unknown",
        observedAt: finalAttempt?.completedAt,
        sourceID: finalAttempt?.sessionID,
        sessionID: session.id,
        repository: session.directory ?? workspacePath,
        summary: verdict.reason,
      })
      await flushDurableMetadata()
      const evidenceReferences = [...new Set([...(goal.evidenceReferences ?? []), ...scopedEvidence.map((entry) => entry.id), verifierEvidence.id])]
      const currentGoal = controller.chatSnapshot().session?.id === session.id ? controller.chatSnapshot().session?.goal : undefined
      const fresh = currentGoal?.settlementGeneration === goal.settlementGeneration
      if (!finalAttempt?.sessionID) throw new Error("OpenCode verifier did not return its producer session provenance")
      const verificationArtifact = taskArtifacts.create({
        kind: "goal-verification",
        sessionID: session.id,
        lifecycle: "active",
        producer: { sessionID: finalAttempt.sessionID, model: finalAttempt.model },
        payload: {
          settlementGeneration: goal.settlementGeneration ?? 0,
          verdict,
          attempts: verification.attempts,
          evidenceIDs: evidenceReferences,
          applied: false,
          stale: !fresh,
        },
      })
      await stateWriter.flush()
      const choice = fresh ? await vscode.window.showInformationMessage(`Verifier verdict: ${verdict.verdict} (${verdict.confidence} confidence). Apply it to this goal?`, { modal: true, detail: verdict.reason }, "Apply verdict") : undefined
      let applied = false
      if (choice === "Apply verdict") {
        if (controller.chatSnapshot().session?.id !== session.id || controller.chatSnapshot().session?.goal?.settlementGeneration !== goal.settlementGeneration) throw new Error("The goal changed while verification was running; rerun verification before applying this verdict")
        await controller.send(`/goal verdict ${JSON.stringify({ verdict: verdict.verdict, reason: verdict.reason, missing_criteria: verdict.missingCriteria, confidence: verdict.confidence, evidence_references: evidenceReferences, expected_generation: goal.settlementGeneration })}`)
        applied = true
        taskArtifacts.update(session.id, verificationArtifact.id, verificationArtifact.revision, (draft) => {
          if (draft.kind !== "goal-verification") return
          draft.payload.applied = true
          draft.payload.appliedAt = Date.now()
        })
        await stateWriter.flush()
      }
      chatProvider.openInEditor(applied ? "evidence" : "goal")
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

  const participant = vscode.chat.createChatParticipant("opencodeWorkbench.opencode", async (request, _chatContext, stream, token) => {
    if (!controller) {
      stream.markdown("Open a workspace folder before handing a task to OpenCode.")
      return
    }
    if (request.command === "open") {
      await vscode.commands.executeCommand("opencodeWorkbench.chat.focus")
      stream.markdown("Opened the current OpenCode Workbench session. No model request was run in VS Code Chat.")
      return
    }
    const prompt = request.prompt.trim()
    if (!prompt) {
      stream.markdown("Add the task you want to hand off, for example `@opencode /continue fix the failing test`.")
      return
    }
    if (token.isCancellationRequested) return
    const sessionID = controller.chatSnapshot().session?.id ?? await controller.createSession(`Chat handoff: ${prompt.slice(0, 100)}`)
    const promptID = createOpenCodeMessageID()
    contextReceipts.stage(sessionID, promptID, [], "none")
    try {
      await controller.send(prompt, undefined, undefined, undefined, [], [], promptID)
    } catch (error) {
      contextReceipts.reject(promptID)
      throw error
    }
    stream.markdown("Handed this task to the selected OpenCode session. The actual model loop runs in OpenCode, not in this chat participant.")
    stream.button({ command: "opencodeWorkbench.openChat", title: "Open OpenCode session" })
  })
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "opencodeWorkbench.png")
  context.subscriptions.push(participant)

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("opencodeWorkbench.serverMode") || event.affectsConfiguration("opencodeWorkbench.executablePath") || event.affectsConfiguration("opencodeWorkbench.managedServerStartupTimeout")) {
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
  const failures: unknown[] = []
  const settle = async (operations: Array<Promise<unknown> | undefined>): Promise<void> => {
    const results = await Promise.allSettled(operations.filter((operation): operation is Promise<unknown> => operation !== undefined))
    for (const result of results) if (result.status === "rejected") failures.push(result.reason)
  }
  const managed = activeManagedServer
  activeManagedServer = undefined
  const bridge = activeBridge
  activeBridge = undefined
  const continuity = activeHandoffContinuity
  activeHandoffContinuity = undefined
  const stateWriter = activeStateWriter
  activeStateWriter = undefined
  const multiRun = activeMultiRun
  activeMultiRun = undefined
  const flushDurableMetadata = activeDurableMetadataFlush
  activeDurableMetadataFlush = undefined
  await settle([multiRun?.shutdown()])
  await settle([managed?.stop(), bridge?.stop()])
  await settle([flushDurableMetadata?.()])
  await settle([continuity?.dispose(), stateWriter?.dispose()])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} Workbench shutdown operations failed`)
}
