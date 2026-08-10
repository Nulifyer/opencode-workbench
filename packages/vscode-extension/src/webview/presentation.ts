import { isNativeCompactionContinuationMessage as sharedIsNativeCompactionContinuationMessage, type ChatSnapshot, type ConnectionState, type MessageBundle, type MessagePart, type PermissionRequest, type RuntimeService } from "@opencode-workbench/shared"

export type SessionGroup = "Needs input" | "Working" | "Completed" | "Today" | "Yesterday" | "Previous 7 days" | "Older"

export function sessionLoadPhase(session?: { loaded: boolean; loadState: "idle" | "loading" | "ready" | "error" }): "none" | "initial" | "refreshing" | "ready" | "error" {
  if (!session) return "none"
  if (session.loadState === "error") return "error"
  if (!session.loaded) return "initial"
  return session.loadState === "loading" ? "refreshing" : "ready"
}

export function connectionPresentation(state: ConnectionState, error?: string): { showNotice: boolean; label: string; title: string; message: string } {
  if (state === "connecting" || state === "connected") return { showNotice: false, label: "", title: "", message: "" }
  if (state === "reconnecting") return {
    showNotice: true,
    label: "Reconnecting",
    title: "Reconnecting to OpenCode",
    message: error || "The OpenCode connection failed. Workbench is retrying automatically.",
  }
  return {
    showNotice: true,
    label: "Offline",
    title: "OpenCode is offline",
    message: error || "The OpenCode server is unavailable. Reload the window to restart the managed connection.",
  }
}

export function runtimeServicePresentation(service: RuntimeService, kind: "lsp" | "formatter" | "mcp"): { status: string; detail?: string; healthy: boolean; tone: "status" | "warning" | "error" | "muted" } {
  if (kind === "formatter") return {
    status: service.enabled ? "Available" : "Executable not found",
    detail: service.extensions?.join(" "),
    healthy: service.enabled === true,
    tone: service.enabled ? "status" : "error",
  }
  if (kind === "mcp") {
    const status = ({ connected: "Connected", disabled: "Disabled", failed: "Failed", needs_auth: "Authentication required", needs_client_registration: "Client registration required" } as Record<string, string>)[service.status ?? ""] ?? service.status ?? "Unknown"
    const tone = service.status === "connected" ? "status" : service.status === "disabled" ? "muted" : service.status === "failed" ? "error" : "warning"
    return { status, detail: service.root, healthy: service.status === "connected", tone }
  }
  const status = service.error || (({ connected: "Connected", error: "Error" } as Record<string, string>)[service.status ?? ""] ?? service.status ?? "Available")
  const healthy = service.status === "connected" && !service.error
  return { status, detail: service.root, healthy, tone: healthy ? "status" : "error" }
}

export function isCompactionMessage(message: MessageBundle): boolean {
  return message.info.role === "user" && message.parts.some((part) => part.type === "compaction")
}

export const isNativeCompactionContinuationMessage = sharedIsNativeCompactionContinuationMessage

export function isGoalContinuationMessage(message: MessageBundle): boolean {
  if (message.info.role !== "user") return false
  return message.parts.some((part) => {
    if (part.type !== "text" || part.synthetic !== true || typeof part.text !== "string") return false
    const metadata = part.metadata
    const marker = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)["opencode-workbench"]
      : undefined
    if (marker && typeof marker === "object" && !Array.isArray(marker) && (marker as Record<string, unknown>).kind === "goal-continuation") return true
    return part.text.startsWith("Continue working autonomously toward the active goal.")
  })
}

export function sessionGroup(session: ChatSnapshot["sessions"][number], now = Date.now()): SessionGroup {
  if ((session.attention ?? 0) > 0 || session.status.type === "error") return "Needs input"
  if (session.status.type === "busy" || session.status.type === "retry") return "Working"
  if (session.unread > 0) return "Completed"
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const updatedAt = session.updatedAt ?? 0
  if (updatedAt >= start.getTime()) return "Today"
  if (updatedAt >= start.getTime() - 24 * 60 * 60 * 1_000) return "Yesterday"
  if (updatedAt >= start.getTime() - 7 * 24 * 60 * 60 * 1_000) return "Previous 7 days"
  return "Older"
}

export function reasoningSummary(text: string): string {
  const line = text.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? ""
  return line.replace(/(?:\*\*|__|\*|_|~~|`)/g, "").replace(/^#+\s*/, "").trim()
}

export function reasoningDetail(text: string): string {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex((line) => line.trim())
  if (first < 0 || reasoningSummary(lines[first]!) !== reasoningSummary(text)) return text.trim()
  return lines.slice(first + 1).join("\n").trim()
}

export function delegationCompletionSummary(actions: Array<{ kind: "reasoning" | "tool" | "output" }>, failed = false): string {
  const toolCalls = actions.filter((action) => action.kind === "tool").length
  const activity = toolCalls
    ? `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`
    : actions.length ? `${actions.length} step${actions.length === 1 ? "" : "s"}` : ""
  return failed ? `Failed${activity ? ` · ${activity}` : ""}` : activity || "Completed"
}

export function mergeRevisionValues<T extends { id: string }>(remote: T[], base: T[], desired: T[]): T[] {
  const desiredIDs = new Set(desired.map((value) => value.id))
  const baseIDs = new Set(base.map((value) => value.id))
  const removed = new Set(base.filter((value) => !desiredIDs.has(value.id)).map((value) => value.id))
  const merged = remote.filter((value) => !removed.has(value.id))
  const mergedIDs = new Set(merged.map((value) => value.id))
  for (const value of desired) if (!baseIDs.has(value.id) && !mergedIDs.has(value.id)) {
    merged.push(value)
    mergedIDs.add(value.id)
  }
  return merged
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  return `${minutes}m ${seconds}s`
}

export function activityCollapsed(working: boolean, wasWorking: boolean, preferred?: boolean, existing?: boolean): boolean {
  if (working) return false
  if (wasWorking) return true
  return preferred ?? existing ?? true
}

export function activityWorking(active: boolean, lastAssistantID: string | undefined, turnAssistantIDs: string[]): boolean {
  return Boolean(active && lastAssistantID && turnAssistantIDs.includes(lastAssistantID))
}

export function activityVisualState(status: string | undefined, active: boolean): string {
  const value = (status || "pending").toLowerCase()
  if (["pending", "running", "in_progress", "in-progress", "active"].includes(value)) return active ? "running" : "stopped"
  return value
}

export function commandActivityLabel(status: string | undefined): string {
  const value = (status || "pending").toLowerCase()
  if (["pending", "running", "in_progress", "in-progress", "active"].includes(value)) return "Running Command"
  if (["error", "failed", "rejected"].includes(value)) return "Failed Command"
  if (value === "stopped") return "Stopped Command"
  return "Ran Command"
}

export function stripTerminalSequences(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
}

const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const

function escapeTerminalText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Safely renders common SGR terminal colors while discarding all other control sequences. */
export function terminalAnsiMarkup(value: string): string {
  const source = value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[(?![0-9;]*m)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B(?!\[)[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, "")
  let classes = new Set<string>()
  let result = ""
  let offset = 0
  const pattern = /\x1B\[([0-9;]*)m/g
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const text = source.slice(offset, match.index)
    if (text) result += classes.size ? `<span class="${[...classes].join(" ")}">${escapeTerminalText(text)}</span>` : escapeTerminalText(text)
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0))
    for (const code of codes) {
      if (code === 0) classes = new Set()
      else if (code === 1) classes.add("ansi-bold")
      else if (code === 2) classes.add("ansi-dim")
      else if (code === 3) classes.add("ansi-italic")
      else if (code === 4) classes.add("ansi-underline")
      else if (code === 22) { classes.delete("ansi-bold"); classes.delete("ansi-dim") }
      else if (code === 23) classes.delete("ansi-italic")
      else if (code === 24) classes.delete("ansi-underline")
      else if (code === 39) classes = new Set([...classes].filter((name) => !name.startsWith("ansi-fg-")))
      else if (code === 49) classes = new Set([...classes].filter((name) => !name.startsWith("ansi-bg-")))
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        classes = new Set([...classes].filter((name) => !name.startsWith("ansi-fg-")))
        classes.add(`ansi-fg-${code >= 90 ? "bright-" : ""}${ANSI_COLORS[code % 10]}`)
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        classes = new Set([...classes].filter((name) => !name.startsWith("ansi-bg-")))
        classes.add(`ansi-bg-${code >= 100 ? "bright-" : ""}${ANSI_COLORS[code % 10]}`)
      }
    }
    offset = pattern.lastIndex
  }
  const tail = source.slice(offset)
  if (tail) result += classes.size ? `<span class="${[...classes].join(" ")}">${escapeTerminalText(tail)}</span>` : escapeTerminalText(tail)
  return result
}

export function shouldSubmitComposerKey(event: { key: string; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing: boolean; keyCode?: number }, behavior: "send" | "newline" = "send"): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && (behavior === "send" || Boolean(event.ctrlKey || event.metaKey))
}

export function shouldCollapsePaste(text: string): boolean {
  const lineCount = (text.match(/\r?\n/g)?.length ?? 0) + 1
  return lineCount >= 8 || text.length >= 1_000
}

export function attachmentReference(kind: "Image" | "PDF", ordinal: number): string {
  return `[${kind} ${ordinal}]`
}

export function attachmentDisplay(filename: string): { label?: string; name: string } {
  const label = /^(\[(?:Image|PDF) \d+\]|\[Pasted text \d+ · ~\d+ lines\])\s*/.exec(filename)?.[1]
  return { label, name: (label ? filename.slice(label.length).trim() : filename) || "Attachment" }
}

export function pastedTextReference(ordinal: number, lineCount: number): string {
  return `[Pasted text ${ordinal} · ~${lineCount} lines]`
}

export function questionAnswerValues(checked: string[], custom: string, multiple: boolean): string[] {
  const value = custom.trim()
  if (!value) return checked
  return multiple ? [...checked, value] : [value]
}

export function currentTodoContent(todos: Array<{ content: string; status: string }>): string {
  const working = todos.find((todo) => ["in_progress", "in-progress", "active"].includes(todo.status.toLowerCase()))
  if (working) return working.content
  const unfinished = todos.find((todo) => !["completed", "cancelled", "canceled", "skipped"].includes(todo.status.toLowerCase()))
  if (unfinished) return unfinished.content
  return todos.length > 0 && todos.every((todo) => todo.status.toLowerCase() === "completed") ? "All todos complete" : "No active todos"
}

export function patchActivityLabel(status: string | undefined): string {
  const value = (status || "pending").toLowerCase()
  if (["pending", "running", "in_progress", "in-progress", "active"].includes(value)) return "Preparing patch"
  if (["error", "failed", "rejected"].includes(value)) return "Patch failed"
  if (value === "stopped") return "Patch stopped"
  return "Applied patch"
}

export interface FileReference {
  file: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
}

export function workspaceMentionReference(value: string): FileReference | undefined {
  const source = value.trim()
  if (!source || source.length > 8_192 || /[<>\r\n]/.test(source)) return undefined
  const range = /#([1-9]\d*)(?:-([1-9]\d*))?$/.exec(source)
  const file = range ? source.slice(0, range.index) : source
  if (!file) return undefined
  const line = range ? Number(range[1]) : undefined
  const endLine = range?.[2] ? Number(range[2]) : undefined
  if ((line !== undefined && !Number.isSafeInteger(line)) || (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line!))) return undefined
  return { file, line, endLine }
}

export function fileUriFromPath(value: string): string {
  const normalized = value.replaceAll("\\", "/")
  const encoded = encodeURI(normalized).replaceAll("#", "%23").replaceAll("?", "%3F")
  return `file://${normalized.startsWith("/") ? "" : "/"}${encoded}`
}

export function fileReference(value: string): FileReference | undefined {
  const source = value.trim()
  const pathPattern = "((?!https?://).+\\.[A-Za-z][A-Za-z0-9]{0,11})"
  const hash = new RegExp(`^${pathPattern}#L([1-9]\\d*)(?:C([1-9]\\d*))?(?:-L([1-9]\\d*)(?:C([1-9]\\d*))?)?$`).exec(source)
  const colon = hash ? undefined : new RegExp(`^${pathPattern}:([1-9]\\d*)(?::([1-9]\\d*))?(?:-([1-9]\\d*)(?::([1-9]\\d*))?)?$`).exec(source)
  const bare = hash || colon ? undefined : new RegExp(`^${pathPattern}$`).exec(source)
  const match = hash ?? colon ?? bare
  if (!match?.[1] || match[1].length > 8_192) return undefined
  const numbers = match.slice(2).map((entry) => entry ? Number(entry) : undefined)
  if (numbers.some((entry) => entry !== undefined && (!Number.isSafeInteger(entry) || entry < 1 || entry > 1_000_000_000))) return undefined
  const [line, column, endLine, endColumn] = numbers
  if (endLine !== undefined && line !== undefined && endLine < line) return undefined
  return { file: match[1], line, column, endLine, endColumn }
}

export function applyPatchFiles(patch: string): string[] {
  return Array.from(patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm), (match) => match[1]!.trim()).slice(0, 100)
}

export function applyPatchSection(patch: string, file: string): string {
  const lines = patch.split("\n")
  const normalized = file.replace(/\\/g, "/")
  const section: string[] = []
  let found = false
  let active = false
  for (const line of lines) {
    const marker = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/.exec(line)
    if (marker) {
      if (active) break
      const candidate = marker[1]!.trim().replace(/\\/g, "/")
      active = candidate === normalized || candidate.endsWith(`/${normalized}`) || normalized.endsWith(`/${candidate}`)
      found ||= active
      continue
    }
    if (active && line === "*** End Patch") break
    if (active && line !== "*** Begin Patch") section.push(line)
  }
  return found ? section.join("\n").replace(/^\n|\n$/g, "") : patch
}

export interface PermissionPresentation {
  icon: string
  title: string
  lines: string[]
  diff?: string
  file?: string
}

function permissionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function permissionText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function permissionPatterns(request: PermissionRequest): string[] {
  return typeof request.pattern === "string" ? [request.pattern] : request.pattern ?? []
}

export function permissionPresentation(request: PermissionRequest): PermissionPresentation {
  const metadata = permissionRecord(request.metadata)
  const input = { ...metadata, ...permissionRecord(metadata.input) }
  const patterns = permissionPatterns(request)
  const type = (request.type || "").toLowerCase()
  const path = (...keys: string[]) => keys.map((key) => permissionText(input[key])).find(Boolean) || patterns[0] || ""

  if (["edit", "write", "apply_patch"].includes(type)) {
    const file = path("filePath", "filepath", "path")
    const action = type === "write" ? "Write" : type === "apply_patch" ? "Patch" : "Edit"
    return {
      icon: "→",
      title: file ? `${action} ${file}` : `${action} file`,
      lines: [],
      diff: permissionText(input.diff) || undefined,
      file: file || undefined,
    }
  }
  if (type === "read") {
    const file = path("filePath", "filepath", "path")
    return { icon: "→", title: file ? `Read ${file}` : "Read file", lines: file ? [`Path: ${file}`] : [] }
  }
  if (type === "glob" || type === "grep") {
    const pattern = permissionText(input.pattern) || patterns[0] || ""
    const root = permissionText(input.path)
    const label = type === "glob" ? "Glob" : "Grep"
    return {
      icon: "✱",
      title: pattern ? `${label} "${pattern}"` : label,
      lines: [...(pattern ? [`Pattern: ${pattern}`] : []), ...(root ? [`Path: ${root}`] : [])],
    }
  }
  if (type === "list") {
    const directory = path("path")
    return { icon: "→", title: directory ? `List ${directory}` : "List directory", lines: directory ? [`Path: ${directory}`] : [] }
  }
  if (type === "bash" || type === "shell") {
    const command = permissionText(input.command)
    return { icon: "#", title: "Shell command", lines: command ? [`$ ${command}`] : patterns.map((item) => `- ${item}`) }
  }
  if (type === "task") {
    const agent = permissionText(input.subagent_type) || patterns[0] || "general"
    const description = permissionText(input.description)
    return { icon: "#", title: `${agent.charAt(0).toUpperCase()}${agent.slice(1)} task`, lines: description ? [`◉ ${description}`] : [] }
  }
  if (type === "webfetch") {
    const url = permissionText(input.url) || patterns[0] || ""
    return { icon: "%", title: url ? `WebFetch ${url}` : "WebFetch", lines: url ? [`URL: ${url}`] : [] }
  }
  if (type === "websearch") {
    const query = permissionText(input.query) || patterns[0] || ""
    return { icon: "◈", title: query ? `Web search "${query}"` : "Web search", lines: query ? [`Query: ${query}`] : [] }
  }
  if (type === "lsp") {
    const operation = permissionText(input.operation) || "request"
    const file = permissionText(input.filePath)
    const line = typeof input.line === "number" && Number.isFinite(input.line) ? input.line : undefined
    const character = typeof input.character === "number" && Number.isFinite(input.character) ? input.character : undefined
    return {
      icon: "→",
      title: `LSP ${operation}${file ? ` ${file}${line !== undefined && character !== undefined ? `:${line}:${character}` : ""}` : ""}`,
      lines: [...(file ? [`Path: ${file}`] : []), ...(line !== undefined && character !== undefined ? [`Position: ${line}:${character}`] : [])],
    }
  }
  if (type === "external_directory") {
    const raw = path("parentDir", "filepath", "path")
    const directory = raw.includes("*") ? raw.slice(0, raw.indexOf("*")).replace(/[\\/]+$/, "") : raw
    return { icon: "←", title: directory ? `Access external directory ${directory}` : "Access external directory", lines: patterns.map((item) => `- ${item}`) }
  }
  if (type === "doom_loop") return { icon: "⟳", title: "Continue after repeated failures", lines: ["This keeps the session running despite repeated failures."] }

  return {
    icon: "⚙",
    title: type ? `Call tool ${request.type}` : request.title || "Permission request",
    lines: patterns.map((item) => `- ${item}`),
  }
}

export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context"

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add"
  if (line.startsWith("-") && !line.startsWith("---")) return "remove"
  if (line.startsWith("@@")) return "hunk"
  if (line.startsWith("*** ") || line.startsWith("+++") || line.startsWith("---")) return "meta"
  return "context"
}

export type ToolKind = "skill" | "explore" | "bash" | "edit" | "todo" | "task" | "patch" | "unknown"

export function toolKind(part: MessagePart): ToolKind {
  const name = (part.tool ?? "").toLowerCase()
  if (name === "skill" || name.endsWith(".skill") || name.includes("load_skill")) return "skill"
  if (["read", "glob", "grep"].includes(name)) return "explore"
  if (["bash", "shell", "terminal"].includes(name)) return "bash"
  if (["apply_patch", "edit", "write"].includes(name)) return "edit"
  if (["todowrite", "todo_write"].includes(name)) return "todo"
  if (name === "task" || name.endsWith("_task")) return "task"
  if (name.includes("patch")) return "patch"
  return "unknown"
}

export function turnContent(messages: MessageBundle[]): { hasActivity: boolean; finalTextPartKeys: string[] } {
  let position = 0
  let lastProcessPosition = -1
  const textPositions: Array<{ key: string; position: number }> = []
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.synthetic || part.type === "step-start" || part.type === "step-finish") continue
      if (part.type === "reasoning" || part.type === "tool" || ["patch", "apply_patch", "edit", "write", "todowrite", "task", "bash"].includes(part.type)) lastProcessPosition = position
      if (part.type === "text" && part.text) textPositions.push({ key: `${message.info.id}:${part.id}`, position })
      position += 1
    }
  }
  return {
    hasActivity: lastProcessPosition >= 0,
    finalTextPartKeys: textPositions.filter((entry) => entry.position > lastProcessPosition).map((entry) => entry.key),
  }
}
