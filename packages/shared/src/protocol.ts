import type {
  AgentOption,
  ContextSummary,
  ContextAttachmentSummary,
  CommandOption,
  DelegationProgress,
  FileChange,
  GoalSummary,
  EditorContextSummary,
  InlineAttachment,
  MessageBundle,
  ModelOption,
  PermissionRequest,
  ProviderOption,
  QueuedPrompt,
  QuestionRequest,
  RuntimeStatus,
  ResourceOption,
  SessionStatus,
  TodoItem,
} from "./opencode.ts"
import {
  PERMISSION_AGGREGATE_CHARACTER_LIMIT,
  PERMISSION_METADATA_CHARACTER_LIMIT,
  PROMPT_ATTACHMENT_CHARACTER_LIMIT,
  PROMPT_QUEUE_CHARACTER_LIMIT,
  PROMPT_QUEUE_COUNT_LIMIT,
  PROMPT_TEXT_CHARACTER_LIMIT,
  permissionRequestCharacters,
} from "./opencode.ts"

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "setDraft"; sessionID: string; draft: string }
  | { type: "send"; sessionID: string; text: string; agent?: string; model?: string; variant?: string; attachments?: InlineAttachment[]; contextIDs?: string[] }
  | { type: "abort"; sessionID: string }
  | { type: "createSession"; draft?: string }
  | { type: "selectSession"; sessionID: string }
  | { type: "setPreference"; sessionID: string; agent?: string; model?: string; variant?: string }
  | { type: "removeQueued"; sessionID: string; promptID: string }
  | { type: "reorderQueue"; sessionID: string; promptIDs: string[] }
  | { type: "sendQueuedNow"; sessionID: string; promptID: string }
  | { type: "respondPermission"; sessionID: string; requestID: string; protocol: "legacy" | "current" | "v2"; response: "once" | "always" | "reject"; feedback?: string }
  | { type: "respondQuestion"; sessionID: string; requestID: string; answers: string[][] }
  | { type: "rejectQuestion"; sessionID: string; requestID: string }
  | { type: "openFile"; sessionID: string; file: string; line?: number; column?: number; endLine?: number; endColumn?: number }
  | { type: "openPatch"; sessionID: string; file: string }
  | { type: "sessionAction"; sessionID: string; action: "rename" | "delete" | "fork" | "undo" | "redo" | "compact" | "share" | "unshare" | "export" | "copyLast" | "copyTranscript" }
  | { type: "setAutoApproval"; sessionID: string; enabled: boolean }
  | { type: "openInEditor" }
  | { type: "openInSidebar" }
  | { type: "navigateBack" }
  | { type: "refresh" }
  | { type: "openLink"; url: string }
  | { type: "copyText"; text: string }
  | { type: "pickFiles"; sessionID: string }
  | { type: "attachCurrentEditor"; sessionID: string }
  | { type: "resolveDroppedUris"; sessionID: string; uris: string[] }
  | { type: "searchFiles"; sessionID: string; requestID: number; query: string }
  | { type: "removeContextAttachment"; sessionID: string; attachmentID: string }
  | { type: "attachWorkspacePath"; sessionID: string; path: string }
  | { type: "attachResource"; sessionID: string; uri: string }
  | { type: "openPlan"; sessionID: string }
  | { type: "mcpAction"; sessionID: string; name: string; action: "connect" | "disconnect" | "authenticate" | "removeAuth" }

export interface ChatSnapshot {
  connected: boolean
  sessions: Array<{
    id: string
    title: string
    status: SessionStatus
    unread: number
    directory?: string
    parentID?: string
    updatedAt?: number
    attention?: number
    questionCount?: number
    permissionCount?: number
    queued?: number
    todo?: { completed: number; total: number }
    changeCount?: number
  }>
  session?: {
    id: string
    parentID?: string
    directory?: string
    title: string
    draft: string
    status: SessionStatus
    loadState: "idle" | "loading" | "ready" | "error"
    messages: MessageBundle[]
    messageRevisions: Record<string, number>
    agent?: string
    model?: string
    variant?: string
    queue?: QueuedPrompt[]
    inFlightPromptID?: string
    permissions?: PermissionRequest[]
    questions?: QuestionRequest[]
    todos?: TodoItem[]
    changes?: FileChange[]
    context?: ContextSummary
    goal?: GoalSummary
    delegations?: DelegationProgress[]
  }
  agents: AgentOption[]
  mentionAgents?: AgentOption[]
  providers?: ProviderOption[]
  models: ModelOption[]
  resources?: ResourceOption[]
  catalog?: { status: "ready" | "stale" | "error"; updatedAt?: number; error?: string }
  commands?: CommandOption[]
  autoApproval?: boolean
  runtime?: RuntimeStatus
}

export interface MessagePatch {
  sessionID: string
  messageID: string
  message?: MessageBundle
  revision: number
  active: boolean
  append: boolean
  afterMessageID?: string
}

export type HostToWebviewMessage =
  | { type: "snapshot"; snapshot: ChatSnapshot }
  | { type: "messagePatches"; patches: MessagePatch[] }
  | { type: "error"; message: string }
  | { type: "insertText"; sessionID: string; text: string }
  | { type: "fileSuggestions"; sessionID: string; requestID: number; files: string[] }
  | { type: "editorContextChanged"; context?: EditorContextSummary }
  | { type: "contextAttachmentsChanged"; sessionID: string; attachments: ContextAttachmentSummary[] }
  | { type: "draftChanged"; sessionID: string; draft: string; revision: number }
  | { type: "sessionRemoved"; sessionID: string }

type UnknownRecord = Record<string, unknown>

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function boundedString(value: unknown, limit = 1_024): value is string {
  return typeof value === "string" && value.length <= limit
}

function boundedOptionalString(value: unknown, limit = 1_024): value is string | undefined {
  return optionalString(value) && (value === undefined || value.length <= limit)
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function validID(value: unknown): value is string {
  return boundedString(value) && value.length > 0
}

const inlineMimes = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp", "application/pdf"])

function validInlineAttachments(value: unknown): value is InlineAttachment[] | undefined {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 10) return false
  let characters = 0
  return value.every((attachment) => {
    if (!record(attachment) || !exactKeys(attachment, ["name", "mime", "data"]) || !boundedString(attachment.name, 255) || !attachment.name ||
      typeof attachment.mime !== "string" || !inlineMimes.has(attachment.mime) || typeof attachment.data !== "string" ||
      attachment.data.length > (attachment.mime === "application/pdf" ? 14_000_000 : 5_242_880) || attachment.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)) return false
    characters += attachment.name.length + attachment.mime.length + attachment.data.length
    return characters <= PROMPT_ATTACHMENT_CHARACTER_LIMIT
  })
}

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  switch (value.type) {
    case "abort":
      return boundedString(value.sessionID) && value.sessionID.length > 0
        ? { type: "abort", sessionID: value.sessionID }
        : undefined
    case "createSession":
      return boundedOptionalString(value.draft, PROMPT_TEXT_CHARACTER_LIMIT) ? { type: "createSession", draft: value.draft } : undefined
    case "ready":
      return { type: "ready" }
    case "openInEditor":
      return exactKeys(value, ["type"]) ? { type: "openInEditor" } : undefined
    case "openInSidebar":
      return exactKeys(value, ["type"]) ? { type: "openInSidebar" } : undefined
    case "navigateBack":
      return exactKeys(value, ["type"]) ? { type: "navigateBack" } : undefined
    case "refresh":
      return exactKeys(value, ["type"]) ? { type: "refresh" } : undefined
    case "setDraft":
      return boundedString(value.sessionID) && value.sessionID.length > 0 && typeof value.draft === "string" && value.draft.length <= PROMPT_TEXT_CHARACTER_LIMIT
        ? { type: "setDraft", sessionID: value.sessionID, draft: value.draft }
        : undefined
    case "send":
      return exactKeys(value, ["type", "sessionID", "text", "agent", "model", "variant", "attachments", "contextIDs"]) && boundedString(value.sessionID) && value.sessionID.length > 0 &&
          typeof value.text === "string" && value.text.length <= PROMPT_TEXT_CHARACTER_LIMIT && (value.text.trim().length > 0 || (Array.isArray(value.attachments) && value.attachments.length > 0) || (Array.isArray(value.contextIDs) && value.contextIDs.length > 0)) &&
          boundedOptionalString(value.agent) && boundedOptionalString(value.model) && boundedOptionalString(value.variant) && validInlineAttachments(value.attachments) &&
          (value.contextIDs === undefined || (Array.isArray(value.contextIDs) && value.contextIDs.length <= 20 && value.contextIDs.every(validID) && new Set(value.contextIDs).size === value.contextIDs.length))
        ? { type: "send", sessionID: value.sessionID, text: value.text, agent: value.agent, model: value.model, variant: value.variant, attachments: value.attachments, contextIDs: value.contextIDs as string[] | undefined }
        : undefined
    case "pickFiles":
    case "attachCurrentEditor":
      return exactKeys(value, ["type", "sessionID"]) && validID(value.sessionID) ? { type: value.type, sessionID: value.sessionID } : undefined
    case "resolveDroppedUris":
      return exactKeys(value, ["type", "sessionID", "uris"]) && validID(value.sessionID) && Array.isArray(value.uris) && value.uris.length <= 10 && value.uris.every((uri) => boundedString(uri, 8_192))
        ? { type: "resolveDroppedUris", sessionID: value.sessionID, uris: value.uris }
        : undefined
    case "searchFiles":
      return exactKeys(value, ["type", "sessionID", "requestID", "query"]) && validID(value.sessionID) && Number.isSafeInteger(value.requestID) && Number(value.requestID) >= 0 &&
          boundedString(value.query, 100) && /^[A-Za-z0-9._~/-]*$/.test(value.query)
        ? { type: "searchFiles", sessionID: value.sessionID, requestID: Number(value.requestID), query: value.query }
        : undefined
    case "removeContextAttachment":
      return exactKeys(value, ["type", "sessionID", "attachmentID"]) && validID(value.sessionID) && validID(value.attachmentID)
        ? { type: "removeContextAttachment", sessionID: value.sessionID, attachmentID: value.attachmentID }
        : undefined
    case "attachWorkspacePath":
      return exactKeys(value, ["type", "sessionID", "path"]) && validID(value.sessionID) && boundedString(value.path, 8_192) && value.path.length > 0
        ? { type: "attachWorkspacePath", sessionID: value.sessionID, path: value.path }
        : undefined
    case "attachResource":
      return exactKeys(value, ["type", "sessionID", "uri"]) && validID(value.sessionID) && boundedString(value.uri, 8_192) && value.uri.length > 0
        ? { type: "attachResource", sessionID: value.sessionID, uri: value.uri }
        : undefined
    case "openPlan":
      return exactKeys(value, ["type", "sessionID"]) && validID(value.sessionID) ? { type: "openPlan", sessionID: value.sessionID } : undefined
    case "mcpAction":
      return exactKeys(value, ["type", "sessionID", "name", "action"]) && validID(value.sessionID) && boundedString(value.name, 1_024) && value.name.length > 0 &&
          ["connect", "disconnect", "authenticate", "removeAuth"].includes(String(value.action))
        ? value as unknown as WebviewToHostMessage
        : undefined
    case "setPreference":
      return boundedString(value.sessionID) && value.sessionID.length > 0 && boundedOptionalString(value.agent) && boundedOptionalString(value.model) && boundedOptionalString(value.variant)
        ? { type: "setPreference", sessionID: value.sessionID, agent: value.agent, model: value.model, variant: value.variant }
        : undefined
    case "removeQueued":
    case "sendQueuedNow":
      return exactKeys(value, ["type", "sessionID", "promptID"]) && validID(value.sessionID) && validID(value.promptID)
        ? { type: value.type, sessionID: value.sessionID, promptID: value.promptID }
        : undefined
    case "reorderQueue":
      return exactKeys(value, ["type", "sessionID", "promptIDs"]) && validID(value.sessionID) &&
          Array.isArray(value.promptIDs) && value.promptIDs.length <= 100 &&
          value.promptIDs.every(validID) && new Set(value.promptIDs).size === value.promptIDs.length
        ? { type: "reorderQueue", sessionID: value.sessionID, promptIDs: value.promptIDs }
        : undefined
    case "respondPermission":
      return exactKeys(value, ["type", "sessionID", "requestID", "protocol", "response", "feedback"]) && validID(value.sessionID) && validID(value.requestID) &&
          ["legacy", "current", "v2"].includes(String(value.protocol)) &&
          (value.response === "once" || value.response === "always" || value.response === "reject") && boundedOptionalString(value.feedback, 20_000) &&
          (value.feedback === undefined || value.response === "reject")
        ? { type: "respondPermission", sessionID: value.sessionID, requestID: value.requestID, protocol: value.protocol as "legacy" | "current" | "v2", response: value.response, feedback: value.feedback }
        : undefined
    case "respondQuestion":
      return exactKeys(value, ["type", "sessionID", "requestID", "answers"]) && validID(value.sessionID) && validID(value.requestID) &&
          Array.isArray(value.answers) && value.answers.length <= 20 && value.answers.every((answer) =>
            Array.isArray(answer) && answer.length <= 20 && answer.every((item) => boundedString(item, 20_000))
          )
        ? { type: "respondQuestion", sessionID: value.sessionID, requestID: value.requestID, answers: value.answers }
        : undefined
    case "rejectQuestion":
      return exactKeys(value, ["type", "sessionID", "requestID"]) && validID(value.sessionID) && validID(value.requestID)
        ? { type: "rejectQuestion", sessionID: value.sessionID, requestID: value.requestID }
        : undefined
    case "openFile":
      return exactKeys(value, ["type", "sessionID", "file", "line", "column", "endLine", "endColumn"]) && validID(value.sessionID) && boundedString(value.file, 8_192) && value.file.length > 0 &&
          (value.line === undefined || (Number.isSafeInteger(value.line) && Number(value.line) >= 1 && Number(value.line) <= 1_000_000_000)) &&
          (value.column === undefined || (Number.isSafeInteger(value.column) && Number(value.column) >= 1 && Number(value.column) <= 1_000_000_000)) &&
          (value.endLine === undefined || (Number.isSafeInteger(value.endLine) && Number(value.endLine) >= Number(value.line ?? 1) && Number(value.endLine) <= 1_000_000_000)) &&
          (value.endColumn === undefined || (value.endLine !== undefined && Number.isSafeInteger(value.endColumn) && Number(value.endColumn) >= 1 && Number(value.endColumn) <= 1_000_000_000))
        ? { type: "openFile", sessionID: value.sessionID, file: value.file, line: value.line as number | undefined, column: value.column as number | undefined, endLine: value.endLine as number | undefined, endColumn: value.endColumn as number | undefined }
        : undefined
    case "openPatch":
      return exactKeys(value, ["type", "sessionID", "file"]) && validID(value.sessionID) && boundedString(value.file, 8_192) && value.file.length > 0
        ? { type: "openPatch", sessionID: value.sessionID, file: value.file }
        : undefined
    case "sessionAction":
      return exactKeys(value, ["type", "sessionID", "action"]) && validID(value.sessionID) &&
          ["rename", "delete", "fork", "undo", "redo", "compact", "share", "unshare", "export", "copyLast", "copyTranscript"].includes(String(value.action))
        ? { type: "sessionAction", sessionID: value.sessionID, action: value.action as Extract<WebviewToHostMessage, { type: "sessionAction" }>["action"] }
        : undefined
    case "setAutoApproval":
      return exactKeys(value, ["type", "sessionID", "enabled"]) && validID(value.sessionID) && typeof value.enabled === "boolean"
        ? { type: "setAutoApproval", sessionID: value.sessionID, enabled: value.enabled }
        : undefined
    case "selectSession":
      return typeof value.sessionID === "string" && value.sessionID.length > 0 && value.sessionID.length <= 1_024
        ? { type: "selectSession", sessionID: value.sessionID }
        : undefined
    case "openLink":
      return typeof value.url === "string" && value.url.length <= 8_192 ? { type: "openLink", url: value.url } : undefined
    case "copyText":
      return exactKeys(value, ["type", "text"]) && boundedString(value.text, 500_000) ? { type: "copyText", text: value.text } : undefined
    default:
      return undefined
  }
}

function validStatus(value: unknown): value is SessionStatus {
  if (!record(value) || !["idle", "busy", "retry", "error"].includes(String(value.type))) return false
  return boundedOptionalString(value.message, 20_000) &&
    (value.attempt === undefined || typeof value.attempt === "number") &&
    (value.next === undefined || typeof value.next === "number")
}

function validAgent(value: unknown): boolean {
  return record(value) && validID(value.name) && boundedOptionalString(value.description, 20_000) &&
    (value.model === undefined || (record(value.model) && exactKeys(value.model, ["providerID", "modelID"]) &&
      validID(value.model.providerID) && validID(value.model.modelID))) && boundedOptionalString(value.variant) &&
    (value.mode === undefined || ["primary", "subagent", "all"].includes(String(value.mode)))
}

function validModalities(value: unknown): boolean {
  return record(value) && exactKeys(value, ["text", "audio", "image", "video", "pdf"]) &&
    [value.text, value.audio, value.image, value.video, value.pdf].every((item) => item === undefined || typeof item === "boolean")
}

function validCapabilities(value: unknown): boolean {
  return record(value) && exactKeys(value, ["temperature", "reasoning", "attachment", "toolcall", "input", "output", "interleaved"]) &&
    [value.temperature, value.reasoning, value.attachment, value.toolcall].every((item) => item === undefined || typeof item === "boolean") &&
    (value.input === undefined || validModalities(value.input)) && (value.output === undefined || validModalities(value.output)) &&
    (value.interleaved === undefined || typeof value.interleaved === "boolean" ||
      (record(value.interleaved) && exactKeys(value.interleaved, ["field"]) && boundedOptionalString(value.interleaved.field, 100)))
}

function validModel(value: unknown): boolean {
  return record(value) && validID(value.id) && boundedString(value.name, 2_000) && validID(value.providerID) &&
    (value.contextLimit === undefined || (Number.isSafeInteger(value.contextLimit) && Number(value.contextLimit) > 0)) &&
    (value.inputLimit === undefined || (Number.isSafeInteger(value.inputLimit) && Number(value.inputLimit) > 0)) &&
    (value.outputLimit === undefined || (Number.isSafeInteger(value.outputLimit) && Number(value.outputLimit) > 0)) &&
    boundedOptionalString(value.status, 100) && boundedOptionalString(value.releaseDate, 100) &&
    (value.capabilities === undefined || validCapabilities(value.capabilities)) &&
    (value.variants === undefined || (Array.isArray(value.variants) && value.variants.length <= 100 && value.variants.every((variant) => validID(variant))))
}

function validProvider(value: unknown): boolean {
  return record(value) && exactKeys(value, ["id", "name", "source"]) && validID(value.id) && boundedString(value.name, 2_000) &&
    (value.source === undefined || ["env", "config", "custom", "api"].includes(String(value.source)))
}

function validResource(value: unknown): boolean {
  return record(value) && exactKeys(value, ["name", "uri", "description", "mimeType", "client"]) && boundedString(value.name, 2_000) && validID(value.uri) &&
    boundedOptionalString(value.description, 20_000) && boundedOptionalString(value.mimeType, 100) && boundedString(value.client, 2_000)
}

function validCommand(value: unknown): boolean {
  return record(value) && exactKeys(value, ["name", "description", "source", "hints"]) && validID(value.name) &&
    boundedOptionalString(value.description, 20_000) && (value.source === undefined || ["command", "mcp", "skill"].includes(String(value.source))) &&
    (value.hints === undefined || (Array.isArray(value.hints) && value.hints.length <= 100 && value.hints.every((hint) => boundedString(hint, 2_000))))
}

function validCatalog(value: unknown[], validator: (entry: unknown) => boolean): boolean {
  if (!value.every(validator)) return false
  return value.reduce<number>((characters, entry) => {
     const item = entry as { id?: string; name?: string; providerID?: string; description?: string; uri?: string; client?: string; status?: string; releaseDate?: string; variants?: string[] }
     return characters + (item.id?.length ?? 0) + (item.name?.length ?? 0) +
       (item.providerID?.length ?? 0) + (item.description?.length ?? 0) + (item.uri?.length ?? 0) + (item.client?.length ?? 0) +
       (item.status?.length ?? 0) + (item.releaseDate?.length ?? 0) + (item.variants?.reduce((total, variant) => total + variant.length, 0) ?? 0)
  }, 0) <= 2_000_000
}

function validSessionOption(value: unknown): boolean {
  return record(value) && boundedString(value.id) && boundedString(value.title, 2_000) &&
    validStatus(value.status) && Number.isSafeInteger(value.unread) && Number(value.unread) >= 0 && Number(value.unread) <= 1_000_000 &&
    boundedOptionalString(value.directory, 8_192) && boundedOptionalString(value.parentID) &&
    (value.updatedAt === undefined || (Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= 0)) &&
    [value.attention, value.questionCount, value.permissionCount, value.queued, value.changeCount].every((count) => count === undefined || (Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000_000)) &&
    (value.todo === undefined || (record(value.todo) && Number.isSafeInteger(value.todo.completed) && Number(value.todo.completed) >= 0 &&
      Number.isSafeInteger(value.todo.total) && Number(value.todo.total) >= Number(value.todo.completed) && Number(value.todo.total) <= 10_000))
}

function validSessionOptions(value: unknown[]): boolean {
  if (value.length > 5_000 || !value.every(validSessionOption)) return false
  return value.reduce<number>((characters, session) => {
    const option = session as { id: string; title: string; directory?: string; parentID?: string; status: { message?: string } }
    return characters + option.id.length + option.title.length + (option.directory?.length ?? 0) + (option.parentID?.length ?? 0) +
      (option.status.message?.length ?? 0)
  }, 0) <= 2_000_000
}

function validMessage(value: unknown): boolean {
  if (!record(value) || !record(value.info) || !Array.isArray(value.parts) || value.parts.length > 2_000) return false
  const info = value.info
  if (!boundedString(info.id) || !boundedString(info.sessionID) || (info.role !== "user" && info.role !== "assistant")) return false
  return value.parts.every((part) =>
    record(part) &&
    boundedString(part.id) &&
    boundedString(part.sessionID) &&
    boundedString(part.messageID) &&
    boundedString(part.type, 100) &&
    boundedOptionalString(part.text, 500_000) &&
    boundedOptionalString(part.mime, 100) &&
    boundedOptionalString(part.filename, 255) &&
    (part.synthetic === undefined || typeof part.synthetic === "boolean") &&
    boundedOptionalString(part.tool, 1_024) &&
    (part.state === undefined || (record(part.state) &&
      boundedOptionalString(part.state.status, 100) &&
      boundedOptionalString(part.state.title, 2_000) &&
      boundedOptionalString(part.state.output, 500_000) &&
      boundedOptionalString(part.state.error, 500_000) &&
      (part.state.input === undefined || validJson(part.state.input)) &&
      (part.state.metadata === undefined || validJson(part.state.metadata)))),
  )
}

function validMessages(value: unknown[]): boolean {
  if (value.length > 5_000 || !value.every(validMessage)) return false
  let parts = 0
  let characters = 0
  for (const message of value) {
    const bundle = message as { parts: Array<{ text?: string; mime?: string; filename?: string; state?: { title?: string; output?: string; error?: string; input?: unknown; metadata?: unknown } }> }
    parts += bundle.parts.length
    for (const part of bundle.parts) {
      characters += (part.text?.length ?? 0) + (part.state?.title?.length ?? 0) +
        (part.mime?.length ?? 0) + (part.filename?.length ?? 0) +
        (part.state?.output?.length ?? 0) + (part.state?.error?.length ?? 0) +
        (part.state?.input === undefined ? 0 : jsonCharacters(part.state.input)) +
        (part.state?.metadata === undefined ? 0 : jsonCharacters(part.state.metadata))
    }
    if (parts > 20_000 || characters > 4_000_000) return false
  }
  return true
}

function jsonCharacters(value: unknown, depth = 0): number {
  if (depth > 8 || value === null || typeof value === "boolean" || typeof value === "number") return 0
  if (typeof value === "string") return value.length
  if (Array.isArray(value)) return value.reduce((total, entry) => total + jsonCharacters(entry, depth + 1), 0)
  if (record(value)) return Object.entries(value).reduce((total, [key, entry]) => total + key.length + jsonCharacters(entry, depth + 1), 0)
  return 0
}

function validDelegations(value: unknown): value is DelegationProgress[] {
  if (!Array.isArray(value) || value.length > 20) return false
  let characters = 0
  let parts = 0
  return value.every((delegation) => {
    if (!record(delegation) || !exactKeys(delegation, ["partID", "sessionID", "title", "status", "messages", "revision"]) ||
      !validID(delegation.partID) || !validID(delegation.sessionID) || !boundedString(delegation.title, 2_000) ||
      !validStatus(delegation.status) || !Array.isArray(delegation.messages) || !validMessages(delegation.messages) ||
      !Number.isSafeInteger(delegation.revision) || Number(delegation.revision) < 0) return false
    for (const message of delegation.messages as MessageBundle[]) {
      parts += message.parts.length
      for (const part of message.parts) characters += (part.text?.length ?? 0) + (part.state?.title?.length ?? 0) +
        (part.state?.output?.length ?? 0) + (part.state?.error?.length ?? 0)
    }
    return parts <= 10_000 && characters <= 2_000_000
  })
}

function validMessageRevisions(value: unknown, messages: unknown[]): boolean {
  if (!record(value)) return false
  const entries = Object.entries(value)
  if (entries.length > messages.length) return false
  return entries.every(([messageID, revision]) => messageID.length <= 1_024 && Number.isInteger(revision) && Number(revision) >= 0)
}

function validJson(value: unknown, depth = 0, budget = { nodes: 0, characters: 0 }, characterLimit = PERMISSION_METADATA_CHARACTER_LIMIT): boolean {
  budget.nodes += 1
  if (budget.nodes > 1_000 || depth > 8) return false
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string") {
    budget.characters += value.length
    return budget.characters <= characterLimit
  }
  if (Array.isArray(value)) return value.length <= 100 && value.every((entry) => validJson(entry, depth + 1, budget, characterLimit))
  if (!record(value) || Object.keys(value).length > 100) return false
  return Object.entries(value).every(([key, entry]) => {
    budget.characters += key.length
    return key.length <= 1_024 && budget.characters <= characterLimit && validJson(entry, depth + 1, budget, characterLimit)
  })
}

function validQueue(value: unknown): value is QueuedPrompt[] {
  if (!Array.isArray(value) || value.length > PROMPT_QUEUE_COUNT_LIMIT) return false
  const ids = new Set<string>()
  let characters = 0
  return value.every((prompt) => {
    if (!record(prompt) || !exactKeys(prompt, ["id", "text", "agent", "model", "variant", "attachments", "createdAt"]) || !validID(prompt.id) || ids.has(prompt.id) ||
      !boundedString(prompt.text, PROMPT_TEXT_CHARACTER_LIMIT) || (!prompt.text.trim() && (!Array.isArray(prompt.attachments) || prompt.attachments.length === 0)) || !boundedOptionalString(prompt.agent) ||
      !boundedOptionalString(prompt.model) || !boundedOptionalString(prompt.variant) || !Number.isSafeInteger(prompt.createdAt) || Number(prompt.createdAt) < 0) return false
    if (prompt.attachments !== undefined && (!Array.isArray(prompt.attachments) || prompt.attachments.length > 20 || prompt.attachments.some((attachment) =>
      !record(attachment) || !exactKeys(attachment, ["name", "mime"]) || !boundedString(attachment.name, 255) || !boundedString(attachment.mime, 100)))) return false
    ids.add(prompt.id)
    characters += prompt.id.length + prompt.text.length + (prompt.agent?.length ?? 0) + (prompt.model?.length ?? 0) + (prompt.variant?.length ?? 0)
    return characters <= PROMPT_QUEUE_CHARACTER_LIMIT
  })
}

function validTodos(value: unknown): value is TodoItem[] {
  if (!Array.isArray(value) || value.length > 1_000) return false
  let characters = 0
  return value.every((todo) => {
    if (!record(todo) || !exactKeys(todo, ["id", "content", "status", "priority"]) || (todo.id !== undefined && !validID(todo.id)) ||
      !boundedString(todo.content, 20_000) || !boundedString(todo.status, 100) || !boundedOptionalString(todo.priority, 100)) return false
    characters += (todo.id?.length ?? 0) + todo.content.length + todo.status.length + (todo.priority?.length ?? 0)
    return characters <= 1_000_000
  })
}

function validChanges(value: unknown): value is FileChange[] {
  if (!Array.isArray(value) || value.length > 500) return false
  let characters = 0
  return value.every((change) => {
    if (!record(change) || !exactKeys(change, ["file", "patch", "additions", "deletions", "status"]) ||
      !boundedString(change.file, 8_192) || change.file.length === 0 || !boundedOptionalString(change.patch, 500_000) ||
      !Number.isSafeInteger(change.additions) || Number(change.additions) < 0 || !Number.isSafeInteger(change.deletions) || Number(change.deletions) < 0 ||
      (change.status !== undefined && !["added", "deleted", "modified"].includes(String(change.status)))) return false
    characters += change.file.length + (change.patch?.length ?? 0)
    return characters <= 4_000_000
  })
}

function validQuestions(value: unknown): value is QuestionRequest[] {
  if (!Array.isArray(value) || value.length > 100) return false
  let characters = 0
  return value.every((request) => {
    if (!record(request) || !exactKeys(request, ["id", "sessionID", "questions", "protocol"]) || !validID(request.id) ||
      !validID(request.sessionID) || !["legacy", "v2"].includes(String(request.protocol)) || !Array.isArray(request.questions) ||
      request.questions.length === 0 || request.questions.length > 20) return false
    return request.questions.every((question) => {
      if (!record(question) || !exactKeys(question, ["question", "header", "options", "multiple", "custom"]) ||
        !boundedString(question.question, 20_000) || !boundedString(question.header, 1_000) || !Array.isArray(question.options) ||
        question.options.length > 50 || (question.multiple !== undefined && typeof question.multiple !== "boolean") ||
        (question.custom !== undefined && typeof question.custom !== "boolean")) return false
      characters += question.question.length + question.header.length
      return characters <= 1_000_000 && question.options.every((option) => {
        if (!record(option) || !exactKeys(option, ["label", "description"]) || !boundedString(option.label, 2_000) ||
          !boundedString(option.description, 20_000)) return false
        characters += option.label.length + option.description.length
        return characters <= 1_000_000
      })
    })
  })
}

function validPermissions(value: unknown): value is PermissionRequest[] {
  if (!Array.isArray(value) || value.length > 100) return false
  let characters = 0
  return value.every((request) => {
    if (!record(request) || !exactKeys(request, ["id", "sessionID", "title", "type", "pattern", "metadata", "always", "protocol", "truncated"]) ||
      !validID(request.id) || !validID(request.sessionID) || !boundedString(request.title, 8_000) ||
      !boundedOptionalString(request.type) || !["legacy", "current", "v2"].includes(String(request.protocol)) ||
      (request.pattern !== undefined && !(boundedString(request.pattern, 20_000) ||
        (Array.isArray(request.pattern) && request.pattern.length <= 100 && request.pattern.every((item) => boundedString(item, 20_000))))) ||
      (request.always !== undefined && (!Array.isArray(request.always) || request.always.length > 100 || !request.always.every((item) => boundedString(item, 20_000)))) ||
      (request.metadata !== undefined && !validJson(request.metadata)) ||
      (request.truncated !== undefined && typeof request.truncated !== "boolean")) return false
    characters += permissionRequestCharacters(request as unknown as PermissionRequest)
    return characters <= PERMISSION_AGGREGATE_CHARACTER_LIMIT
  })
}

function validContext(value: unknown): value is ContextSummary {
  if (!record(value) || !exactKeys(value, ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "contextLimit", "inputLimit", "outputLimit", "model", "usagePercent", "cost"])) return false
  const counts = [value.inputTokens, value.outputTokens, value.reasoningTokens, value.cacheReadTokens, value.cacheWriteTokens, value.totalTokens]
  return counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000_000_000_000) &&
    Number(value.totalTokens) === counts.slice(0, 5).reduce<number>((total, count) => total + Number(count), 0) &&
    (value.contextLimit === undefined || (Number.isSafeInteger(value.contextLimit) && Number(value.contextLimit) > 0)) &&
    (value.inputLimit === undefined || (Number.isSafeInteger(value.inputLimit) && Number(value.inputLimit) > 0)) &&
    (value.outputLimit === undefined || (Number.isSafeInteger(value.outputLimit) && Number(value.outputLimit) > 0)) && boundedOptionalString(value.model, 2_049) &&
    (value.usagePercent === undefined || (typeof value.usagePercent === "number" && Number.isFinite(value.usagePercent) && value.usagePercent >= 0 && value.usagePercent <= 100)) &&
    typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 && value.cost <= 1_000_000_000_000
}

function validGoal(value: unknown): value is GoalSummary {
  if (!record(value) || !exactKeys(value, ["objective", "status", "sourceTool", "tokenBudget", "tokensUsed", "remainingTokens", "timeUsedSeconds", "maxDurationSeconds", "autoTurns", "maxAutoTurns", "lastStatus", "stopReason", "checkpoint", "completionEvidence", "blocker"]) ||
    !boundedOptionalString(value.objective, 20_000) || !boundedOptionalString(value.status, 100) || !boundedString(value.sourceTool, 100)) return false
  return [value.tokenBudget, value.tokensUsed, value.remainingTokens, value.timeUsedSeconds, value.maxDurationSeconds, value.autoTurns, value.maxAutoTurns]
      .every((metric) => metric === undefined || (Number.isSafeInteger(metric) && Number(metric) >= 0)) &&
    [value.lastStatus, value.stopReason, value.checkpoint, value.completionEvidence, value.blocker]
      .every((text) => boundedOptionalString(text, 20_000))
}

function validRuntimeService(value: unknown): boolean {
  return record(value) && exactKeys(value, ["id", "name", "status", "root", "error", "extensions", "enabled"]) && validID(value.id) &&
    boundedOptionalString(value.name, 2_000) && boundedOptionalString(value.status, 100) && boundedOptionalString(value.root, 8_192) &&
    boundedOptionalString(value.error, 20_000) && (value.extensions === undefined || (Array.isArray(value.extensions) && value.extensions.length <= 200 &&
      value.extensions.every((extension) => boundedString(extension, 100)))) && (value.enabled === undefined || typeof value.enabled === "boolean")
}

function validRuntime(value: unknown): value is RuntimeStatus {
  if (!record(value) || !exactKeys(value, ["path", "vcs", "lsp", "formatters", "mcp", "updatedAt"]) ||
    !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0) return false
  if (value.path !== undefined && (!record(value.path) || !exactKeys(value.path, ["home", "state", "config", "worktree", "directory"]) || ![value.path.home, value.path.state, value.path.config, value.path.worktree, value.path.directory]
    .every((entry) => boundedOptionalString(entry, 8_192)))) return false
  if (value.vcs !== undefined && (!record(value.vcs) || !exactKeys(value.vcs, ["branch"]) || !boundedOptionalString(value.vcs.branch, 2_000))) return false
  return [value.lsp, value.formatters, value.mcp].every((services) =>
    Array.isArray(services) && services.length <= 500 && services.every(validRuntimeService)
  )
}

export function parseHostMessage(value: unknown): HostToWebviewMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  if (value.type === "error") {
    return typeof value.message === "string" ? { type: "error", message: value.message } : undefined
  }
  if (value.type === "insertText") {
    return exactKeys(value, ["type", "sessionID", "text"]) && validID(value.sessionID) && boundedString(value.text, 100_000)
      ? { type: "insertText", sessionID: value.sessionID, text: value.text }
      : undefined
  }
  if (value.type === "fileSuggestions") {
    return exactKeys(value, ["type", "sessionID", "requestID", "files"]) && validID(value.sessionID) && Number.isSafeInteger(value.requestID) && Number(value.requestID) >= 0 &&
        Array.isArray(value.files) && value.files.length <= 20 && value.files.every((file) => boundedString(file, 8_192))
      ? { type: "fileSuggestions", sessionID: value.sessionID, requestID: Number(value.requestID), files: value.files }
      : undefined
  }
  if (value.type === "editorContextChanged") {
    if (!exactKeys(value, ["type", "context"])) return undefined
    if (value.context === undefined) return { type: "editorContextChanged" }
    return record(value.context) && exactKeys(value.context, ["name", "detail", "dirty"]) && boundedString(value.context.name, 255) &&
        boundedOptionalString(value.context.detail, 255) && (value.context.dirty === undefined || typeof value.context.dirty === "boolean")
      ? { type: "editorContextChanged", context: value.context as unknown as EditorContextSummary }
      : undefined
  }
  if (value.type === "contextAttachmentsChanged") {
    const valid = exactKeys(value, ["type", "sessionID", "attachments"]) && validID(value.sessionID) && Array.isArray(value.attachments) && value.attachments.length <= 20 &&
      value.attachments.every((attachment) => record(attachment) && exactKeys(attachment, ["id", "name", "detail", "kind"]) && validID(attachment.id) &&
        boundedString(attachment.name, 255) && boundedOptionalString(attachment.detail, 255) && ["file", "folder", "selection", "buffer", "resource", "notebook"].includes(String(attachment.kind)))
    return valid ? value as unknown as HostToWebviewMessage : undefined
  }
  if (value.type === "draftChanged") {
    return exactKeys(value, ["type", "sessionID", "draft", "revision"]) && validID(value.sessionID) && boundedString(value.draft, PROMPT_TEXT_CHARACTER_LIMIT) &&
        Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
      ? value as unknown as HostToWebviewMessage
      : undefined
  }
  if (value.type === "sessionRemoved") {
    return exactKeys(value, ["type", "sessionID"]) && validID(value.sessionID) ? { type: "sessionRemoved", sessionID: value.sessionID } : undefined
  }
  if (value.type === "messagePatches") {
    if (!exactKeys(value, ["type", "patches"]) || !Array.isArray(value.patches) || value.patches.length > 100) return undefined
    const valid = value.patches.every((patch) => record(patch) && exactKeys(patch, ["sessionID", "messageID", "message", "revision", "active", "append", "afterMessageID"]) &&
      validID(patch.sessionID) && validID(patch.messageID) && Number.isSafeInteger(patch.revision) && Number(patch.revision) >= 0 &&
      typeof patch.active === "boolean" && typeof patch.append === "boolean" && boundedOptionalString(patch.afterMessageID) && (patch.message === undefined || (validMessages([patch.message]) &&
        (patch.message as MessageBundle).info.id === patch.messageID && (patch.message as MessageBundle).info.sessionID === patch.sessionID &&
        (patch.message as MessageBundle).parts.every((part) => part.messageID === patch.messageID && part.sessionID === patch.sessionID))))
    const messages = value.patches.flatMap((patch) => record(patch) && patch.message !== undefined ? [patch.message] : [])
    if (valid && !validMessages(messages)) return undefined
    return valid ? value as HostToWebviewMessage : undefined
  }
  if (value.type !== "snapshot" || !record(value.snapshot)) return undefined
  const snapshot = value.snapshot
  if (
    typeof snapshot.connected !== "boolean" ||
    !Array.isArray(snapshot.sessions) || !validSessionOptions(snapshot.sessions) ||
    !Array.isArray(snapshot.agents) || snapshot.agents.length > 500 || !validCatalog(snapshot.agents, validAgent) ||
    (snapshot.mentionAgents !== undefined && (!Array.isArray(snapshot.mentionAgents) || snapshot.mentionAgents.length > 500 || !validCatalog(snapshot.mentionAgents, validAgent))) ||
    (snapshot.providers !== undefined && (!Array.isArray(snapshot.providers) || snapshot.providers.length > 500 || !validCatalog(snapshot.providers, validProvider))) ||
    !Array.isArray(snapshot.models) || snapshot.models.length > 5_000 || !validCatalog(snapshot.models, validModel) ||
    (snapshot.resources !== undefined && (!Array.isArray(snapshot.resources) || snapshot.resources.length > 2_000 || !validCatalog(snapshot.resources, validResource))) ||
    (snapshot.catalog !== undefined && (!record(snapshot.catalog) || !exactKeys(snapshot.catalog, ["status", "updatedAt", "error"]) ||
      !["ready", "stale", "error"].includes(String(snapshot.catalog.status)) ||
      (snapshot.catalog.updatedAt !== undefined && (!Number.isSafeInteger(snapshot.catalog.updatedAt) || Number(snapshot.catalog.updatedAt) < 0)) ||
      !boundedOptionalString(snapshot.catalog.error, 20_000))) ||
    (snapshot.commands !== undefined && (!Array.isArray(snapshot.commands) || snapshot.commands.length > 1_000 || !validCatalog(snapshot.commands, validCommand))) ||
    (snapshot.autoApproval !== undefined && typeof snapshot.autoApproval !== "boolean") ||
    (snapshot.runtime !== undefined && !validRuntime(snapshot.runtime))
  ) return undefined
  if (snapshot.session !== undefined) {
    if (!record(snapshot.session)) return undefined
    const session = snapshot.session
    if (
      !boundedString(session.id) ||
      !boundedOptionalString(session.parentID) ||
      !boundedOptionalString(session.directory, 8_192) ||
      !boundedString(session.title, 2_000) ||
      !boundedString(session.draft, PROMPT_TEXT_CHARACTER_LIMIT) ||
      !validStatus(session.status) ||
      !["idle", "loading", "ready", "error"].includes(String(session.loadState)) ||
      !Array.isArray(session.messages) || !validMessages(session.messages) ||
      !validMessageRevisions(session.messageRevisions, session.messages) ||
      !boundedOptionalString(session.agent) ||
      !boundedOptionalString(session.model) ||
      !boundedOptionalString(session.variant) ||
      (session.queue !== undefined && !validQueue(session.queue)) ||
      !boundedOptionalString(session.inFlightPromptID) ||
      (session.inFlightPromptID !== undefined && (!Array.isArray(session.queue) || !session.queue.some((prompt) => record(prompt) && prompt.id === session.inFlightPromptID))) ||
      (session.permissions !== undefined && !validPermissions(session.permissions)) ||
      (session.questions !== undefined && !validQuestions(session.questions)) ||
      (session.todos !== undefined && !validTodos(session.todos)) ||
      (session.changes !== undefined && !validChanges(session.changes)) ||
      (session.context !== undefined && !validContext(session.context)) ||
      (session.goal !== undefined && !validGoal(session.goal))
      || (session.delegations !== undefined && !validDelegations(session.delegations))
    ) return undefined
  }
  return value as HostToWebviewMessage
}
