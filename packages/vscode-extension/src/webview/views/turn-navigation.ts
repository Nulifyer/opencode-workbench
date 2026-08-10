import type { ChatSnapshot } from "@opencode-workbench/shared"
import { isGoalContinuationMessage, isNativeCompactionContinuationMessage } from "../presentation.js"

type SessionSnapshot = NonNullable<ChatSnapshot["session"]>

export interface TurnNavigationMarker {
  id: string
  target: string
  label: string
  current?: boolean
}

export const MAX_TURN_NAVIGATION_MARKERS = 80

/** Keeps long transcripts navigable without allowing the marker rail to grow past the viewport. */
export function boundedTurnNavigationMarkers(markers: readonly TurnNavigationMarker[], limit = MAX_TURN_NAVIGATION_MARKERS): TurnNavigationMarker[] {
  const boundedLimit = Math.max(2, Math.floor(limit))
  if (markers.length <= boundedLimit) return [...markers]
  const current = markers.findIndex((marker) => marker.current)
  const priority = [0, markers.length - 1, current, ...markers.flatMap((marker, index) => !marker.id.startsWith("message:") ? [index] : [])].filter((index) => index >= 0)
  const chosen = new Set(priority.slice(0, boundedLimit))
  const remaining = boundedLimit - chosen.size
  if (remaining > 0) {
    const candidates = markers.map((_, index) => index).filter((index) => !chosen.has(index))
    for (let slot = 0; slot < remaining && candidates.length; slot += 1) {
      const candidateIndex = Math.min(candidates.length - 1, Math.floor(((slot + 0.5) * candidates.length) / remaining))
      chosen.add(candidates[candidateIndex]!)
    }
  }
  return [...chosen].sort((left, right) => left - right).map((index) => markers[index]!)
}

export function turnNavigationMarkers(session: SessionSnapshot): TurnNavigationMarker[] {
  const markers: TurnNavigationMarker[] = []
  const firstMessage = session.messages[0]
  if (session.parentID && firstMessage) markers.push({
    id: `fork:${session.id}`,
    target: `message:${firstMessage.info.id}`,
    label: "Forked or delegated session boundary",
  })
  const userMessages = session.messages.filter((message) => message.info.role === "user" && !isNativeCompactionContinuationMessage(message))
  const currentUserID = userMessages.at(-1)?.info.id
  for (const message of session.messages) {
    if (message.info.role === "user" && !isNativeCompactionContinuationMessage(message)) {
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
  return boundedTurnNavigationMarkers(markers)
}
