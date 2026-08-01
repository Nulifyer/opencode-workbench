import type { AgentOption, MessageBundle, ModelOption, SessionStatus } from "./opencode.ts"

export type WebviewToHostMessage =
  | { type: "ready"; draft?: string }
  | { type: "setDraft"; draft: string }
  | { type: "send"; text: string; agent?: string; model?: string }
  | { type: "abort" }
  | { type: "createSession" }
  | { type: "setPreference"; agent?: string; model?: string }
  | { type: "openLink"; url: string }

export interface ChatSnapshot {
  connected: boolean
  session?: {
    id: string
    title: string
    draft: string
    status: SessionStatus
    messages: MessageBundle[]
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

function boundedOptionalString(value: unknown, limit = 1_024): value is string | undefined {
  return optionalString(value) && (value === undefined || value.length <= limit)
}

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  switch (value.type) {
    case "abort":
    case "createSession":
      return { type: value.type }
    case "ready":
      return boundedOptionalString(value.draft, 200_000) ? { type: "ready", draft: value.draft } : undefined
    case "setDraft":
      return typeof value.draft === "string" && value.draft.length <= 200_000
        ? { type: "setDraft", draft: value.draft }
        : undefined
    case "send":
      return typeof value.text === "string" && value.text.trim().length > 0 && value.text.length <= 200_000 &&
          boundedOptionalString(value.agent) && boundedOptionalString(value.model)
        ? { type: "send", text: value.text, agent: value.agent, model: value.model }
        : undefined
    case "setPreference":
      return boundedOptionalString(value.agent) && boundedOptionalString(value.model)
        ? { type: "setPreference", agent: value.agent, model: value.model }
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
  return record(value) && typeof value.name === "string" && boundedOptionalString(value.description, 20_000)
}

function validModel(value: unknown): boolean {
  return record(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.providerID === "string"
}

function validMessage(value: unknown): boolean {
  if (!record(value) || !record(value.info) || !Array.isArray(value.parts) || value.parts.length > 2_000) return false
  const info = value.info
  if (typeof info.id !== "string" || typeof info.sessionID !== "string" || (info.role !== "user" && info.role !== "assistant")) return false
  return value.parts.every((part) =>
    record(part) &&
    typeof part.id === "string" &&
    typeof part.sessionID === "string" &&
    typeof part.messageID === "string" &&
    typeof part.type === "string" &&
    boundedOptionalString(part.text, 500_000) &&
    (part.synthetic === undefined || typeof part.synthetic === "boolean") &&
    boundedOptionalString(part.tool) &&
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

export function parseHostMessage(value: unknown): HostToWebviewMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  if (value.type === "error") {
    return typeof value.message === "string" ? { type: "error", message: value.message } : undefined
  }
  if (value.type !== "snapshot" || !record(value.snapshot)) return undefined
  const snapshot = value.snapshot
  if (
    typeof snapshot.connected !== "boolean" ||
    !Array.isArray(snapshot.agents) || snapshot.agents.length > 500 || !snapshot.agents.every(validAgent) ||
    !Array.isArray(snapshot.models) || snapshot.models.length > 5_000 || !snapshot.models.every(validModel)
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
      !boundedOptionalString(session.agent) ||
      !boundedOptionalString(session.model)
    ) return undefined
  }
  return value as HostToWebviewMessage
}
