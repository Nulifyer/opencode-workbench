import type { AgentOption, MessageBundle, ModelOption, SessionStatus } from "./opencode.ts"

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "setDraft"; sessionID: string; draft: string }
  | { type: "send"; sessionID: string; text: string; agent?: string; model?: string }
  | { type: "abort"; sessionID: string }
  | { type: "createSession"; draft?: string }
  | { type: "selectSession"; sessionID: string }
  | { type: "setPreference"; sessionID: string; agent?: string; model?: string }
  | { type: "openLink"; url: string }

export interface ChatSnapshot {
  connected: boolean
  sessions: Array<{
    id: string
    title: string
    status: SessionStatus
    unread: number
  }>
  session?: {
    id: string
    title: string
    draft: string
    status: SessionStatus
    messages: MessageBundle[]
    messageRevisions: Record<string, number>
    agent?: string
    model?: string
  }
  agents: AgentOption[]
  models: ModelOption[]
}

export type HostToWebviewMessage =
  | { type: "snapshot"; snapshot: ChatSnapshot }
  | { type: "error"; message: string }

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

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  switch (value.type) {
    case "abort":
      return boundedString(value.sessionID) && value.sessionID.length > 0
        ? { type: "abort", sessionID: value.sessionID }
        : undefined
    case "createSession":
      return boundedOptionalString(value.draft, 200_000) ? { type: "createSession", draft: value.draft } : undefined
    case "ready":
      return { type: "ready" }
    case "setDraft":
      return boundedString(value.sessionID) && value.sessionID.length > 0 && typeof value.draft === "string" && value.draft.length <= 200_000
        ? { type: "setDraft", sessionID: value.sessionID, draft: value.draft }
        : undefined
    case "send":
      return boundedString(value.sessionID) && value.sessionID.length > 0 && typeof value.text === "string" && value.text.trim().length > 0 && value.text.length <= 200_000 &&
          boundedOptionalString(value.agent) && boundedOptionalString(value.model)
        ? { type: "send", sessionID: value.sessionID, text: value.text, agent: value.agent, model: value.model }
        : undefined
    case "setPreference":
      return boundedString(value.sessionID) && value.sessionID.length > 0 && boundedOptionalString(value.agent) && boundedOptionalString(value.model)
        ? { type: "setPreference", sessionID: value.sessionID, agent: value.agent, model: value.model }
        : undefined
    case "selectSession":
      return typeof value.sessionID === "string" && value.sessionID.length > 0 && value.sessionID.length <= 1_024
        ? { type: "selectSession", sessionID: value.sessionID }
        : undefined
    case "openLink":
      return typeof value.url === "string" && value.url.length <= 8_192 ? { type: "openLink", url: value.url } : undefined
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
  return record(value) && boundedString(value.name) && boundedOptionalString(value.description, 20_000)
}

function validModel(value: unknown): boolean {
  return record(value) && boundedString(value.id) && boundedString(value.name, 2_000) && boundedString(value.providerID)
}

function validCatalog(value: unknown[], validator: (entry: unknown) => boolean): boolean {
  if (!value.every(validator)) return false
  return value.reduce<number>((characters, entry) => {
    const item = entry as { id?: string; name?: string; providerID?: string; description?: string }
    return characters + (item.id?.length ?? 0) + (item.name?.length ?? 0) +
      (item.providerID?.length ?? 0) + (item.description?.length ?? 0)
  }, 0) <= 2_000_000
}

function validSessionOption(value: unknown): boolean {
  return record(value) && boundedString(value.id) && boundedString(value.title, 2_000) &&
    validStatus(value.status) && Number.isInteger(value.unread) && Number(value.unread) >= 0
}

function validSessionOptions(value: unknown[]): boolean {
  if (value.length > 5_000 || !value.every(validSessionOption)) return false
  return value.reduce<number>((characters, session) => {
    const option = session as { id: string; title: string; status: { message?: string } }
    return characters + option.id.length + option.title.length + (option.status.message?.length ?? 0)
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
    (part.synthetic === undefined || typeof part.synthetic === "boolean") &&
    boundedOptionalString(part.tool, 1_024) &&
    (part.state === undefined || (record(part.state) &&
      boundedOptionalString(part.state.status, 100) &&
      boundedOptionalString(part.state.title, 2_000) &&
      boundedOptionalString(part.state.output, 500_000) &&
      boundedOptionalString(part.state.error, 500_000))),
  )
}

function validMessages(value: unknown[]): boolean {
  if (value.length > 5_000 || !value.every(validMessage)) return false
  let parts = 0
  let characters = 0
  for (const message of value) {
    const bundle = message as { parts: Array<{ text?: string; state?: { title?: string; output?: string; error?: string } }> }
    parts += bundle.parts.length
    for (const part of bundle.parts) {
      characters += (part.text?.length ?? 0) + (part.state?.title?.length ?? 0) +
        (part.state?.output?.length ?? 0) + (part.state?.error?.length ?? 0)
    }
    if (parts > 20_000 || characters > 4_000_000) return false
  }
  return true
}

function validMessageRevisions(value: unknown, messages: unknown[]): boolean {
  if (!record(value)) return false
  const entries = Object.entries(value)
  if (entries.length > messages.length) return false
  return entries.every(([messageID, revision]) => messageID.length <= 1_024 && Number.isInteger(revision) && Number(revision) >= 0)
}

export function parseHostMessage(value: unknown): HostToWebviewMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  if (value.type === "error") {
    return typeof value.message === "string" ? { type: "error", message: value.message } : undefined
  }
  if (value.type !== "snapshot" || !record(value.snapshot)) return undefined
  const snapshot = value.snapshot
  if (
    typeof snapshot.connected !== "boolean" ||
    !Array.isArray(snapshot.sessions) || !validSessionOptions(snapshot.sessions) ||
    !Array.isArray(snapshot.agents) || snapshot.agents.length > 500 || !validCatalog(snapshot.agents, validAgent) ||
    !Array.isArray(snapshot.models) || snapshot.models.length > 5_000 || !validCatalog(snapshot.models, validModel)
  ) return undefined
  if (snapshot.session !== undefined) {
    if (!record(snapshot.session)) return undefined
    const session = snapshot.session
    if (
      typeof session.id !== "string" ||
      typeof session.title !== "string" ||
      typeof session.draft !== "string" ||
      !validStatus(session.status) ||
      !Array.isArray(session.messages) || !validMessages(session.messages) ||
      !validMessageRevisions(session.messageRevisions, session.messages) ||
      !boundedOptionalString(session.agent) ||
      !boundedOptionalString(session.model)
    ) return undefined
  }
  return value as HostToWebviewMessage
}
