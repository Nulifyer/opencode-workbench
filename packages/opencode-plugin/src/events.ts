import type { Evidence, Scope } from "./model.ts"
import { safeSubject } from "./security.ts"

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256 ? value : undefined
}

export function evidenceFromEvent(
  value: unknown,
  scope: Scope,
  now: number,
  id: string,
): Evidence | undefined {
  const event = record(value)
  if (!event || typeof event.type !== "string") return undefined
  const properties = record(event.properties)
  if (!properties) return undefined
  if (event.type === "message.part.updated") {
    const part = record(properties.part)
    const state = record(part?.state)
    if (part?.type !== "tool" || !state) return undefined
    const sessionID = string(part.sessionID)
    const messageID = string(part.messageID)
    const callID = string(part.callID)
    const tool = safeSubject(part.tool, "unknown_tool")
    if (state.status === "error") {
      return { id, scope, kind: "tool_failure", subject: tool, sessionID, messageID, callID, createdAt: now }
    }
    if (state.status === "completed" && tool === "skill") {
      const metadata = record(state.metadata)
      const input = record(state.input)
      const name = safeSubject(metadata?.name ?? input?.name, "unknown_skill")
      return { id, scope, kind: "skill_load", subject: name, sessionID, messageID, callID, createdAt: now }
    }
  }
  if (event.type === "session.error") {
    const error = record(properties.error)
    return {
      id,
      scope,
      kind: "session_error",
      subject: safeSubject(error?.name, "unknown_error"),
      sessionID: string(properties.sessionID),
      createdAt: now,
    }
  }
  if (event.type === "session.status") {
    const status = record(properties.status)
    return {
      id,
      scope,
      kind: "session_status",
      subject: safeSubject(status?.type, "unknown_status"),
      sessionID: string(properties.sessionID),
      createdAt: now,
    }
  }
  return undefined
}
