import type { GoalVerdict, GoalVerifierConfiguration } from "./workbench-domain.ts"

const OPEN_CODE_ID_RANDOM_LENGTH = 14
const OPEN_CODE_ID_RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastMessageIDTimestamp = 0
let messageIDCounter = 0

export function isOpenCodeMessageID(value: unknown): value is string {
  return typeof value === "string" && /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value)
}

export function createOpenCodeMessageID(timestamp = Date.now()): string {
  let currentTimestamp = Math.max(Math.trunc(timestamp), lastMessageIDTimestamp)
  if (currentTimestamp !== lastMessageIDTimestamp) {
    lastMessageIDTimestamp = currentTimestamp
    messageIDCounter = 0
  } else if (messageIDCounter >= 0xfff) {
    currentTimestamp += 1
    lastMessageIDTimestamp = currentTimestamp
    messageIDCounter = 0
  }
  messageIDCounter += 1
  const encoded = (BigInt(currentTimestamp) * 0x1000n + BigInt(messageIDCounter)) & 0xffffffffffffn
  const bytes = crypto.getRandomValues(new Uint8Array(OPEN_CODE_ID_RANDOM_LENGTH))
  const random = Array.from(bytes, (byte) => OPEN_CODE_ID_RANDOM_CHARS[byte % OPEN_CODE_ID_RANDOM_CHARS.length]).join("")
  return `msg_${encoded.toString(16).padStart(12, "0")}${random}`
}

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string; next?: number }
  | { type: "error"; message?: string }

export interface SessionInfo {
  id: string
  slug?: string
  title: string
  directory: string
  parentID?: string
  time: { created: number; updated: number; archived?: number }
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  summary?: { additions: number; deletions: number; files: number }
  share?: { url: string }
  revert?: { messageID: string; partID?: string }
  [key: string]: unknown
}

export interface MessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time?: { created?: number; completed?: number }
  error?: unknown
  [key: string]: unknown
}

export interface MessagePart {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  synthetic?: boolean
  tool?: string
  state?: {
    status?: string
    title?: string
    output?: string
    error?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface MessageBundle {
  info: MessageInfo
  parts: MessagePart[]
}

export interface AgentOption {
  name: string
  description?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  mode?: "primary" | "subagent" | "all"
}

export interface ProviderOption {
  id: string
  name: string
  source?: "env" | "config" | "custom" | "api"
}

export interface ModelCapabilities {
  temperature?: boolean
  reasoning?: boolean
  attachment?: boolean
  toolcall?: boolean
  input?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean }
  output?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean }
  interleaved?: boolean | { field?: string }
}

export interface ModelOption {
  id: string
  name: string
  providerID: string
  contextLimit?: number
  inputLimit?: number
  outputLimit?: number
  status?: string
  releaseDate?: string
  capabilities?: ModelCapabilities
  variants?: string[]
}

export interface ResourceOption {
  name: string
  uri: string
  description?: string
  mimeType?: string
  client: string
}

export interface CommandOption {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
  hints?: string[]
}

export interface QueuedPrompt {
  id: string
  text: string
  delivery?: "follow-up" | "steer" | "replace"
  agent?: string
  model?: string
  variant?: string
  attachments?: Array<{ name: string; mime: string }>
  createdAt: number
}

export const PROMPT_TEXT_CHARACTER_LIMIT = 200_000
export const PROMPT_ATTACHMENT_COUNT_LIMIT = 20
export const PROMPT_ATTACHMENT_CHARACTER_LIMIT = 20_000_000
export const PROMPT_QUEUE_COUNT_LIMIT = 100
export const PROMPT_QUEUE_CHARACTER_LIMIT = 2_000_000

export interface InlineAttachment {
  id: string
  label: string
  name: string
  mime: "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp" | "application/pdf"
  data: string
  size: number
  width?: number
  height?: number
}

export interface PastedTextBlock {
  id: string
  label: string
  text: string
  lineCount: number
}

export interface ContextAttachmentSummary {
  id: string
  name: string
  detail?: string
  kind: "file" | "folder" | "selection" | "buffer" | "resource" | "notebook"
}

export interface EditorContextSummary {
  name: string
  detail?: string
  dirty?: boolean
  attached?: boolean
}

export interface TodoItem {
  id?: string
  content: string
  status: string
  priority?: string
}

export interface FileChange {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  protocol: "legacy" | "v2"
}

export interface DelegationProgress {
  partID: string
  sessionID: string
  title: string
  status: SessionStatus
  messages: MessageBundle[]
  revision: number
}

export const PERMISSION_AGGREGATE_CHARACTER_LIMIT = 1_000_000

export const PERMISSION_METADATA_CHARACTER_LIMIT = 100_000

export interface PermissionRequest {
  id: string
  sessionID: string
  title: string
  type?: string
  pattern?: string | string[]
  metadata?: Record<string, unknown>
  always?: string[]
  protocol: "legacy" | "current" | "v2"
  truncated?: boolean
}

const SHELL_PERMISSION_TYPES = new Set(["bash", "shell"])
const SHELL_SCOPE_CONTROL_CHARACTERS = /[\r\n;&|`$()<>\\]/

export function permissionPatternMatches(input: string, pattern: string): boolean {
  if (pattern === "*") return true
  if (input === pattern) return true
  if (!pattern.endsWith(" *") || pattern.slice(0, -2).includes("*")) return false
  const prefix = pattern.slice(0, -2)
  if (!prefix || prefix.trim() !== prefix || SHELL_SCOPE_CONTROL_CHARACTERS.test(input)) return false
  return input === prefix || input.startsWith(`${prefix} `)
}

export function reusablePermissionScopes(request: PermissionRequest): string[] {
  if (!SHELL_PERMISSION_TYPES.has(request.type ?? "") || request.truncated) return []
  const patterns = typeof request.pattern === "string" ? [request.pattern] : request.pattern ?? []
  if (!patterns.length) return []
  const candidates = new Set<string>()
  for (const suggested of request.always ?? []) candidates.add(suggested)
  for (const pattern of patterns) {
    if (SHELL_SCOPE_CONTROL_CHARACTERS.test(pattern)) continue
    const parts = pattern.trim().split(/\s+/)
    if (!parts[0] || !/^[\w./:@+-]+$/.test(parts[0])) continue
    const subcommand = parts.findIndex((part, index) => index > 0 && !part.startsWith("-"))
    if (subcommand > 0 && parts.slice(0, subcommand + 1).every((part) => /^[\w./:@+-]+$/.test(part))) {
      candidates.add(`${parts.slice(0, subcommand + 1).join(" ")} *`)
    }
    candidates.add(`${parts[0]} *`)
  }
  return [...candidates]
    .filter((candidate) => candidate.endsWith(" *") && !candidate.slice(0, -2).includes("*") && patterns.every((pattern) => permissionPatternMatches(pattern, candidate)))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .concat("*")
}

export function permissionRequestCharacters(request: PermissionRequest): number {
  let metadata = 0
  try {
    metadata = request.metadata === undefined ? 0 : JSON.stringify(request.metadata)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
  return request.id.length + request.sessionID.length + request.title.length + (request.type?.length ?? 0) +
    (typeof request.pattern === "string" ? request.pattern.length : request.pattern?.reduce((sum, item) => sum + item.length, 0) ?? 0) +
    (request.always?.reduce((sum, item) => sum + item.length, 0) ?? 0) + metadata
}

export interface RuntimeService {
  id: string
  name?: string
  status?: string
  root?: string
  error?: string
  extensions?: string[]
  enabled?: boolean
}

export interface RuntimeStatus {
  path?: {
    home?: string
    state?: string
    config?: string
    worktree?: string
    directory?: string
  }
  vcs?: { branch?: string }
  lsp: RuntimeService[]
  formatters: RuntimeService[]
  mcp: RuntimeService[]
  updatedAt: number
}

/** Read-only metadata reported by OpenCode's native PTY service. */
export interface OpenCodePty {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
  exitCode?: number
}

export interface ContextSummary {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  contextLimit?: number
  inputLimit?: number
  outputLimit?: number
  model?: string
  usagePercent?: number
  cost: number
}

export interface GoalSummary {
  objective?: string
  status?: string
  sourceTool: string
  tokenBudget?: number
  tokensUsed?: number
  remainingTokens?: number
  timeUsedSeconds?: number
  maxDurationSeconds?: number
  autoTurns?: number
  maxAutoTurns?: number
  lastStatus?: string
  stopReason?: string
  checkpoint?: string
  completionEvidence?: string
  blocker?: string
  acceptanceCriteria?: string[]
  verifier?: GoalVerifierConfiguration
  latestVerdict?: GoalVerdict
  evidenceReferences?: string[]
  consecutiveBlockedVerdicts?: number
  pendingContinuation?: boolean
  settlementGeneration?: number
  planReference?: string
  runGroupReference?: string
}

export interface OpenCodeEvent {
  id?: string
  type: string
  properties: Record<string, unknown>
}
