import type { ChatSnapshot } from "@opencode-workbench/shared"
import { isCompactionMessage, isGoalContinuationMessage, turnContent } from "../presentation.js"
import { conversationTurnGroups, type ConversationTurnGroup } from "./conversation.js"

type SessionSnapshot = NonNullable<ChatSnapshot["session"]>

export interface TurnNavigationMarker {
  id: string
  target: string
  label: string
  current?: boolean
}

export const MAX_TURN_NAVIGATION_MARKERS = 80

export interface TurnNavigationScrollGeometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  edgeInset: number
  activeTop: number
  activeBottom: number
}

/** Keeps the complete active marker range inside the rail's unfaded viewport whenever it fits. */
export function turnNavigationScrollTop(geometry: TurnNavigationScrollGeometry): number {
  const maximum = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
  const current = Math.max(0, Math.min(maximum, geometry.scrollTop))
  const inset = Math.max(0, Math.min(geometry.edgeInset, geometry.clientHeight / 2))
  const visibleTop = current + inset
  const visibleBottom = current + geometry.clientHeight - inset
  if (geometry.activeTop >= visibleTop && geometry.activeBottom <= visibleBottom) return current
  const activeHeight = Math.max(0, geometry.activeBottom - geometry.activeTop)
  const availableHeight = Math.max(0, geometry.clientHeight - inset * 2)
  let next: number
  if (activeHeight > availableHeight && geometry.activeTop < visibleTop && geometry.activeBottom > visibleBottom) {
    const topMovement = visibleTop - geometry.activeTop
    const bottomMovement = geometry.activeBottom - visibleBottom
    next = topMovement <= bottomMovement ? geometry.activeTop - inset : geometry.activeBottom - geometry.clientHeight + inset
  } else if (geometry.activeTop < visibleTop) next = geometry.activeTop - inset
  else next = geometry.activeBottom - geometry.clientHeight + inset
  return Math.max(0, Math.min(maximum, next))
}

function conciseText(message: SessionSnapshot["messages"][number], types: readonly string[]): string | undefined {
  const text = message.parts.find((part) => !part.synthetic && types.includes(part.type) && part.text?.trim())?.text
  return text?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined
}

function assistantTurnAnchor(turn: ConversationTurnGroup): SessionSnapshot["messages"][number] | undefined {
  const messages = turn.entries.map((entry) => entry.message)
  const finalTextParts = new Set(turnContent(messages).finalTextPartKeys)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.info.role !== "assistant") continue
    if (message.parts.some((part) => finalTextParts.has(`${message.info.id}:${part.id}`))) return message
  }
  return undefined
}

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
  const turns = conversationTurnGroups(session)
  const firstMessage = session.messages[0]
  if (session.parentID && firstMessage) markers.push({
    id: `fork:${session.id}`,
    target: `message:${firstMessage.info.id}`,
    label: "Forked or delegated session boundary",
  })
  let currentTurnMarker: TurnNavigationMarker | undefined
  for (const turn of turns) {
    const user = turn.entries.find((entry) => entry.message.info.role === "user")?.message
    if (user && isCompactionMessage(user)) continue
    const automatic = user ? isGoalContinuationMessage(user) : true
    const anchor = automatic ? assistantTurnAnchor(turn) : user
    if (anchor) {
      const summary = automatic ? conciseText(anchor, ["text", "reasoning"]) : conciseText(anchor, ["text"])
      currentTurnMarker = {
        id: `message:${anchor.info.id}`,
        target: `message:${anchor.info.id}`,
        label: `${automatic ? "Assistant work turn" : "User turn"}${summary ? `: ${summary}` : ""}`,
      }
      markers.push(currentTurnMarker)
    }
    for (const entry of turn.entries) if (entry.message.info.error !== undefined) markers.push({
      id: `failure:${entry.message.info.id}`,
      target: `message:${entry.message.info.id}`,
      label: "Failed turn",
    })
  }
  if (currentTurnMarker) currentTurnMarker.current = true
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
