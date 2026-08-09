import type { ChatSnapshot } from "@opencode-workbench/shared"
import { isGoalContinuationMessage } from "../presentation.js"

type SessionSnapshot = NonNullable<ChatSnapshot["session"]>

export interface TurnNavigationMarker {
  id: string
  target: string
  label: string
  current?: boolean
}

export function turnNavigationMarkers(session: SessionSnapshot): TurnNavigationMarker[] {
  const markers: TurnNavigationMarker[] = []
  const firstMessage = session.messages[0]
  if (session.parentID && firstMessage) markers.push({
    id: `fork:${session.id}`,
    target: `message:${firstMessage.info.id}`,
    label: "Forked or delegated session boundary",
  })
  const userMessages = session.messages.filter((message) => message.info.role === "user")
  const currentUserID = userMessages.at(-1)?.info.id
  for (const message of session.messages) {
    if (message.info.role === "user") {
      const goal = isGoalContinuationMessage(message)
      const text = message.parts.find((part) => part.type === "text")?.text?.replace(/\s+/g, " ").trim()
      markers.push({
        id: `message:${message.info.id}`,
        target: `message:${message.info.id}`,
        label: goal ? "Goal continuation" : `User turn${text ? `: ${text.slice(0, 80)}` : ""}`,
        current: message.info.id === currentUserID,
      })
    }
    for (const part of message.parts) if (part.type === "tool" && part.tool === "update_goal_checkpoint" &&
      (part.state?.status === "complete" || part.state?.status === "completed")) markers.push({
      id: `checkpoint:${part.id}`,
      target: `message:${message.info.id}`,
      label: "Goal checkpoint recorded",
    })
    if (message.info.error !== undefined) markers.push({
      id: `failure:${message.info.id}`,
      target: `message:${message.info.id}`,
      label: "Failed turn",
    })
  }
  for (const permission of session.permissions ?? []) markers.push({
    id: `permission:${permission.id}`,
    target: `permission:${permission.id}`,
    label: `Permission: ${permission.title}`,
  })
  for (const question of session.questions ?? []) markers.push({
    id: `question:${question.id}`,
    target: `question:${question.id}`,
    label: `Question: ${question.questions[0]?.header ?? "OpenCode input"}`,
  })
  return markers
}
