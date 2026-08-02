import type { ChatSnapshot, MessageBundle, MessagePart } from "@opencode-workbench/shared"

export type SessionGroup = "Needs input" | "Working" | "Completed" | "Today" | "Yesterday" | "Previous 7 days" | "Older"

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

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  return `${minutes}m ${seconds}s`
}

export function shouldSubmitComposerKey(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229
}

export function questionAnswerValues(checked: string[], custom: string, multiple: boolean): string[] {
  const value = custom.trim()
  if (!value) return checked
  return multiple ? [...checked, value] : [value]
}

export function markdownFenceLanguage(line: string): string | undefined {
  const match = /^[ \t]*```([^`]*)$/.exec(line)
  return match ? match[1]!.trim() : undefined
}

export function markdownFenceEnd(line: string): boolean {
  return /^[ \t]*```[ \t]*$/.test(line)
}

export function currentTodoContent(todos: Array<{ content: string; status: string }>): string {
  const working = todos.find((todo) => ["in_progress", "in-progress", "active"].includes(todo.status.toLowerCase()))
  if (working) return working.content
  return todos.find((todo) => !["completed", "cancelled", "canceled", "skipped"].includes(todo.status.toLowerCase()))?.content ?? "All todos complete"
}

export function patchActivityLabel(status: string | undefined): string {
  const value = (status || "pending").toLowerCase()
  if (["pending", "running"].includes(value)) return "Preparing patch"
  if (["error", "failed", "rejected"].includes(value)) return "Patch failed"
  return "Applied patch"
}

export interface FileReference {
  file: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
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
