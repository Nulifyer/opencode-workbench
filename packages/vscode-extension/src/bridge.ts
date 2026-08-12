import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { promises as fs } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"
import { bridgeContextIsContained, pathIsContained } from "./application/bridge-containment.js"
import { processLockCanBeReclaimed } from "./application/process-lock.js"
import type { OpenCodeReloadRequest } from "./deferred-reload.js"

const BRIDGE_OPERATIONS = [
  "vscode_list_open_editors",
  "vscode_get_selection",
  "vscode_get_active_buffer",
  "vscode_get_definitions",
  "vscode_get_references",
  "vscode_get_symbols",
  "vscode_get_diagnostics",
  "vscode_open_file",
  "vscode_get_debug_context",
  "vscode_execute_terminal",
  "vscode_list_tasks",
  "vscode_run_task",
  "vscode_get_code_actions",
  "vscode_preview_rename",
  "vscode_open_url",
  "vscode_request_opencode_reload",
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
  bridgeID: string
  operation: BridgeOperation
  params: JsonRecord
  context: { worktree: string; directory: string; sessionID: string }
}

export interface VsCodeBridgeOptions {
  bridgeID?: string
  requestOpenCodeReload?(request: OpenCodeReloadRequest): Promise<unknown> | unknown
  terminalEvidence?(result: { sessionID: string; exitCode?: number }): void
  taskEvidence?(result: { sessionID: string; name: string; source: string; group?: string; exitCode?: number }): void
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
  if (
    url.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("Invalid VS Code bridge registry endpoint")
  }
}

function parseRegistry(value: unknown): BridgeRegistry {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 4_096) {
    throw new Error("Invalid VS Code bridge registry")
  }
  const ids = new Set<string>()
  const entries = value.entries.map((entry): BridgeEntry => {
    if (
      !isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 128 ||
      ids.has(entry.id) ||
      typeof entry.worktree !== "string" || entry.worktree.length === 0 || entry.worktree.length > 4_096 ||
      typeof entry.endpoint !== "string" || entry.endpoint.length === 0 || entry.endpoint.length > 2_048 ||
      typeof entry.token !== "string" || entry.token.length < 32 || entry.token.length > 512 ||
      !Number.isSafeInteger(entry.pid) || Number(entry.pid) <= 0 ||
      !Number.isSafeInteger(entry.updatedAt) || Number(entry.updatedAt) < 0 ||
      !Array.isArray(entry.operations) || entry.operations.length === 0 ||
      entry.operations.length > BRIDGE_OPERATIONS.length ||
      !entry.operations.every(operationIsSupported) || new Set(entry.operations).size !== entry.operations.length
    ) {
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
  if (Number.isFinite(contentLength) && contentLength > REQUEST_LIMIT) {
    throw new BridgeProtocolError("request_too_large")
  }
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
  if (
    !isRecord(value) || value.version !== 1 || typeof value.bridgeID !== "string" || value.bridgeID.length === 0 ||
    value.bridgeID.length > 128 || !operationIsSupported(value.operation) ||
    !isRecord(value.params) || !isRecord(value.context) ||
    typeof value.context.worktree !== "string" || value.context.worktree.length === 0 ||
    value.context.worktree.length > 4_096 ||
    typeof value.context.directory !== "string" || value.context.directory.length === 0 ||
    value.context.directory.length > 4_096 ||
    typeof value.context.sessionID !== "string" || value.context.sessionID.length === 0 ||
    value.context.sessionID.length > 512 ||
    !onlyKeys(value, ["version", "bridgeID", "operation", "params", "context"]) ||
    !onlyKeys(value.context, ["worktree", "directory", "sessionID"])
  ) {
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
  if (
    [
      "vscode_list_open_editors",
      "vscode_get_selection",
      "vscode_get_debug_context",
      "vscode_list_tasks",
    ].includes(operation)
  ) {
    if (!onlyKeys(params, [])) throw new BridgeProtocolError("invalid_params")
    return {}
  }
  if (operation === "vscode_get_active_buffer") {
    if (
      !onlyKeys(params, ["scope", "maxCharacters"]) ||
      !["selection", "visible", "document"].includes(String(params.scope ?? "visible")) ||
      (params.maxCharacters !== undefined &&
        (!Number.isSafeInteger(params.maxCharacters) || Number(params.maxCharacters) < 1 ||
          Number(params.maxCharacters) > 48_000))
    ) {
      throw new BridgeProtocolError("invalid_params")
    }
    return { scope: params.scope ?? "visible", maxCharacters: params.maxCharacters ?? 32_000 }
  }
  if (["vscode_get_definitions", "vscode_get_references"].includes(operation)) {
    if (
      !onlyKeys(params, ["uri", "line", "column", "includeDeclaration"]) || typeof params.uri !== "string" ||
      params.uri.length === 0 || params.uri.length > 4_096 ||
      !Number.isSafeInteger(params.line) || Number(params.line) < 1 || Number(params.line) > 10_000_000 ||
      !Number.isSafeInteger(params.column) || Number(params.column) < 1 || Number(params.column) > 10_000_000 ||
      (params.includeDeclaration !== undefined && typeof params.includeDeclaration !== "boolean")
    ) throw new BridgeProtocolError("invalid_params")
    return {
      uri: params.uri,
      line: params.line,
      column: params.column,
      includeDeclaration: params.includeDeclaration ?? true,
    }
  }
  if (operation === "vscode_get_symbols") {
    if (
      !onlyKeys(params, ["uri"]) || typeof params.uri !== "string" || params.uri.length === 0 ||
      params.uri.length > 4_096
    ) throw new BridgeProtocolError("invalid_params")
    return params
  }
  if (operation === "vscode_get_diagnostics") {
    if (
      !onlyKeys(params, ["uri"]) ||
      (params.uri !== undefined &&
        (typeof params.uri !== "string" || params.uri.length === 0 || params.uri.length > 4_096))
    ) {
      throw new BridgeProtocolError("invalid_params")
    }
    return { uri: params.uri }
  }
  if (operation === "vscode_open_file") {
    if (
      !onlyKeys(params, ["path", "line", "column", "preview"]) || typeof params.path !== "string" ||
      params.path.length === 0 || params.path.length > 4_096 ||
      (params.line !== undefined &&
        (!Number.isSafeInteger(params.line) || Number(params.line) < 1 || Number(params.line) > 10_000_000)) ||
      (params.column !== undefined &&
        (!Number.isSafeInteger(params.column) || Number(params.column) < 1 || Number(params.column) > 10_000_000)) ||
      (params.preview !== undefined && typeof params.preview !== "boolean")
    ) {
      throw new BridgeProtocolError("invalid_params")
    }
    return params
  }
  if (operation === "vscode_execute_terminal") {
    if (
      !onlyKeys(params, ["executable", "args"]) || typeof params.executable !== "string" ||
      params.executable.length === 0 || params.executable.length > 4_096 ||
      (params.args !== undefined && (!Array.isArray(params.args) || params.args.length > 256 ||
        !params.args.every((argument) => typeof argument === "string" && argument.length <= 32_768)))
    ) {
      throw new BridgeProtocolError("invalid_params")
    }
    return { executable: params.executable, args: params.args ?? [] }
  }
  if (operation === "vscode_run_task") {
    if (
      !onlyKeys(params, ["name", "source"]) || typeof params.name !== "string" || !params.name ||
      params.name.length > 512 || typeof params.source !== "string" || !params.source || params.source.length > 512
    ) throw new BridgeProtocolError("invalid_params")
    return params
  }
  if (operation === "vscode_get_code_actions") {
    if (
      !onlyKeys(params, ["uri", "startLine", "startColumn", "endLine", "endColumn"]) ||
      typeof params.uri !== "string" || !params.uri || params.uri.length > 4_096 ||
      ![params.startLine, params.startColumn, params.endLine, params.endColumn].every((value) =>
        Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10_000_000
      )
    ) throw new BridgeProtocolError("invalid_params")
    return params
  }
  if (operation === "vscode_preview_rename") {
    if (
      !onlyKeys(params, ["uri", "line", "column", "newName"]) || typeof params.uri !== "string" || !params.uri ||
      params.uri.length > 4_096 || typeof params.newName !== "string" || !params.newName ||
      params.newName.length > 1_024 ||
      ![params.line, params.column].every((value) =>
        Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10_000_000
      )
    ) throw new BridgeProtocolError("invalid_params")
    return params
  }
  if (operation === "vscode_open_url") {
    if (
      !onlyKeys(params, ["url"]) || typeof params.url !== "string" || params.url.length === 0 ||
      params.url.length > 8_192
    ) {
      throw new BridgeProtocolError("invalid_params")
    }
    return params
  }
  if (operation === "vscode_request_opencode_reload") {
    if (
      !onlyKeys(params, ["reason"]) || !["skill-activation", "configuration-change"].includes(String(params.reason))
    ) {
      throw new BridgeProtocolError("invalid_params")
    }
    return { reason: params.reason }
  }
  throw new BridgeProtocolError("unsupported_operation")
}

export class VsCodeBridge implements vscode.Disposable {
  private readonly token = randomBytes(32).toString("base64url")
  private readonly id: string
  private readonly registryPath: string
  private server?: Server
  private workspaceRealPath = ""
  private endpoint = ""
  private terminal?: vscode.Terminal
  private lastTextEditor?: vscode.TextEditor
  private editorSubscription?: vscode.Disposable
  private readonly evidenceSubscriptions = new Set<vscode.Disposable>()
  private heartbeat?: NodeJS.Timeout
  private registryTask: Promise<void> = Promise.resolve()
  private closing = false
  private stopping?: Promise<void>

  constructor(private readonly workspacePath: string, private readonly options: VsCodeBridgeOptions = {}) {
    const bridgeID = options.bridgeID ?? randomUUID()
    if (!bridgeID || bridgeID.length > 128) throw new Error("Invalid VS Code bridge ID")
    this.id = bridgeID
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    this.registryPath = path.join(dataHome, "opencode-workbench", "bridges", "registry.json")
  }

  get bridgeID(): string {
    return this.id
  }

  async start(): Promise<void> {
    this.workspaceRealPath = await fs.realpath(this.workspacePath)
    this.lastTextEditor = vscode.window.activeTextEditor
    this.editorSubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) this.lastTextEditor = editor
    })
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
      this.editorSubscription.dispose()
      this.editorSubscription = undefined
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
      operations: BRIDGE_OPERATIONS.filter((operation) =>
        operation !== "vscode_request_opencode_reload" || this.options.requestOpenCodeReload
      ),
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
      if (envelope.bridgeID !== this.id) throw new BridgeProtocolError("wrong_bridge")
      await this.validateContext(envelope.context)
      const params = validateParams(envelope.operation, envelope.params)
      const result = await abortable(
        this.dispatch(envelope.operation, params, envelope.context, controller.signal),
        controller.signal,
      )
      if (!controller.signal.aborted && !response.destroyed) sendSuccess(response, result)
    } catch (error) {
      if (!response.destroyed) sendError(response, protocolError(error))
    } finally {
      clearTimeout(timeout)
      request.removeListener("aborted", onAborted)
    }
  }

  private async validateContext(context: BridgeRequest["context"]): Promise<void> {
    if (!await bridgeContextIsContained(this.workspaceRealPath, context)) {
      throw new BridgeProtocolError("forbidden_context")
    }
  }

  private dispatch(
    operation: BridgeOperation,
    params: JsonRecord,
    context: BridgeRequest["context"],
    signal: AbortSignal,
  ): Promise<unknown> | unknown {
    switch (operation) {
      case "vscode_list_open_editors":
        return this.openEditors()
      case "vscode_get_selection":
        return this.activeSelection()
      case "vscode_get_active_buffer":
        return this.activeBuffer(params)
      case "vscode_get_definitions":
        return this.locations(params, "vscode.executeDefinitionProvider")
      case "vscode_get_references":
        return this.locations(params, "vscode.executeReferenceProvider")
      case "vscode_get_symbols":
        return this.symbols(params)
      case "vscode_get_diagnostics":
        return this.diagnostics(params.uri)
      case "vscode_open_file":
        return this.openFile(params)
      case "vscode_get_debug_context":
        return this.debugContext()
      case "vscode_execute_terminal":
        return this.executeTerminal(params, context, signal)
      case "vscode_list_tasks":
        return this.listTasks()
      case "vscode_run_task":
        return this.runTask(params, context)
      case "vscode_get_code_actions":
        return this.codeActions(params)
      case "vscode_preview_rename":
        return this.previewRename(params)
      case "vscode_open_url":
        return this.openUrl(params)
      case "vscode_request_opencode_reload": {
        if (!this.options.requestOpenCodeReload) throw new BridgeProtocolError("unsupported_operation")
        return this.options.requestOpenCodeReload({
          sessionID: context.sessionID,
          reason: params.reason as OpenCodeReloadRequest["reason"],
        })
      }
    }
  }

  private pathIsContained(candidate: string): boolean {
    return pathIsContained(this.workspaceRealPath, candidate)
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
        } else if (
          tab.input instanceof vscode.TabInputTextDiff &&
          await this.uriIsContained(tab.input.original) && await this.uriIsContained(tab.input.modified)
        ) {
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
    const editor = vscode.window.activeTextEditor ?? this.lastTextEditor
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

  private async activeBuffer(params: JsonRecord): Promise<unknown> {
    const editor = vscode.window.activeTextEditor ?? this.lastTextEditor
    if (!editor || !await this.uriIsContained(editor.document.uri)) return null
    const scope = params.scope as "selection" | "visible" | "document"
    const limit = params.maxCharacters as number
    const ranges = scope === "selection"
      ? editor.selections.filter((range) => !range.isEmpty)
      : scope === "visible"
      ? editor.visibleRanges
      : [
        new vscode.Range(
          0,
          0,
          Math.max(0, editor.document.lineCount - 1),
          editor.document.lineAt(Math.max(0, editor.document.lineCount - 1)).text.length,
        ),
      ]
    let remaining = limit
    let truncated = false
    const contents = ranges.slice(0, 20).flatMap((range) => {
      if (remaining <= 0) {
        truncated = true
        return []
      }
      const text = editor.document.getText(range)
      const value = text.slice(0, remaining)
      remaining -= value.length
      if (value.length < text.length) truncated = true
      return [{
        start: { line: range.start.line + 1, column: range.start.character + 1 },
        end: { line: range.end.line + 1, column: range.end.character + 1 },
        text: value,
      }]
    })
    if (ranges.length > 20) truncated = true
    return {
      uri: serializeUri(editor.document.uri),
      languageId: editor.document.languageId,
      version: editor.document.version,
      dirty: editor.document.isDirty,
      scope,
      contents,
      truncated,
    }
  }

  private async documentPosition(
    params: JsonRecord,
  ): Promise<{ uri: vscode.Uri; document: vscode.TextDocument; position: vscode.Position }> {
    const uri = vscode.Uri.parse(params.uri as string, true)
    if (!await this.uriIsContained(uri)) throw new BridgeProtocolError("path_outside_worktree")
    const document = await vscode.workspace.openTextDocument(uri)
    const line = Number(params.line) - 1
    if (line < 0 || line >= document.lineCount) throw new BridgeProtocolError("invalid_position")
    const column = Number(params.column) - 1
    if (column < 0 || column > document.lineAt(line).text.length) throw new BridgeProtocolError("invalid_position")
    return { uri, document, position: new vscode.Position(line, column) }
  }

  private async locations(
    params: JsonRecord,
    command: "vscode.executeDefinitionProvider" | "vscode.executeReferenceProvider",
  ): Promise<unknown> {
    const { uri, position } = await this.documentPosition(params)
    const raw = command === "vscode.executeReferenceProvider"
      ? await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(command, uri, position, {
        includeDeclaration: params.includeDeclaration as boolean,
      })
      : await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(command, uri, position)
    const output: unknown[] = []
    let characters = 0
    for (const item of raw ?? []) {
      const targetUri = item instanceof vscode.Location ? item.uri : item.targetUri
      const range = item instanceof vscode.Location ? item.range : item.targetSelectionRange ?? item.targetRange
      if (!await this.uriIsContained(targetUri)) continue
      const serialized = serializeUri(targetUri)
      characters += serialized.uri.length + (serialized.fsPath?.length ?? 0)
      if (characters > 40_000) break
      output.push({
        uri: serialized,
        range: {
          start: { line: range.start.line + 1, column: range.start.character + 1 },
          end: { line: range.end.line + 1, column: range.end.character + 1 },
        },
      })
      if (output.length >= 100) break
    }
    return output
  }

  private async symbols(params: JsonRecord): Promise<unknown> {
    const uri = vscode.Uri.parse(params.uri as string, true)
    if (!await this.uriIsContained(uri)) throw new BridgeProtocolError("path_outside_worktree")
    const raw = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      "vscode.executeDocumentSymbolProvider",
      uri,
    )
    const output: unknown[] = []
    let characters = 0
    const append = (symbol: vscode.DocumentSymbol, depth: number): void => {
      if (output.length >= 200 || depth > 20 || characters >= 40_000) return
      const name = symbol.name.slice(0, 1_024)
      const detail = symbol.detail.slice(0, 2_000)
      characters += name.length + detail.length
      output.push({
        name,
        detail,
        kind: vscode.SymbolKind[symbol.kind],
        range: {
          start: { line: symbol.range.start.line + 1, column: symbol.range.start.character + 1 },
          end: { line: symbol.range.end.line + 1, column: symbol.range.end.character + 1 },
        },
      })
      for (const child of symbol.children) append(child, depth + 1)
    }
    for (const symbol of raw ?? []) {
      if (symbol instanceof vscode.DocumentSymbol) append(symbol, 0)
      else if (await this.uriIsContained(symbol.location.uri)) {
        const name = symbol.name.slice(0, 1_024)
        const containerName = symbol.containerName.slice(0, 1_024)
        const uri = serializeUri(symbol.location.uri)
        characters += name.length + containerName.length + uri.uri.length + (uri.fsPath?.length ?? 0)
        if (characters <= 40_000) output.push({ name, kind: vscode.SymbolKind[symbol.kind], containerName, uri })
      }
      if (output.length >= 200 || characters >= 40_000) break
    }
    return output
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
    const stackItem = vscode.debug.activeStackItem
    let stack: unknown[] = []
    if (session && active && stackItem && stackItem.session === active) {
      const threadId = stackItem.threadId
      try {
        const response = await active.customRequest("stackTrace", { threadId, startFrame: 0, levels: 20 }) as unknown
        const frames = isRecord(response) && Array.isArray(response.stackFrames) ? response.stackFrames : []
        for (const frame of frames.slice(0, 20)) {
          if (!isRecord(frame) || !Number.isSafeInteger(frame.id) || typeof frame.name !== "string") continue
          const source = isRecord(frame.source) ? frame.source : undefined
          const sourcePath = typeof source?.path === "string" ? source.path : undefined
          if (!sourcePath) continue
          const resolved = await fs.realpath(sourcePath).catch(() => undefined)
          if (!resolved || !this.pathIsContained(resolved)) continue
          stack.push({
            id: Number(frame.id),
            name: frame.name.slice(0, 2_000),
            source: sourcePath?.slice(0, 4_096),
            line: Number.isSafeInteger(frame.line) ? Number(frame.line) : undefined,
            column: Number.isSafeInteger(frame.column) ? Number(frame.column) : undefined,
            focused: stackItem instanceof vscode.DebugStackFrame && stackItem.frameId === frame.id,
          })
        }
      } catch {
        stack = []
      }
    }
    return { session, stack, breakpoints }
  }

  private async integratedTerminal(signal: AbortSignal): Promise<vscode.Terminal> {
    if (!this.terminal || this.terminal.exitStatus) {
      this.terminal = vscode.window.createTerminal({ name: "OpenCode Bridge", cwd: this.workspaceRealPath })
    }
    return await this.waitForTerminalIntegration(this.terminal, signal)
  }

  private async waitForTerminalIntegration(terminal: vscode.Terminal, signal: AbortSignal): Promise<vscode.Terminal> {
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

  private async executeTerminal(
    params: JsonRecord,
    context: BridgeRequest["context"],
    signal: AbortSignal,
  ): Promise<unknown> {
    const executable = params.executable as string
    const args = params.args as string[]
    const terminal = await this.integratedTerminal(signal)
    const integration = terminal.shellIntegration
    if (!integration) throw new BridgeProtocolError("terminal_unavailable")
    if (signal.aborted) throw signal.reason
    const execution = integration.executeCommand(executable, args)
    if (this.options.terminalEvidence) {
      const subscription = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution) return
        this.evidenceSubscriptions.delete(subscription)
        subscription.dispose()
        try {
          this.options.terminalEvidence?.({ sessionID: context.sessionID, exitCode: event.exitCode })
        } catch { /* Evidence capture must not affect terminal execution. */ }
      })
      this.evidenceSubscriptions.add(subscription)
    }
    terminal.show(false)
    return { started: true, terminal: terminal.name }
  }

  private async listTasks(): Promise<unknown> {
    const tasks = await vscode.tasks.fetchTasks()
    const output: unknown[] = []
    let characters = 0
    for (const task of tasks) {
      if (!await this.taskIsContained(task)) continue
      const item = {
        name: task.name.slice(0, 512),
        source: task.source.slice(0, 512),
        scope: typeof task.scope === "object" ? task.scope.name : task.scope,
        group: task.group?.id,
        isBackground: task.isBackground,
        problemMatchers: task.problemMatchers.slice(0, 20),
      }
      characters += item.name.length + item.source.length +
        item.problemMatchers.reduce((total, value) => total + value.length, 0)
      if (characters > 40_000) break
      output.push(item)
      if (output.length >= 200) break
    }
    return output
  }

  private async runTask(params: JsonRecord, context: BridgeRequest["context"]): Promise<unknown> {
    const tasks: vscode.Task[] = []
    for (const task of await vscode.tasks.fetchTasks()) {
      if (task.name === params.name && task.source === params.source && await this.taskIsContained(task)) {
        tasks.push(task)
      }
    }
    if (tasks.length !== 1) throw new BridgeProtocolError(tasks.length ? "ambiguous_task" : "task_not_found")
    const execution = await vscode.tasks.executeTask(tasks[0]!)
    if (this.options.taskEvidence) {
      const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution !== execution) return
        this.evidenceSubscriptions.delete(subscription)
        subscription.dispose()
        try {
          this.options.taskEvidence?.({
            sessionID: context.sessionID,
            name: execution.task.name,
            source: execution.task.source,
            group: execution.task.group?.id,
            exitCode: event.exitCode,
          })
        } catch { /* Evidence capture must not affect task execution. */ }
      })
      this.evidenceSubscriptions.add(subscription)
    }
    return { started: true, name: execution.task.name, source: execution.task.source }
  }

  private async taskIsContained(task: vscode.Task): Promise<boolean> {
    if (typeof task.scope === "object") {
      const root = await fs.realpath(task.scope.uri.fsPath).catch(() => undefined)
      return root === this.workspaceRealPath
    }
    if (task.scope !== vscode.TaskScope.Workspace) return false
    const folders = vscode.workspace.workspaceFolders ?? []
    if (folders.length !== 1) return false
    const root = await fs.realpath(folders[0]!.uri.fsPath).catch(() => undefined)
    return root === this.workspaceRealPath
  }

  private async workspaceEditPreview(
    edit: vscode.WorkspaceEdit | undefined,
    characterLimit = 32_000,
  ): Promise<unknown[]> {
    if (!edit) return []
    const output: unknown[] = []
    let characters = 0
    for (const [uri, edits] of edit.entries()) {
      if (!await this.uriIsContained(uri)) continue
      for (const item of edits) {
        if (!(item instanceof vscode.TextEdit)) continue
        const serialized = serializeUri(uri)
        const newText = item.newText.slice(0, 8_000)
        characters += serialized.uri.length + (serialized.fsPath?.length ?? 0) + newText.length
        if (characters > characterLimit) return output
        output.push({
          uri: serialized,
          range: {
            start: { line: item.range.start.line + 1, column: item.range.start.character + 1 },
            end: { line: item.range.end.line + 1, column: item.range.end.character + 1 },
          },
          newText,
          truncated: item.newText.length > 8_000,
        })
        if (output.length >= 200) return output
      }
    }
    return output
  }

  private async codeActions(params: JsonRecord): Promise<unknown> {
    const uri = vscode.Uri.parse(params.uri as string, true)
    if (!await this.uriIsContained(uri)) throw new BridgeProtocolError("path_outside_worktree")
    const document = await vscode.workspace.openTextDocument(uri)
    const position = (lineValue: unknown, columnValue: unknown): vscode.Position => {
      const line = Number(lineValue) - 1
      const column = Number(columnValue) - 1
      if (line < 0 || line >= document.lineCount || column < 0 || column > document.lineAt(line).text.length) {
        throw new BridgeProtocolError("invalid_position")
      }
      return new vscode.Position(line, column)
    }
    const range = new vscode.Range(
      position(params.startLine, params.startColumn),
      position(params.endLine, params.endColumn),
    )
    const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
      "vscode.executeCodeActionProvider",
      uri,
      range,
      undefined,
      20,
    )
    const output: unknown[] = []
    for (const action of actions ?? []) {
      if (!(action instanceof vscode.CodeAction)) continue
      output.push({
        title: action.title.slice(0, 2_000),
        kind: action.kind?.value,
        preferred: action.isPreferred,
        disabled: action.disabled?.reason.slice(0, 2_000),
        edits: await this.workspaceEditPreview(action.edit, 4_000),
      })
      if (output.length >= 10) break
    }
    return output
  }

  private async previewRename(params: JsonRecord): Promise<unknown> {
    const { uri, position } = await this.documentPosition(params)
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider",
      uri,
      position,
      params.newName,
    )
    return this.workspaceEditPreview(edit)
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
          if (processLockCanBeReclaimed(currentOwner, stat.mtimeMs, Date.now(), 10_000, processIsAlive)) {
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
    this.editorSubscription?.dispose()
    this.editorSubscription = undefined
    for (const subscription of this.evidenceSubscriptions) subscription.dispose()
    this.evidenceSubscriptions.clear()
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
