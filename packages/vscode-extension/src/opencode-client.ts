import {
  PERMISSION_AGGREGATE_CHARACTER_LIMIT,
  PERMISSION_METADATA_CHARACTER_LIMIT,
  permissionRequestCharacters,
} from "@opencode-workbench/shared"
import type {
  AgentOption,
  CommandOption,
  FileChange,
  MessageBundle,
  MessagePart,
  ModelOption,
  OpenCodeEvent,
  PermissionRequest,
  ProviderOption,
  QuestionInfo,
  QuestionRequest,
  ResourceOption,
  SessionInfo,
  SessionStatus,
  TodoItem,
} from "@opencode-workbench/shared"

export interface OpenCodeConnection {
  baseUrl: string
  username: string
  password: string
  directory: string
}

export function validateServerUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OpenCode server URL must use HTTP or HTTPS")
  if (url.username || url.password) throw new Error("OpenCode server URL must not contain credentials")
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("OpenCode HTTP server URL must use numeric loopback; use HTTPS for remote servers")
  }
}

type JsonRecord = Record<string, unknown>

const RESPONSE_BODY_LIMIT = 32 * 1024 * 1024
const ERROR_BODY_LIMIT = 64 * 1024
const REQUEST_TIMEOUT_MS = 30_000

export interface PromptFilePart {
  type: "file"
  mime: string
  url: string
  filename: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) throw new Error("OpenCode response exceeds the size limit")
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined)
        throw new Error("OpenCode response exceeds the size limit")
      }
      output += decoder.decode(value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit
}

interface MetadataBudget {
  nodes: number
  characters: number
  truncated: boolean
}

function boundedMetadata(value: unknown, depth = 0, budget: MetadataBudget = { nodes: 0, characters: 0, truncated: false }): unknown {
  budget.nodes += 1
  if (budget.nodes > 1_000 || depth > 8) {
    budget.truncated = true
    return null
  }
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value
    budget.truncated = true
    return null
  }
  if (typeof value === "string") {
    const remaining = Math.max(0, PERMISSION_METADATA_CHARACTER_LIMIT - budget.characters)
    if (value.length > remaining) budget.truncated = true
    budget.characters += Math.min(value.length, remaining)
    return value.slice(0, remaining)
  }
  if (Array.isArray(value)) {
    if (value.length > 100) budget.truncated = true
    const result: unknown[] = []
    for (const entry of value.slice(0, 100)) {
      if (budget.nodes >= 1_000 || budget.characters >= PERMISSION_METADATA_CHARACTER_LIMIT) {
        budget.truncated = true
        break
      }
      result.push(boundedMetadata(entry, depth + 1, budget))
    }
    return result
  }
  if (isRecord(value)) {
    const result: JsonRecord = Object.create(null) as JsonRecord
    const entries = Object.entries(value)
    if (entries.length > 100) budget.truncated = true
    for (const [key, entry] of entries.slice(0, 100)) {
      if (budget.nodes >= 1_000 || budget.characters >= PERMISSION_METADATA_CHARACTER_LIMIT) {
        budget.truncated = true
        break
      }
      const remaining = Math.max(0, PERMISSION_METADATA_CHARACTER_LIMIT - budget.characters)
      const boundedKey = key.slice(0, Math.min(1_024, remaining))
      if (boundedKey.length !== key.length) budget.truncated = true
      if (!boundedKey || Object.hasOwn(result, boundedKey)) {
        budget.truncated = true
        continue
      }
      budget.characters += boundedKey.length
      result[boundedKey] = boundedMetadata(entry, depth + 1, budget)
    }
    return result
  }
  budget.truncated = true
  return null
}

function metadata(value: unknown): { value?: Record<string, unknown>; truncated: boolean } | undefined {
  if (value === undefined) return { truncated: false }
  if (!isRecord(value)) return undefined
  const budget: MetadataBudget = { nodes: 0, characters: 0, truncated: false }
  return { value: boundedMetadata(value, 0, budget) as Record<string, unknown>, truncated: budget.truncated }
}

function permissionStrings(value: unknown, budget: { characters: number }): { values: string[]; truncated: boolean } | undefined {
  if (!Array.isArray(value)) return undefined
  let truncated = value.length > 100
  const values: string[] = []
  for (const item of value.slice(0, 100)) {
    if (typeof item !== "string") return undefined
    const remaining = Math.max(0, 800_000 - budget.characters)
    const bounded = item.slice(0, Math.min(20_000, remaining))
    if (bounded.length !== item.length) truncated = true
    budget.characters += bounded.length
    values.push(bounded)
  }
  return { values, truncated }
}

function boundedPermission(request: PermissionRequest): PermissionRequest | undefined {
  return permissionRequestCharacters(request) <= PERMISSION_AGGREGATE_CHARACTER_LIMIT ? request : undefined
}

function rejectOnlyPermission(request: PermissionRequest): PermissionRequest {
  return { id: request.id, sessionID: request.sessionID, title: request.title, type: request.type, protocol: request.protocol, truncated: true }
}

function parseEvent(value: unknown): OpenCodeEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.properties)) return undefined
  return { type: value.type, properties: value.properties }
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function projectedToolOutput(state: JsonRecord): string | undefined {
  if (typeof state.result === "string") return state.result
  if (!Array.isArray(state.content)) return undefined
  const text = state.content.flatMap((entry) => isRecord(entry) && typeof entry.text === "string" ? [entry.text] : [])
  return text.length ? text.join("\n") : undefined
}

function projectedMessages(value: unknown, sessionID: string): MessageBundle[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined
  const messages: MessageBundle[] = []
  for (const item of value.data) {
    if (!isRecord(item) || !boundedString(item.id, 1_024) || !item.id || !isRecord(item.time)) continue
    const created = timestamp(item.time.created)
    const completed = timestamp(item.time.completed)
    const time = created === undefined && completed === undefined ? undefined : { created, completed }
    if (item.type === "user" && typeof item.text === "string") {
      const parts: MessagePart[] = []
      if (item.text) parts.push({ id: `${item.id}-text`, sessionID, messageID: item.id, type: "text", text: item.text })
      if (Array.isArray(item.files)) for (const [index, file] of item.files.entries()) {
        if (!isRecord(file) || typeof file.uri !== "string" || typeof file.mime !== "string") continue
        const filename = typeof file.name === "string" && file.name ? file.name : `Attachment ${index + 1}`
        parts.push({ id: `${item.id}-file-${index}`, sessionID, messageID: item.id, type: "file", url: file.uri, mime: file.mime, filename })
      }
      messages.push({ info: { id: item.id, sessionID, role: "user", time }, parts })
      continue
    }
    if (item.type === "assistant" && Array.isArray(item.content)) {
      const parts: MessagePart[] = []
      for (const content of item.content) {
        if (!isRecord(content) || !boundedString(content.id, 1_024) || !content.id || typeof content.type !== "string") continue
        if ((content.type === "text" || content.type === "reasoning") && typeof content.text === "string") {
          const contentTime = isRecord(content.time) ? { start: timestamp(content.time.created), end: timestamp(content.time.completed) } : undefined
          parts.push({ id: content.id, sessionID, messageID: item.id, type: content.type, text: content.text, ...(contentTime ? { time: contentTime } : {}) })
          continue
        }
        if (content.type !== "tool" || typeof content.name !== "string" || !isRecord(content.state)) continue
        const stateTime = isRecord(content.time) ? { start: timestamp(content.time.created), end: timestamp(content.time.completed) } : undefined
        const error = isRecord(content.state.error) && typeof content.state.error.message === "string"
          ? content.state.error.message
          : typeof content.state.error === "string" ? content.state.error : undefined
        parts.push({
          id: content.id,
          sessionID,
          messageID: item.id,
          type: "tool",
          tool: content.name,
          time: stateTime,
          state: {
            status: typeof content.state.status === "string" ? content.state.status : undefined,
            input: content.state.input,
            output: projectedToolOutput(content.state),
            error,
            time: stateTime,
          },
        })
      }
      const model = isRecord(item.model) ? item.model : undefined
      messages.push({
        info: {
          id: item.id,
          sessionID,
          role: "assistant",
          time,
          agent: typeof item.agent === "string" ? item.agent : undefined,
          providerID: typeof model?.providerID === "string" ? model.providerID : undefined,
          modelID: typeof model?.id === "string" ? model.id : undefined,
          finish: typeof item.finish === "string" ? item.finish : undefined,
          cost: typeof item.cost === "number" ? item.cost : undefined,
          tokens: isRecord(item.tokens) ? item.tokens : undefined,
          error: item.error,
        },
        parts,
      })
      continue
    }
    if (item.type === "shell" && typeof item.command === "string") {
      messages.push({
        info: { id: item.id, sessionID, role: "assistant", time },
        parts: [{
          id: typeof item.callID === "string" ? item.callID : `${item.id}-shell`,
          sessionID,
          messageID: item.id,
          type: "tool",
          tool: "bash",
          state: { status: completed === undefined ? "running" : "completed", input: { command: item.command }, output: typeof item.output === "string" ? item.output : undefined },
        }],
      })
      continue
    }
    const text = typeof item.text === "string" ? item.text
      : item.type === "compaction" && typeof item.summary === "string" ? item.summary
      : undefined
    if (text !== undefined) messages.push({
      info: { id: item.id, sessionID, role: "assistant", time },
      parts: [{ id: `${item.id}-text`, sessionID, messageID: item.id, type: "text", text, synthetic: true }],
    })
  }
  return messages
}

function positiveTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? Math.floor(value) : undefined
}

function modelCapabilities(value: unknown): ModelOption["capabilities"] {
  if (!isRecord(value)) return undefined
  const modalities = (input: unknown) => {
    if (!isRecord(input)) return undefined
    return {
      text: typeof input.text === "boolean" ? input.text : undefined,
      audio: typeof input.audio === "boolean" ? input.audio : undefined,
      image: typeof input.image === "boolean" ? input.image : undefined,
      video: typeof input.video === "boolean" ? input.video : undefined,
      pdf: typeof input.pdf === "boolean" ? input.pdf : undefined,
    }
  }
  const interleaved = typeof value.interleaved === "boolean"
    ? value.interleaved
    : isRecord(value.interleaved) && boundedString(value.interleaved.field, 100) ? { field: value.interleaved.field } : undefined
  return {
    temperature: typeof value.temperature === "boolean" ? value.temperature : undefined,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : undefined,
    attachment: typeof value.attachment === "boolean" ? value.attachment : undefined,
    toolcall: typeof value.toolcall === "boolean" ? value.toolcall : undefined,
    input: modalities(value.input),
    output: modalities(value.output),
    interleaved,
  }
}

export function parsePermission(event: OpenCodeEvent): PermissionRequest | undefined {
  if (event.type !== "permission.updated" && event.type !== "permission.asked" && event.type !== "permission.v2.asked") return undefined
  const value = event.properties
  if (!boundedString(value.id, 1_024) || !value.id || !boundedString(value.sessionID, 1_024) || !value.sessionID) return undefined
  const parsedMetadata = metadata(value.metadata)
  if (!parsedMetadata) return undefined
  if (event.type === "permission.v2.asked") {
    const budget = { characters: 0 }
    const resources = permissionStrings(value.resources, budget)
    const save = value.save === undefined ? undefined : permissionStrings(value.save, budget)
    if (!boundedString(value.action, 1_024) || !value.action || !resources || (value.save !== undefined && !save)) return undefined
    return boundedPermission({
      id: value.id,
      sessionID: value.sessionID,
      title: `OpenCode permission: ${value.action}`,
      type: value.action,
      pattern: resources.values,
      always: save?.values,
      metadata: parsedMetadata.value,
      protocol: "v2",
      truncated: parsedMetadata.truncated || resources.truncated || save?.truncated || undefined,
    })
  }
  if (event.type === "permission.asked") {
    const budget = { characters: 0 }
    const patterns = permissionStrings(value.patterns, budget)
    const always = permissionStrings(value.always, budget)
    if (!boundedString(value.permission, 1_024) || !value.permission || !patterns || !always) return undefined
    return boundedPermission({
      id: value.id,
      sessionID: value.sessionID,
      title: `OpenCode permission: ${value.permission}`,
      type: value.permission,
      pattern: patterns.values,
      always: always.values,
      metadata: parsedMetadata.value,
      protocol: "current",
      truncated: parsedMetadata.truncated || patterns.truncated || always.truncated || undefined,
    })
  }
  if (typeof value.title !== "string" || typeof value.type !== "string") return undefined
  const budget = { characters: 0 }
  const patternList = Array.isArray(value.pattern) ? permissionStrings(value.pattern, budget) : undefined
  const pattern = typeof value.pattern === "string" ? value.pattern.slice(0, 20_000) : patternList?.values
  const truncated = parsedMetadata.truncated || value.title.length > 8_000 || value.type.length > 1_024 ||
    (typeof value.pattern === "string" && value.pattern.length > 20_000) || patternList?.truncated ||
    (Array.isArray(value.pattern) && !patternList) ||
    (value.pattern !== undefined && typeof value.pattern !== "string" && !Array.isArray(value.pattern))
  return boundedPermission({
    id: value.id,
    sessionID: value.sessionID,
    title: value.title.slice(0, 8_000) || "OpenCode permission request",
    type: value.type.slice(0, 1_024) || undefined,
    pattern,
    metadata: parsedMetadata.value,
    protocol: "legacy",
    truncated: truncated || undefined,
  })
}

export function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  const result: TodoItem[] = []
  let characters = 0
  for (const item of value.slice(0, 1_000)) {
    if (!isRecord(item) || (item.id !== undefined && (!boundedString(item.id, 1_024) || !item.id)) || !boundedString(item.content, 20_000) ||
      !boundedString(item.status, 100) || (item.priority !== undefined && !boundedString(item.priority, 100))) continue
    characters += (item.id?.length ?? 0) + item.content.length + item.status.length + (item.priority?.length ?? 0)
    if (characters > 1_000_000) break
    result.push({ id: item.id, content: item.content, status: item.status, priority: item.priority })
  }
  return result
}

export function parseCommands(value: unknown): CommandOption[] {
  if (!Array.isArray(value)) return []
  const commands: CommandOption[] = []
  let characters = 0
  for (const item of value.slice(0, 1_000)) {
    if (!isRecord(item) || !boundedString(item.name, 1_024) || !item.name ||
      (item.description !== undefined && !boundedString(item.description, 20_000)) ||
      (item.source !== undefined && !["command", "mcp", "skill"].includes(String(item.source))) ||
      (item.hints !== undefined && (!Array.isArray(item.hints) || item.hints.length > 100 || !item.hints.every((hint) => boundedString(hint, 2_000))))) continue
    characters += item.name.length + (typeof item.description === "string" ? item.description.length : 0) +
      (Array.isArray(item.hints) ? item.hints.reduce<number>((total, hint) => total + String(hint).length, 0) : 0)
    if (characters > 2_000_000) break
    commands.push({
      name: item.name,
      description: item.description as string | undefined,
      source: item.source as CommandOption["source"],
      hints: item.hints as string[] | undefined,
    })
  }
  return commands
}

export function parseChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) return []
  const result: FileChange[] = []
  let characters = 0
  for (const item of value.slice(0, 500)) {
    if (!isRecord(item) || !boundedString(item.file, 8_192) || !item.file ||
      !Number.isSafeInteger(item.additions) || Number(item.additions) < 0 ||
      !Number.isSafeInteger(item.deletions) || Number(item.deletions) < 0 ||
      (item.patch !== undefined && !boundedString(item.patch, 500_000)) ||
      (item.status !== undefined && !["added", "deleted", "modified"].includes(String(item.status)))) continue
    characters += item.file.length + (typeof item.patch === "string" ? item.patch.length : 0)
    if (characters > 4_000_000) break
    result.push({
      file: item.file,
      patch: item.patch as string | undefined,
      additions: Number(item.additions),
      deletions: Number(item.deletions),
      status: item.status as FileChange["status"],
    })
  }
  return result
}

function parseQuestionInfo(value: unknown): QuestionInfo | undefined {
  if (!isRecord(value) || !boundedString(value.question, 20_000) || !boundedString(value.header, 1_000) ||
    !Array.isArray(value.options) || value.options.length > 50 ||
    (value.multiple !== undefined && typeof value.multiple !== "boolean") ||
    (value.custom !== undefined && typeof value.custom !== "boolean")) return undefined
  const options = value.options.flatMap((option) =>
    isRecord(option) && boundedString(option.label, 2_000) && boundedString(option.description, 20_000)
      ? [{ label: option.label, description: option.description }]
      : []
  )
  if (options.length !== value.options.length) return undefined
  return {
    question: value.question,
    header: value.header,
    options,
    multiple: value.multiple,
    custom: value.custom,
  }
}

export function parseQuestions(value: unknown, protocol: QuestionRequest["protocol"]): QuestionRequest[] {
  const source = isRecord(value) && Array.isArray(value.data) ? value.data : value
  if (!Array.isArray(source)) return []
  const result: QuestionRequest[] = []
  let characters = 0
  for (const item of source.slice(0, 100)) {
    if (!isRecord(item) || !boundedString(item.id, 1_024) || !item.id || !boundedString(item.sessionID, 1_024) || !item.sessionID ||
      !Array.isArray(item.questions) || item.questions.length === 0 || item.questions.length > 20) continue
    const questions = item.questions.map(parseQuestionInfo)
    if (questions.some((question) => !question)) continue
    characters += item.id.length + item.sessionID.length + questions.reduce((total, question) =>
      total + question!.question.length + question!.header.length + question!.options.reduce((sum, option) => sum + option.label.length + option.description.length, 0), 0)
    if (characters > 1_000_000) break
    result.push({ id: item.id, sessionID: item.sessionID, questions: questions as QuestionInfo[], protocol })
  }
  return result
}

export function parseQuestion(event: OpenCodeEvent): QuestionRequest | undefined {
  if (event.type !== "question.asked" && event.type !== "question.v2.asked") return undefined
  return parseQuestions([event.properties], event.type === "question.v2.asked" ? "v2" : "legacy")[0]
}

export function parsePermissions(value: unknown, protocol: "current" | "v2"): PermissionRequest[] {
  const source = isRecord(value) && Array.isArray(value.data) ? value.data : value
  if (!Array.isArray(source)) return []
  const characters = new Map<string, number>()
  const counts = new Map<string, number>()
  const requests: PermissionRequest[] = []
  for (const item of source.slice(0, 10_000)) {
    if (!isRecord(item)) continue
    const parsed = protocol === "v2"
      ? parsePermission({ type: "permission.v2.asked", properties: item })
      : parsePermission({ type: "permission.asked", properties: item })
        ?? parsePermission({ type: "permission.updated", properties: item })
    if (!parsed) continue
    if ((counts.get(parsed.sessionID) ?? 0) >= 100) continue
    const current = characters.get(parsed.sessionID) ?? 0
    let safe = parsed
    let next = current + permissionRequestCharacters(safe)
    if (next > PERMISSION_AGGREGATE_CHARACTER_LIMIT) {
      safe = rejectOnlyPermission(parsed)
      next = current + permissionRequestCharacters(safe)
    }
    if (next > PERMISSION_AGGREGATE_CHARACTER_LIMIT) continue
    characters.set(parsed.sessionID, next)
    counts.set(parsed.sessionID, (counts.get(parsed.sessionID) ?? 0) + 1)
    requests.push(safe)
  }
  return requests
}

export class OpenCodeClient {
  private requests = new AbortController()

  constructor(private connection: OpenCodeConnection) {
    validateServerUrl(connection.baseUrl)
  }

  update(connection: OpenCodeConnection): void {
    validateServerUrl(connection.baseUrl)
    this.cancelPendingRequests()
    this.connection = connection
  }

  cancelPendingRequests(): void {
    this.requests.abort(new Error("OpenCode connection changed"))
    this.requests = new AbortController()
  }

  canReadLocalFiles(): boolean {
    const hostname = new URL(this.connection.baseUrl).hostname
    return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
  }

  private endpoint(pathname: string): URL {
    const base = this.connection.baseUrl.endsWith("/") ? this.connection.baseUrl : `${this.connection.baseUrl}/`
    const url = new URL(pathname.replace(/^\//, ""), base)
    url.searchParams.set("directory", this.connection.directory)
    return url
  }

  private locationPath(pathname: string, parameters: Record<string, string> = {}): string {
    const query = new URLSearchParams({ ...parameters, "location[directory]": this.connection.directory })
    return `${pathname}?${query}`
  }

  private headers(json = false): Headers {
    const headers = new Headers({ Accept: "application/json" })
    if (json) headers.set("Content-Type", "application/json")
    if (this.connection.password) {
      const credential = Buffer.from(`${this.connection.username}:${this.connection.password}`, "utf8").toString("base64")
      headers.set("Authorization", `Basic ${credential}`)
    }
    return headers
  }

  private async request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const sources = [this.requests.signal, signal].filter((value): value is AbortSignal => Boolean(value))
    const abort = (source: AbortSignal) => controller.abort(source.reason)
    for (const source of sources) {
      source.addEventListener("abort", () => abort(source), { once: true, signal: controller.signal })
      if (source.aborted) abort(source)
    }
    const timeout = setTimeout(() => controller.abort(new Error(`OpenCode ${method} ${pathname} timed out`)), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(this.endpoint(pathname), {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = (await readLimitedText(response, ERROR_BODY_LIMIT)).slice(0, 1_000)
        throw new Error(`OpenCode ${method} ${pathname} failed (${response.status})${detail ? `: ${detail}` : ""}`)
      }
      if (response.status === 204) return undefined as T
      const encoded = await readLimitedText(response, RESPONSE_BODY_LIMIT)
      try {
        return JSON.parse(encoded) as T
      } catch {
        throw new Error(`OpenCode ${method} ${pathname} returned invalid JSON`)
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.request("GET", "/session")
  }

  sessionStatuses(): Promise<Record<string, SessionStatus>> {
    return this.request("GET", "/session/status")
  }

  createSession(title?: string): Promise<SessionInfo> {
    return this.request("POST", "/session", title ? { title } : {})
  }

  deleteSession(sessionID: string): Promise<boolean> {
    return this.request("DELETE", `/session/${encodeURIComponent(sessionID)}`)
  }

  renameSession(sessionID: string, title: string): Promise<SessionInfo> {
    return this.request("PATCH", `/session/${encodeURIComponent(sessionID)}`, { title })
  }

  forkSession(sessionID: string, messageID?: string): Promise<SessionInfo> {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/fork`, messageID ? { messageID } : {})
  }

  revertSession(sessionID: string, messageID: string, partID?: string): Promise<SessionInfo> {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/revert`, { messageID, ...(partID ? { partID } : {}) })
  }

  unrevertSession(sessionID: string): Promise<SessionInfo> {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/unrevert`)
  }

  summarizeSession(sessionID: string, providerID: string, modelID: string): Promise<boolean> {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/summarize`, { providerID, modelID })
  }

  shareSession(sessionID: string): Promise<SessionInfo> {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/share`)
  }

  unshareSession(sessionID: string): Promise<SessionInfo> {
    return this.request("DELETE", `/session/${encodeURIComponent(sessionID)}/share`)
  }

  async messages(sessionID: string): Promise<MessageBundle[]> {
    const encoded = encodeURIComponent(sessionID)
    const [v2, legacy] = await Promise.allSettled([
      this.request<unknown>("GET", this.locationPath(`/api/session/${encoded}/message`, { limit: "200", order: "desc" })),
      this.request<unknown>("GET", `/session/${encoded}/message`),
    ])
    const current = v2.status === "fulfilled" ? projectedMessages(v2.value, sessionID)?.reverse() : undefined
    if (v2.status === "fulfilled" && !current) throw new Error("OpenCode returned malformed v2 session messages")
    const previous = legacy.status === "fulfilled" && Array.isArray(legacy.value) ? legacy.value as MessageBundle[] : []
    if (!current && legacy.status === "rejected") throw v2.status === "rejected" ? v2.reason : legacy.reason
    const merged = previous.slice()
    const positions = new Map(merged.map((message, index) => [message.info?.id, index]))
    for (const message of current ?? []) {
      const position = positions.get(message.info.id)
      if (position === undefined) {
        positions.set(message.info.id, merged.length)
        merged.push(message)
      } else merged[position] = message
    }
    return merged
  }

  async todos(sessionID: string): Promise<TodoItem[]> {
    return parseTodos(await this.request<unknown>("GET", `/session/${encodeURIComponent(sessionID)}/todo`))
  }

  async changes(sessionID: string): Promise<FileChange[]> {
    return parseChanges(await this.request<unknown>("GET", `/session/${encodeURIComponent(sessionID)}/diff`))
  }

  async pendingQuestionsDetailed(): Promise<{ requests: QuestionRequest[]; succeeded: Array<"legacy" | "v2"> }> {
    const [v2, legacy] = await Promise.allSettled([
      this.request<unknown>("GET", this.locationPath("/api/question/request")),
      this.request<unknown>("GET", "/question"),
    ])
    if (v2.status === "rejected" && legacy.status === "rejected") throw v2.reason
    const v2Valid = v2.status === "fulfilled" && isRecord(v2.value) && Array.isArray(v2.value.data)
    const legacyValid = legacy.status === "fulfilled" && (Array.isArray(legacy.value) || (isRecord(legacy.value) && Array.isArray(legacy.value.data)))
    if (!v2Valid && !legacyValid) throw new Error("OpenCode returned malformed question lists")
    const requests = [
      ...(v2Valid ? parseQuestions(v2.value, "v2") : []),
      ...(legacyValid ? parseQuestions(legacy.value, "legacy") : []),
    ]
    const seen = new Set<string>()
    let characters = 0
    return {
      requests: requests.filter((request) => {
      const key = `${request.sessionID}\0${request.id}`
      const size = request.id.length + request.sessionID.length + request.questions.reduce((total, question) =>
        total + question.question.length + question.header.length + question.options.reduce((sum, option) => sum + option.label.length + option.description.length, 0), 0)
      if (seen.has(key) || characters + size > 1_000_000) return false
      seen.add(key)
      characters += size
      return true
      }).slice(0, 100),
      succeeded: [v2Valid ? "v2" as const : undefined, legacyValid ? "legacy" as const : undefined]
        .filter((protocol): protocol is "legacy" | "v2" => Boolean(protocol)),
    }
  }

  async pendingQuestions(): Promise<QuestionRequest[]> {
    return (await this.pendingQuestionsDetailed()).requests
  }

  async respondQuestion(request: QuestionRequest, answers: string[][]): Promise<void> {
    const sessionID = encodeURIComponent(request.sessionID)
    const requestID = encodeURIComponent(request.id)
    await this.request(
      "POST",
      request.protocol === "v2" ? `/api/session/${sessionID}/question/${requestID}/reply` : `/question/${requestID}/reply`,
      { answers },
    )
  }

  async rejectQuestion(request: QuestionRequest): Promise<void> {
    const sessionID = encodeURIComponent(request.sessionID)
    const requestID = encodeURIComponent(request.id)
    await this.request(
      "POST",
      request.protocol === "v2" ? `/api/session/${sessionID}/question/${requestID}/reject` : `/question/${requestID}/reject`,
    )
  }

  path(): Promise<unknown> {
    return this.request("GET", "/path")
  }

  vcs(): Promise<unknown> {
    return this.request("GET", "/vcs")
  }

  lsp(): Promise<unknown> {
    return this.request("GET", "/lsp")
  }

  formatter(): Promise<unknown> {
    return this.request("GET", "/formatter")
  }

  mcp(): Promise<unknown> {
    return this.request("GET", "/mcp")
  }

  mcpAction(name: string, action: "connect" | "disconnect" | "authenticate" | "removeAuth"): Promise<unknown> {
    const encoded = encodeURIComponent(name)
    const path = action === "authenticate" ? `/mcp/${encoded}/auth/authenticate`
      : action === "removeAuth" ? `/mcp/${encoded}/auth`
      : `/mcp/${encoded}/${action}`
    return this.request(action === "removeAuth" ? "DELETE" : "POST", path)
  }

  abort(sessionID: string): Promise<boolean> {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/abort`)
  }

  disposeInstance(): Promise<boolean> {
    return this.request("POST", "/instance/dispose")
  }

  sendAsync(sessionID: string, text: string, agent?: string, model?: string, variant?: string, files: PromptFilePart[] = []): Promise<void> {
    const body: JsonRecord = { parts: [...(text.trim() ? [{ type: "text", text }] : []), ...files] }
    if (agent) body.agent = agent
    if (model) {
      const slash = model.indexOf("/")
      if (slash <= 0 || slash === model.length - 1) throw new Error("Model must be provider/model")
      body.model = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
    }
    if (variant) body.variant = variant
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/prompt_async`, body)
  }

  async sendPrompt(
    sessionID: string,
    promptID: string,
    text: string,
    delivery: "steer" | "queue",
    agent?: string,
    model?: string,
    variant?: string,
    files: PromptFilePart[] = [],
    agents: string[] = [],
  ): Promise<void> {
    const encodedSessionID = encodeURIComponent(sessionID)
    if (agent) await this.request("POST", this.locationPath(`/api/session/${encodedSessionID}/agent`), { agent })
    if (model) {
      const slash = model.indexOf("/")
      if (slash <= 0 || slash === model.length - 1) throw new Error("Model must be provider/model")
      await this.request("POST", this.locationPath(`/api/session/${encodedSessionID}/model`), {
        model: { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(variant ? { variant } : {}) },
      })
    }
    await this.request("POST", this.locationPath(`/api/session/${encodedSessionID}/prompt`), {
      id: promptID,
      prompt: {
        text,
        ...(files.length ? { files: files.map((file) => ({ uri: file.url, name: file.filename })) } : {}),
        ...(agents.length ? { agents: agents.map((name) => ({ name })) } : {}),
      },
      delivery,
      resume: true,
    })
  }

  sendCommand(sessionID: string, command: string, args: string, agent?: string, model?: string, variant?: string, files: PromptFilePart[] = [], messageID?: string): Promise<unknown> {
    const body: JsonRecord = { command, arguments: args }
    if (messageID) body.messageID = messageID
    if (files.length) body.parts = files
    if (agent) body.agent = agent
    if (model) {
      const slash = model.indexOf("/")
      if (slash <= 0 || slash === model.length - 1) throw new Error("Model must be provider/model")
      body.model = model
    }
    if (variant) body.variant = variant
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/command`, body)
  }

  async respondPermission(request: PermissionRequest, response: "once" | "always" | "reject", feedback?: string): Promise<void> {
    const message = response === "reject" && feedback?.trim() ? feedback.trim() : undefined
    if (request.protocol === "v2") {
      await this.request("POST", `/api/session/${encodeURIComponent(request.sessionID)}/permission/${encodeURIComponent(request.id)}/reply`, { reply: response, ...(message ? { message } : {}) })
      return
    }
    const accepted = await (request.protocol === "current"
      ? this.request("POST", `/permission/${encodeURIComponent(request.id)}/reply`, { reply: response, ...(message ? { message } : {}) })
      : this.request("POST", `/session/${encodeURIComponent(request.sessionID)}/permissions/${encodeURIComponent(request.id)}`, { response }))
    if (accepted !== true) throw new Error("OpenCode did not accept the permission response")
  }

  async pendingPermissionsDetailed(): Promise<{ requests: PermissionRequest[]; succeeded: Array<"current" | "v2"> }> {
    const [v2, current] = await Promise.allSettled([
      this.request<unknown>("GET", this.locationPath("/api/permission/request")),
      this.request<unknown>("GET", "/permission"),
    ])
    const v2Valid = v2.status === "fulfilled" && isRecord(v2.value) && Array.isArray(v2.value.data)
    const currentValid = current.status === "fulfilled" && Array.isArray(current.value)
    if (!v2Valid && !currentValid) {
      if (v2.status === "rejected" && current.status === "rejected") throw v2.reason
      throw new Error("OpenCode returned malformed permission lists")
    }
    const values = [
      ...(v2Valid ? parsePermissions(v2.value, "v2") : []),
      ...(currentValid ? parsePermissions(current.value, "current") : []),
    ]
    const seen = new Set<string>()
    const requests = values.flatMap((value) => {
      const key = `${value.protocol}\0${value.sessionID}\0${value.id}`
      if (seen.has(key)) return []
      seen.add(key)
      return [value]
    }).slice(0, 10_000)
    return {
      requests,
      succeeded: [v2Valid ? "v2" as const : undefined, currentValid ? "current" as const : undefined]
        .filter((protocol): protocol is "current" | "v2" => Boolean(protocol)),
    }
  }

  async pendingPermissions(): Promise<PermissionRequest[]> {
    return (await this.pendingPermissionsDetailed()).requests
  }

  async catalogs(): Promise<{
    agents: AgentOption[]
    mentionAgents: AgentOption[]
    providers: ProviderOption[]
    models: ModelOption[]
    resources: ResourceOption[]
    defaults: { agent?: string; model?: string; variant?: string }
  }> {
    const [agentData, configProviderResult, configResult, resourceResult] = await Promise.all([
      this.request<unknown>("GET", "/agent"),
      this.request<unknown>("GET", "/config/providers").catch(async () => {
        const legacy = await this.request<unknown>("GET", "/provider")
        if (!isRecord(legacy) || !Array.isArray(legacy.all) || !Array.isArray(legacy.connected)) throw new Error("OpenCode returned a malformed provider catalog")
        const connected = new Set(legacy.connected.filter((id): id is string => typeof id === "string"))
        return { providers: legacy.all.filter((provider) => isRecord(provider) && typeof provider.id === "string" && connected.has(provider.id)), default: legacy.default }
      }),
      this.request<unknown>("GET", "/config").catch(() => undefined),
      this.request<unknown>("GET", "/experimental/resource").catch(() => ({})),
    ])
    const agents: AgentOption[] = []
    const mentionAgents: AgentOption[] = []
    let catalogCharacters = 0
    for (const value of Array.isArray(agentData) ? agentData.slice(0, 500) : []) {
      if (!isRecord(value) || !boundedString(value.name, 1_024) || !value.name || value.hidden === true ||
        ![undefined, "primary", "subagent", "all"].includes(value.mode as undefined | string)) continue
      const description = boundedString(value.description, 20_000) ? value.description : undefined
      const model = isRecord(value.model) && boundedString(value.model.providerID, 1_024) && value.model.providerID &&
          boundedString(value.model.modelID, 1_024) && value.model.modelID
        ? { providerID: value.model.providerID, modelID: value.model.modelID }
        : undefined
      catalogCharacters += value.name.length + (description?.length ?? 0)
      if (catalogCharacters > 2_000_000) break
      const option: AgentOption = {
        name: value.name,
        description,
        model,
        variant: boundedString(value.variant, 1_024) ? value.variant : undefined,
        mode: value.mode as AgentOption["mode"],
      }
      if (value.mode !== "subagent") agents.push(option)
      if (value.mode !== "primary") mentionAgents.push(option)
    }
    if (!isRecord(configProviderResult) || !Array.isArray(configProviderResult.providers)) throw new Error("OpenCode returned a malformed configured-provider catalog")
    const all = configProviderResult.providers
    const providers: ProviderOption[] = []
    const models: ModelOption[] = []
    catalogCharacters = 0
    for (const provider of all.slice(0, 500)) {
      if (!isRecord(provider) || !boundedString(provider.id, 1_024) || !provider.id || !isRecord(provider.models)) continue
      const providerName = boundedString(provider.name, 2_000) ? provider.name : provider.id
      const source = ["env", "config", "custom", "api"].includes(String(provider.source)) ? provider.source as ProviderOption["source"] : undefined
      providers.push({ id: provider.id, name: providerName, source })
      for (const [id, model] of Object.entries(provider.models)) {
        if (models.length >= 5_000 || !id || id.length > 1_024 || !isRecord(model)) continue
        const limit = isRecord(model.limit) ? model.limit : undefined
        const contextLimit = positiveTokenLimit(limit?.context)
        const inputLimit = positiveTokenLimit(limit?.input)
        const outputLimit = positiveTokenLimit(limit?.output)
        const name = boundedString(model.name, 2_000) ? model.name : id
        const variants = isRecord(model.variants)
          ? Object.keys(model.variants).slice(0, 100).filter((variant) => variant.length > 0 && variant.length <= 1_024)
          : []
        catalogCharacters += id.length + provider.id.length + name.length + variants.reduce((total, variant) => total + variant.length, 0)
        if (catalogCharacters > 2_000_000) break
        models.push({
          id,
          providerID: provider.id,
          name,
          contextLimit,
          inputLimit,
          outputLimit,
          status: boundedString(model.status, 100) ? model.status : undefined,
          releaseDate: boundedString(model.release_date, 100) ? model.release_date : undefined,
          capabilities: modelCapabilities(model.capabilities),
          variants: variants.length ? variants : undefined,
        })
      }
    }
    const resources: ResourceOption[] = []
    catalogCharacters = 0
    if (isRecord(resourceResult)) for (const value of Object.values(resourceResult).slice(0, 2_000)) {
      if (!isRecord(value) || !boundedString(value.name, 2_000) || !boundedString(value.uri, 8_192) || !value.uri || !boundedString(value.client, 2_000)) continue
      const resource = {
        name: value.name,
        uri: value.uri,
        description: boundedString(value.description, 20_000) ? value.description : undefined,
        mimeType: boundedString(value.mimeType, 100) ? value.mimeType : undefined,
        client: value.client,
      }
      catalogCharacters += resource.name.length + resource.uri.length + resource.client.length + (resource.description?.length ?? 0)
      if (catalogCharacters > 2_000_000) break
      resources.push(resource)
    }
    const config = isRecord(configResult) ? configResult : undefined
    const configuredAgent = boundedString(config?.default_agent, 1_024) && agents.some((agent) => agent.name === config.default_agent)
      ? config.default_agent
      : undefined
    const configuredModel = boundedString(config?.model, 2_049) && models.some((model) => `${model.providerID}/${model.id}` === config.model)
      ? config.model
      : undefined
    const providerDefaults = isRecord(configProviderResult.default) ? configProviderResult.default : undefined
    const providerModel = models.map((model) => {
      const value = providerDefaults?.[model.providerID]
      return typeof value === "string" && value === model.id ? `${model.providerID}/${model.id}` : undefined
    }).find((value): value is string => Boolean(value))
    const effectiveAgent = configuredAgent ?? agents[0]?.name
    const defaultAgent = agents.find((agent) => agent.name === effectiveAgent)
    const configuredVariant = defaultAgent?.model && `${defaultAgent.model.providerID}/${defaultAgent.model.modelID}` === (configuredModel ?? providerModel)
      ? defaultAgent.variant
      : undefined
    return {
      agents,
      mentionAgents,
      providers,
      models,
      resources,
      defaults: {
        agent: effectiveAgent,
        model: configuredModel ?? providerModel ?? (models[0] ? `${models[0].providerID}/${models[0].id}` : undefined),
        variant: configuredVariant,
      },
    }
  }

  async commands(): Promise<CommandOption[]> {
    return parseCommands(await this.request<unknown>("GET", "/command"))
  }

  async events(signal: AbortSignal, onOpen: () => Promise<void> | void, onEvent: (event: OpenCodeEvent) => void): Promise<void> {
    const headers = this.headers()
    headers.set("Accept", "text/event-stream")
    const response = await fetch(this.endpoint("/event"), {
      method: "GET",
      headers,
      signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`OpenCode event stream failed (${response.status})`)
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    try {
      await onOpen()
      while (true) {
        const { done, value } = await reader.read()
        if (done) throw new Error("OpenCode event stream closed")
        buffer += value
        buffer = buffer.replace(/\r\n/g, "\n")
        if (buffer.length > 512 * 1024) throw new Error("OpenCode event stream frame exceeds 512 KiB")
        let boundary = buffer.indexOf("\n\n")
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
          if (data) {
            try {
              const event = parseEvent(JSON.parse(data))
              if (event) onEvent(event)
            } catch (error) {
              console.warn("Ignored malformed OpenCode SSE event", errorMessage(error))
            }
          }
          boundary = buffer.indexOf("\n\n")
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}
