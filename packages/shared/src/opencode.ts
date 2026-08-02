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
  time: { created: number; updated: number }
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  cost?: number
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
  name: string
  mime: "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp" | "application/pdf"
  data: string
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
}

export interface OpenCodeEvent {
  type: string
  properties: Record<string, unknown>
}
