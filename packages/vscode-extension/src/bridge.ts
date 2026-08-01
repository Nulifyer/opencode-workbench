import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { promises as fs } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"

const BRIDGE_OPERATIONS = [
  "vscode_list_open_editors",
  "vscode_get_selection",
  "vscode_get_diagnostics",
  "vscode_open_file",
  "vscode_get_debug_context",
  "vscode_execute_terminal",
  "vscode_open_url",
] as const

type BridgeOperation = typeof BRIDGE_OPERATIONS[number]
type JsonRecord = Record<string, unknown>

const REQUEST_LIMIT = 128 * 1024
const RESPONSE_LIMIT = 64 * 1024
const REGISTRY_LIMIT = 1024 * 1024
const OPERATION_TIMEOUT_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 5_000

interface BridgeEntry {
  id: string
  worktree: string
  endpoint: string
  token: string
  pid: number
  updatedAt: number
  operations: BridgeOperation[]
}

interface BridgeRegistry {
  version: 1
  entries: BridgeEntry[]
}

interface BridgeRequest {
  version: 1
  operation: BridgeOperation
  params: JsonRecord
  context: { worktree: string; directory: string; sessionID: string }
}

class BridgeProtocolError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

function operationIsSupported(value: unknown): value is BridgeOperation {
  return typeof value === "string" && (BRIDGE_OPERATIONS as readonly string[]).includes(value)
}

function onlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function protocolError(error: unknown): string {
  if (error instanceof BridgeProtocolError) return error.code
  return "operation_failed"
}

function serializeUri(uri: vscode.Uri): { scheme: string; uri: string; fsPath?: string } {
  return { scheme: uri.scheme, uri: uri.toString(), fsPath: uri.scheme === "file" ? uri.fsPath : undefined }
}

function sendEncoded(response: ServerResponse, status: number, encoded: string): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(encoded)
}

function sendError(response: ServerResponse, code: string, status = 200): void {
  sendEncoded(response, status, JSON.stringify({ version: 1, ok: false, error: { code } }))
}

function sendSuccess(response: ServerResponse, result: unknown): void {
  const encoded = JSON.stringify({ version: 1, ok: true, result })
  if (Buffer.byteLength(encoded) > RESPONSE_LIMIT) {
    sendError(response, "response_too_large")
    return
  }
  sendEncoded(response, 200, encoded)
}

function assertRegistryEndpoint(value: string): void {
  const url = new URL(value)
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid VS Code bridge registry endpoint")
  }
}

function parseRegistry(value: unknown): BridgeRegistry {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 4_096) {
    throw new Error("Invalid VS Code bridge registry")
  }
  const ids = new Set<string>()
  const entries = value.entries.map((entry): BridgeEntry => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 128 || ids.has(entry.id) ||
      typeof entry.worktree !== "string" || entry.worktree.length === 0 || entry.worktree.length > 4_096 ||
      typeof entry.endpoint !== "string" || entry.endpoint.length === 0 || entry.endpoint.length > 2_048 ||
      typeof entry.token !== "string" || entry.token.length < 32 || entry.token.length > 512 ||
      !Number.isSafeInteger(entry.pid) || Number(entry.pid) <= 0 ||
      !Number.isSafeInteger(entry.updatedAt) || Number(entry.updatedAt) < 0 ||
      !Array.isArray(entry.operations) || entry.operations.length === 0 || entry.operations.length > BRIDGE_OPERATIONS.length ||
      !entry.operations.every(operationIsSupported) || new Set(entry.operations).size !== entry.operations.length) {
      throw new Error("Invalid VS Code bridge registry entry")
    }
    assertRegistryEndpoint(entry.endpoint)
    ids.add(entry.id)
    return entry as unknown as BridgeEntry
  })
  return { version: 1, entries }
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"])
  if (Number.isFinite(contentLength) && contentLength > REQUEST_LIMIT) throw new BridgeProtocolError("request_too_large")
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw signal.reason
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > REQUEST_LIMIT) throw new BridgeProtocolError("request_too_large")
      chunks.push(buffer)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch (error) {
    if (error instanceof BridgeProtocolError) throw error
    if (signal.aborted) throw signal.reason
    throw new BridgeProtocolError("invalid_request")
  }
}

function parseRequest(value: unknown): BridgeRequest {
  if (!isRecord(value) || value.version !== 1 || !operationIsSupported(value.operation) ||
    !isRecord(value.params) || !isRecord(value.context) ||
    typeof value.context.worktree !== "string" || value.context.worktree.length === 0 || value.context.worktree.length > 4_096 ||
    typeof value.context.directory !== "string" || value.context.directory.length === 0 || value.context.directory.length > 4_096 ||
    typeof value.context.sessionID !== "string" || value.context.sessionID.length === 0 || value.context.sessionID.length > 512 ||
    !onlyKeys(value, ["version", "operation", "params", "context"]) ||
    !onlyKeys(value.context, ["worktree", "directory", "sessionID"])) {
    throw new BridgeProtocolError("invalid_request")
  }
  return value as unknown as BridgeRequest
}

function abortable<T>(value: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function validateParams(operation: BridgeOperation, params: JsonRecord): JsonRecord {
  if ([
    "vscode_list_open_editors",
    "vscode_get_selection",
    "vscode_get_debug_context",
  ].includes(operation)) {
    if (!onlyKeys(params, [])) throw new BridgeProtocolError("invalid_params")
    return {}
  }
  if (operation === "vscode_get_diagnostics") {
    if (!onlyKeys(params, ["uri"]) || (params.uri !== undefined && (typeof params.uri !== "string" || params.uri.length === 0 || params.uri.length > 4_096))) {
      throw new BridgeProtocolError("invalid_params")
    }
    return { uri: params.uri }
  }
  if (operation === "vscode_open_file") {
    if (!onlyKeys(params, ["path", "line", "column", "preview"]) || typeof params.path !== "string" ||
      params.path.length === 0 || params.path.length > 4_096 ||
      (params.line !== undefined && (!Number.isSafeInteger(params.line) || Number(params.line) < 1 || Number(params.line) > 10_000_000)) ||
      (params.column !== undefined && (!Number.isSafeInteger(params.column) || Number(params.column) < 1 || Number(params.column) > 10_000_000)) ||
      (params.preview !== undefined && typeof params.preview !== "boolean")) {
      throw new BridgeProtocolError("invalid_params")
    }
    return params
  }
  if (operation === "vscode_execute_terminal") {
    if (!onlyKeys(params, ["executable", "args"]) || typeof params.executable !== "string" ||
      params.executable.length === 0 || params.executable.length > 4_096 ||
      (params.args !== undefined && (!Array.isArray(params.args) || params.args.length > 256 ||
        !params.args.every((argument) => typeof argument === "string" && argument.length <= 32_768)))) {
      throw new BridgeProtocolError("invalid_params")
    }
    return { executable: params.executable, args: params.args ?? [] }
  }
  if (operation === "vscode_open_url") {
    if (!onlyKeys(params, ["url"]) || typeof params.url !== "string" || params.url.length === 0 || params.url.length > 8_192) {
      throw new BridgeProtocolError("invalid_params")
    }
    return params
  }
  throw new BridgeProtocolError("unsupported_operation")
}

export class VsCodeBridge implements vscode.Disposable {
  private readonly token = randomBytes(32).toString("base64url")
  private readonly id = randomUUID()
  private readonly registryPath: string
  private server?: Server
  private workspaceRealPath = ""
  private endpoint = ""
  private terminal?: vscode.Terminal
  private heartbeat?: NodeJS.Timeout
  private registryTask: Promise<void> = Promise.resolve()
  private closing = false
  private stopping?: Promise<void>

  constructor(private readonly workspacePath: string) {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    this.registryPath = path.join(dataHome, "opencode-workbench", "bridges", "registry.json")
  }

  async start(): Promise<void> {
    this.workspaceRealPath = await fs.realpath(this.workspacePath)
    this.server = createServer((request, response) => void this.route(request, response))
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject)
      this.server?.listen(0, "127.0.0.1", () => resolve())
    })
    const address = this.server.address()
    if (!address || typeof address === "string") throw new Error("Bridge did not receive a loopback port")
    this.endpoint = `http://127.0.0.1:${address.port}/`
    try {
      await this.upsertRegistryEntry()
      this.heartbeat = setInterval(() => this.queueHeartbeat(), HEARTBEAT_INTERVAL_MS)
    } catch (error) {
      this.server.closeAllConnections()
      this.server.close()
      this.server = undefined
      throw error
    }
  }

  private entry(): BridgeEntry {
    return {
      id: this.id,
      worktree: this.workspaceRealPath,
      endpoint: this.endpoint,
      token: this.token,
      pid: process.pid,
      updatedAt: Date.now(),
      operations: [...BRIDGE_OPERATIONS],
    }
  }

  private queueHeartbeat(): void {
    this.registryTask = this.registryTask
      .then(() => this.closing ? undefined : this.upsertRegistryEntry())
      .catch((error) => console.warn("Could not refresh OpenCode VS Code bridge registry entry", error))
  }

  private upsertRegistryEntry(): Promise<void> {
    return this.updateRegistry((registry) => {
      const entry = this.entry()
      const index = registry.entries.findIndex((candidate) => candidate.id === this.id)
      if (index < 0) registry.entries.push(entry)
      else registry.entries[index] = entry
    })
  }

  private authorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
    if (typeof supplied !== "string") return false
    const expected = Buffer.from(this.token)
    const actual = Buffer.from(supplied)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || "/", "http://127.0.0.1")
    if (url.pathname !== "/" || url.search || url.hash) {
      sendError(response, "not_found", 404)
      return
    }
    if (request.method !== "POST") {
      sendError(response, "method_not_allowed", 405)
      return
    }
    if (!this.authorized(request)) {
      sendError(response, "unauthorized", 401)
      return
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      sendError(response, "invalid_request", 400)
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new BridgeProtocolError("timeout")), OPERATION_TIMEOUT_MS)
    const onAborted = () => controller.abort(new BridgeProtocolError("aborted"))
    request.once("aborted", onAborted)
    try {
      const envelope = parseRequest(await readBody(request, controller.signal))
      await this.validateContext(envelope.context)
      const params = validateParams(envelope.operation, envelope.params)
      const result = await abortable(this.dispatch(envelope.operation, params, controller.signal), controller.signal)
      if (!controller.signal.aborted && !response.destroyed) sendSuccess(response, result)
    } catch (error) {
      if (!response.destroyed) sendError(response, protocolError(error))
    } finally {
      clearTimeout(timeout)
      request.removeListener("aborted", onAborted)
    }
  }

  private async validateContext(context: BridgeRequest["context"]): Promise<void> {
    const worktree = await fs.realpath(context.worktree).catch(() => undefined)
    const directory = await fs.realpath(context.directory).catch(() => undefined)
    if (worktree !== this.workspaceRealPath || !directory || !this.pathIsContained(directory)) {
      throw new BridgeProtocolError("forbidden_context")
    }
  }

  private dispatch(operation: BridgeOperation, params: JsonRecord, signal: AbortSignal): Promise<unknown> | unknown {
    switch (operation) {
      case "vscode_list_open_editors": return this.openEditors()
      case "vscode_get_selection": return this.activeSelection()
      case "vscode_get_diagnostics": return this.diagnostics(params.uri)
      case "vscode_open_file": return this.openFile(params)
      case "vscode_get_debug_context": return this.debugContext()
      case "vscode_execute_terminal": return this.executeTerminal(params, signal)
      case "vscode_open_url": return this.openUrl(params)
    }
  }

  private pathIsContained(candidate: string): boolean {
    const relative = path.relative(this.workspaceRealPath, candidate)
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  private async uriIsContained(uri: vscode.Uri): Promise<boolean> {
    if (uri.scheme !== "file") return false
    const real = await fs.realpath(uri.fsPath).catch(() => undefined)
    return Boolean(real && this.pathIsContained(real))
  }

  private async openEditors(): Promise<unknown> {
    const result: unknown[] = []
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && await this.uriIsContained(tab.input.uri)) {
          result.push({ ...serializeUri(tab.input.uri), active: tab.isActive, dirty: tab.isDirty, label: tab.label })
        } else if (tab.input instanceof vscode.TabInputTextDiff &&
          await this.uriIsContained(tab.input.original) && await this.uriIsContained(tab.input.modified)) {
          result.push({
            type: "diff",
            original: serializeUri(tab.input.original),
            modified: serializeUri(tab.input.modified),
            active: tab.isActive,
            dirty: tab.isDirty,
            label: tab.label,
          })
        }
      }
    }
    return result
  }

  private async activeSelection(): Promise<unknown> {
    const editor = vscode.window.activeTextEditor
    if (!editor || !await this.uriIsContained(editor.document.uri)) return null
    const selection = editor.selection
    const text = editor.document.getText(selection)
    return {
      uri: serializeUri(editor.document.uri),
      selection: {
        start: { line: selection.start.line + 1, column: selection.start.character + 1 },
        end: { line: selection.end.line + 1, column: selection.end.character + 1 },
        text: text.slice(0, 32 * 1024),
        truncated: text.length > 32 * 1024,
      },
      languageId: editor.document.languageId,
    }
  }

  private async diagnostics(uriValue: unknown): Promise<unknown> {
    let groups: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>
    if (typeof uriValue === "string") {
      const uri = vscode.Uri.parse(uriValue, true)
      if (!await this.uriIsContained(uri)) throw new BridgeProtocolError("path_outside_worktree")
      groups = [[uri, vscode.languages.getDiagnostics(uri)]]
    } else {
      groups = vscode.languages.getDiagnostics()
    }
    const result: unknown[] = []
    for (const [uri, values] of groups) {
      if (!await this.uriIsContained(uri)) continue
      result.push({
        uri: serializeUri(uri),
        diagnostics: values.slice(0, 200).map((diagnostic) => ({
          message: diagnostic.message.slice(0, 2_000),
          severity: diagnostic.severity,
          source: diagnostic.source?.slice(0, 200),
          code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
          range: {
            start: { line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1 },
            end: { line: diagnostic.range.end.line + 1, column: diagnostic.range.end.character + 1 },
          },
        })),
      })
      if (result.length >= 100) break
    }
    return result
  }

  private async containedFile(value: unknown): Promise<string> {
    if (typeof value !== "string") throw new BridgeProtocolError("invalid_params")
    const candidate = path.isAbsolute(value) ? value : path.join(this.workspaceRealPath, value)
    const real = await fs.realpath(candidate).catch(() => undefined)
    if (!real) throw new BridgeProtocolError("file_not_found")
    if (!this.pathIsContained(real)) throw new BridgeProtocolError("path_outside_worktree")
    return real
  }

  private async openFile(params: JsonRecord): Promise<unknown> {
    const file = await this.containedFile(params.path)
    const line = typeof params.line === "number" ? params.line : 1
    const column = typeof params.column === "number" ? params.column : 1
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const lineIndex = Math.min(line - 1, Math.max(0, document.lineCount - 1))
    const position = new vscode.Position(lineIndex, Math.min(column - 1, document.lineAt(lineIndex).text.length))
    const editor = await vscode.window.showTextDocument(document, {
      preview: params.preview !== false,
      selection: new vscode.Range(position, position),
    })
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    return { opened: true, uri: serializeUri(document.uri) }
  }

  private async debugContext(): Promise<unknown> {
    const active = vscode.debug.activeDebugSession
    const session = active && (!active.workspaceFolder || await this.uriIsContained(active.workspaceFolder.uri))
      ? { id: active.id, name: active.name, type: active.type, workspaceFolder: active.workspaceFolder?.uri.fsPath }
      : null
    const breakpoints: unknown[] = []
    for (const breakpoint of vscode.debug.breakpoints) {
      if (breakpoint instanceof vscode.SourceBreakpoint) {
        if (!await this.uriIsContained(breakpoint.location.uri)) continue
        breakpoints.push({
          type: "source",
          enabled: breakpoint.enabled,
          uri: serializeUri(breakpoint.location.uri),
          line: breakpoint.location.range.start.line + 1,
          column: breakpoint.location.range.start.character + 1,
          condition: breakpoint.condition,
        })
      } else if (session && breakpoint instanceof vscode.FunctionBreakpoint) {
        breakpoints.push({ type: "function", enabled: breakpoint.enabled, functionName: breakpoint.functionName })
      }
    }
    return { session, breakpoints }
  }

  private async integratedTerminal(signal: AbortSignal): Promise<vscode.Terminal> {
    if (!this.terminal || this.terminal.exitStatus) {
      this.terminal = vscode.window.createTerminal({ name: "OpenCode Bridge", cwd: this.workspaceRealPath })
    }
    const terminal = this.terminal
    if (terminal.shellIntegration) return terminal
    terminal.show(false)
    return await new Promise<vscode.Terminal>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        subscription.dispose()
        signal.removeEventListener("abort", onAbort)
        if (error) reject(error)
        else resolve(terminal)
      }
      const timer = setTimeout(() => finish(new BridgeProtocolError("terminal_unavailable")), 5_000)
      const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal && event.shellIntegration) finish()
      })
      const onAbort = () => finish(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
      if (terminal.shellIntegration) finish()
      if (signal.aborted) finish(signal.reason)
    })
  }

  private async executeTerminal(params: JsonRecord, signal: AbortSignal): Promise<unknown> {
    const executable = params.executable as string
    const args = params.args as string[]
    const terminal = await this.integratedTerminal(signal)
    const integration = terminal.shellIntegration
    if (!integration) throw new BridgeProtocolError("terminal_unavailable")
    if (signal.aborted) throw signal.reason
    integration.executeCommand(executable, args)
    terminal.show(false)
    return { started: true, terminal: terminal.name }
  }

  private async openUrl(params: JsonRecord): Promise<unknown> {
    let url: URL
    try {
      url = new URL(params.url as string)
    } catch {
      throw new BridgeProtocolError("invalid_url")
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new BridgeProtocolError("invalid_url")
    return { opened: await vscode.env.openExternal(vscode.Uri.parse(url.toString())) }
  }

  private async updateRegistry(mutate: (registry: BridgeRegistry) => void): Promise<void> {
    const directory = path.dirname(this.registryPath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.chmod(directory, 0o700)
    const release = await this.acquireRegistryLock()
    try {
      let registry: BridgeRegistry = { version: 1, entries: [] }
      try {
        const stat = await fs.stat(this.registryPath)
        if (stat.size > REGISTRY_LIMIT) throw new Error("VS Code bridge registry exceeds the size limit")
        registry = parseRegistry(JSON.parse(await fs.readFile(this.registryPath, "utf8")))
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
      }
      const now = Date.now()
      registry.entries = registry.entries.filter((entry) =>
        entry.updatedAt <= now + 30_000 && now - entry.updatedAt <= 30_000 && processIsAlive(entry.pid)
      )
      mutate(registry)
      if (registry.entries.length > 256) throw new Error("VS Code bridge registry entry limit exceeded")
      const temporary = `${this.registryPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
      try {
        await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
        await fs.chmod(temporary, 0o600)
        await fs.rename(temporary, this.registryPath)
      } finally {
        await fs.unlink(temporary).catch((error) => {
          if (errorCode(error) !== "ENOENT") throw error
        })
      }
    } finally {
      await release()
    }
  }

  private async acquireRegistryLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.registryPath}.lock`
    const deadline = Date.now() + 3_000
    const owner = `${process.pid}:${randomUUID()}`
    while (true) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600)
        try {
          await handle.writeFile(owner)
        } catch (error) {
          await handle.close()
          await fs.unlink(lockPath).catch(() => undefined)
          throw error
        }
        return async () => {
          await handle.close()
          const current = await fs.readFile(lockPath, "utf8").catch(() => "")
          if (current === owner) {
            await fs.unlink(lockPath).catch((error) => {
              if (errorCode(error) !== "ENOENT") throw error
            })
          }
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
        try {
          const stat = await fs.stat(lockPath)
          const currentOwner = await fs.readFile(lockPath, "utf8").catch(() => "")
          const ownerPid = Number(currentOwner.split(":", 1)[0])
          if (Date.now() - stat.mtimeMs > 10_000 &&
            (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !processIsAlive(ownerPid))) {
            const confirmedOwner = await fs.readFile(lockPath, "utf8").catch(() => "")
            if (confirmedOwner !== currentOwner) continue
            const quarantine = `${lockPath}.stale-${randomUUID()}`
            try {
              await fs.rename(lockPath, quarantine)
              await fs.unlink(quarantine)
            } catch (takeoverError) {
              if (errorCode(takeoverError) !== "ENOENT") throw takeoverError
            }
            continue
          }
        } catch (statError) {
          if (errorCode(statError) === "ENOENT") continue
          throw statError
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the VS Code bridge registry lock")
        await pause(25)
      }
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopInner()
    return this.stopping
  }

  private async stopInner(): Promise<void> {
    this.closing = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    await this.registryTask
    const server = this.server
    this.server = undefined
    this.terminal?.dispose()
    this.terminal = undefined
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
    await this.updateRegistry((registry) => {
      registry.entries = registry.entries.filter((entry) => entry.id !== this.id)
    })
  }

  dispose(): void {
    void this.stop().catch((error) => console.warn("Could not remove OpenCode VS Code bridge registry entry", error))
  }
}
