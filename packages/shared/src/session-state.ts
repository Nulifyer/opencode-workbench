import type { MessageBundle, MessageInfo, MessagePart, OpenCodeEvent, SessionInfo, SessionStatus } from "./opencode.ts"

export interface SessionViewState {
  info: SessionInfo
  messages: MessageBundle[]
  loaded: boolean
  draft: string
  unread: number
  status: SessionStatus
  agent?: string
  model?: string
}

export interface WorkbenchState {
  sessions: Record<string, SessionViewState>
  order: string[]
  selectedID?: string
  connected: boolean
}

export type SessionAction =
  | { type: "connected"; connected: boolean }
  | { type: "reconcile"; sessions: SessionInfo[]; statuses?: Record<string, SessionStatus> }
  | { type: "select"; sessionID?: string }
  | { type: "draft"; sessionID: string; draft: string }
  | { type: "preference"; sessionID: string; agent?: string; model?: string }
  | { type: "transcript"; sessionID: string; messages: MessageBundle[] }
  | { type: "event"; event: OpenCodeEvent }

export const initialWorkbenchState: WorkbenchState = {
  sessions: {},
  order: [],
  connected: false,
}

function newSession(info: SessionInfo, status: SessionStatus = { type: "idle" }): SessionViewState {
  return { info, messages: [], loaded: false, draft: "", unread: 0, status }
}

function eventSessionID(event: OpenCodeEvent): string | undefined {
  const direct = event.properties.sessionID
  if (typeof direct === "string") return direct
  const info = event.properties.info
  if (info && typeof info === "object" && typeof (info as Record<string, unknown>).sessionID === "string") {
    return (info as Record<string, unknown>).sessionID as string
  }
  const part = event.properties.part
  if (part && typeof part === "object" && typeof (part as Record<string, unknown>).sessionID === "string") {
    return (part as Record<string, unknown>).sessionID as string
  }
  return undefined
}

function upsertMessage(messages: MessageBundle[], info: MessageInfo): MessageBundle[] {
  const index = messages.findIndex((message) => message.info.id === info.id)
  if (index < 0) return [...messages, { info, parts: [] }]
  const next = messages.slice()
  next[index] = { ...next[index]!, info }
  return next
}

function upsertPart(messages: MessageBundle[], part: MessagePart): MessageBundle[] {
  const messageIndex = messages.findIndex((message) => message.info.id === part.messageID)
  if (messageIndex < 0) return messages
  const next = messages.slice()
  const bundle = next[messageIndex]!
  const partIndex = bundle.parts.findIndex((candidate) => candidate.id === part.id)
  const parts = bundle.parts.slice()
  if (partIndex < 0) parts.push(part)
  else parts[partIndex] = part
  next[messageIndex] = { ...bundle, parts }
  return next
}

function removeMessage(messages: MessageBundle[], messageID: string): MessageBundle[] {
  return messages.filter((message) => message.info.id !== messageID)
}

function removePart(messages: MessageBundle[], messageID: string, partID: string): MessageBundle[] {
  return messages.map((message) =>
    message.info.id === messageID
      ? { ...message, parts: message.parts.filter((part) => part.id !== partID) }
      : message,
  )
}

export function sessionReducer(state: WorkbenchState, action: SessionAction): WorkbenchState {
  if (action.type === "connected") return { ...state, connected: action.connected }

  if (action.type === "reconcile") {
    const sessions: Record<string, SessionViewState> = {}
    for (const info of action.sessions) {
      const existing = state.sessions[info.id]
      sessions[info.id] = existing
        ? { ...existing, info, status: action.statuses?.[info.id] ?? { type: "idle" } }
        : newSession(info, action.statuses?.[info.id])
    }
    const order = action.sessions
      .slice()
      .sort((left, right) => right.time.updated - left.time.updated)
      .map((session) => session.id)
    const selectedID = state.selectedID && sessions[state.selectedID] ? state.selectedID : order[0]
    return { ...state, sessions, order, selectedID }
  }

  if (action.type === "select") {
    if (action.sessionID && !state.sessions[action.sessionID]) return state
    const sessions = { ...state.sessions }
    if (action.sessionID) sessions[action.sessionID] = { ...sessions[action.sessionID]!, unread: 0 }
    return { ...state, selectedID: action.sessionID, sessions }
  }

  if (action.type === "draft") {
    const current = state.sessions[action.sessionID]
    if (!current) return state
    return { ...state, sessions: { ...state.sessions, [action.sessionID]: { ...current, draft: action.draft } } }
  }
  if (action.type === "preference") {
    const current = state.sessions[action.sessionID]
    if (!current) return state
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [action.sessionID]: {
          ...current,
          agent: action.agent === undefined ? current.agent : action.agent || undefined,
          model: action.model === undefined ? current.model : action.model || undefined,
        },
      },
    }
  }
  if (action.type === "transcript") {
    const current = state.sessions[action.sessionID]
    if (!current) return state
    return {
      ...state,
      sessions: { ...state.sessions, [action.sessionID]: { ...current, messages: action.messages, loaded: true } },
    }
  }
  if (action.type !== "event") return state

  const event = action.event
  if (event.type === "session.created" || event.type === "session.updated") {
    const info = event.properties.info as SessionInfo | undefined
    if (!info?.id) return state
    const existing = state.sessions[info.id]
    const sessions = { ...state.sessions, [info.id]: existing ? { ...existing, info } : newSession(info) }
    const order = [info.id, ...state.order.filter((id) => id !== info.id)]
    return { ...state, sessions, order, selectedID: state.selectedID ?? info.id }
  }
  if (event.type === "session.deleted") {
    const info = event.properties.info as SessionInfo | undefined
    if (!info?.id || !state.sessions[info.id]) return state
    const sessions = { ...state.sessions }
    delete sessions[info.id]
    const order = state.order.filter((id) => id !== info.id)
    return { ...state, sessions, order, selectedID: state.selectedID === info.id ? order[0] : state.selectedID }
  }

  const sessionID = eventSessionID(event)
  if (!sessionID) return state
  const session = state.sessions[sessionID]
  if (!session) return state
  let updated = session

  if (event.type === "session.status") {
    const status = event.properties.status as SessionStatus | undefined
    if (status?.type && ["idle", "busy", "retry", "error"].includes(status.type)) {
      const becameIdle = status.type === "idle" && session.status.type !== "idle"
      updated = {
        ...session,
        status,
        unread: becameIdle && state.selectedID !== sessionID ? session.unread + 1 : session.unread,
      }
    }
  } else if (event.type === "session.idle") {
    const becameIdle = session.status.type !== "idle"
    updated = {
      ...session,
      status: { type: "idle" },
      unread: becameIdle && state.selectedID !== sessionID ? session.unread + 1 : session.unread,
    }
  } else if (event.type === "session.error") {
    updated = { ...session, status: { type: "error", message: "Session failed" } }
  } else if (event.type === "message.updated") {
    const info = event.properties.info as MessageInfo | undefined
    if (info?.id) updated = { ...session, messages: upsertMessage(session.messages, info) }
  } else if (event.type === "message.removed" && typeof event.properties.messageID === "string") {
    updated = { ...session, messages: removeMessage(session.messages, event.properties.messageID) }
  } else if (event.type === "message.part.updated") {
    const part = event.properties.part as MessagePart | undefined
    if (part?.id) updated = { ...session, messages: upsertPart(session.messages, part) }
  } else if (
    event.type === "message.part.removed" &&
    typeof event.properties.messageID === "string" &&
    typeof event.properties.partID === "string"
  ) {
    updated = { ...session, messages: removePart(session.messages, event.properties.messageID, event.properties.partID) }
  }

  return updated === session ? state : { ...state, sessions: { ...state.sessions, [sessionID]: updated } }
}
