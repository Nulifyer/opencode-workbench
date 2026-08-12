import type { MessageBundle, SessionStatus } from "@opencode-workbench/shared"

export type SessionTurnOutcome =
  | { state: "active" }
  | { state: "completed" }
  | { state: "failed" }
  | { state: "missing" }

/**
 * Conservatively classifies a prompt turn from authoritative session existence,
 * sparse status, and persisted messages. OpenCode may omit idle sessions from
 * `/session/status`, so absence alone is never treated as either success or loss.
 */
export function sessionTurnOutcome(
  status: SessionStatus | undefined,
  exists: boolean,
  messages: readonly MessageBundle[],
): SessionTurnOutcome {
  if (!exists) return { state: "missing" }
  if (status?.type === "error") return { state: "failed" }
  if (status?.type === "busy" || status?.type === "retry") return { state: "active" }

  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info.role === "user") {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return { state: "active" }

  const assistant = messages.slice(lastUserIndex + 1).find((message) => message.info.role === "assistant")
  if (!assistant) return { state: "active" }
  if (assistant.info.error !== undefined && assistant.info.error !== null) return { state: "failed" }

  const completed = assistant.info.time?.completed !== undefined ||
    assistant.parts.some((part) =>
      part.type === "step-finish" || part.type === "tool" || (part.type === "text" && Boolean(part.text?.trim()))
    )
  return completed ? { state: "completed" } : { state: "active" }
}

export function assistantTurnFailed(messages: readonly MessageBundle[]): boolean {
  return messages.slice().reverse().some((message) =>
    message.info.role === "assistant" && message.info.error !== undefined && message.info.error !== null
  )
}
