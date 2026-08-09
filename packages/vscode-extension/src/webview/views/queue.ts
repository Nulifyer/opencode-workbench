import type { ChatSnapshot } from "@opencode-workbench/shared"

type Session = NonNullable<ChatSnapshot["session"]>
export function queueProjection(session: Session) {
  const queue = session.queue ?? []
  return {
    queue,
    running: queue.find((prompt) => prompt.id === session.inFlightPromptID),
    pending: queue.filter((prompt) => prompt.id !== session.inFlightPromptID),
    signature: JSON.stringify([session.id, queue, session.inFlightPromptID, session.status.type]),
  }
}

export function deliveryLabel(delivery?: "follow-up" | "steer" | "replace"): string { return delivery === "steer" ? "Steer current work" : delivery === "replace" ? "Replace queued instruction" : "Follow up after completion" }
