import type {
  FileChange,
  MessageBundle,
  MessageInfo,
  MessagePart,
  OpenCodeEvent,
  PermissionRequest,
  QuestionRequest,
  QueuedPrompt,
  SessionInfo,
  SessionStatus,
  TodoItem,
} from "./opencode.ts"

export interface SessionViewState {
  info: SessionInfo
  messages: MessageBundle[]
  loaded: boolean
  loadState: "idle" | "loading" | "ready" | "error"
  draft: string
  unread: number
  status: SessionStatus
  agent?: string
  model?: string
  variant?: string
  queue: QueuedPrompt[]
  permissions: PermissionRequest[]
  todos: TodoItem[]
  changes: FileChange[]
  questions: QuestionRequest[]
  autoApproval: boolean
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
  | { type: "preference"; sessionID: string; agent?: string; model?: string; variant?: string }
  | { type: "queue"; sessionID: string; prompt: QueuedPrompt }
  | { type: "removeQueued"; sessionID: string; promptID: string }
  | { type: "reorderQueue"; sessionID: string; promptIDs: string[] }
  | { type: "permissions"; sessionID: string; permissions: PermissionRequest[] }
  | { type: "todos"; sessionID: string; todos: TodoItem[] }
  | { type: "changes"; sessionID: string; changes: FileChange[] }
  | { type: "questions"; sessionID: string; questions: QuestionRequest[] }
  | { type: "autoApproval"; sessionID: string; enabled: boolean }
  | { type: "transcriptLoading"; sessionID: string }
  | { type: "transcriptError"; sessionID: string }
  | { type: "transcript"; sessionID: string; messages: MessageBundle[] }
  | { type: "event"; event: OpenCodeEvent }

export const initialWorkbenchState: WorkbenchState = {
  sessions: Object.create(null) as Record<string, SessionViewState>,
  order: [],
  connected: false,
}

function hasSession(sessions: Record<string, SessionViewState>, sessionID: string): boolean {
  return Object.hasOwn(sessions, sessionID)
}

function copySessions(sessions: Record<string, SessionViewState>): Record<string, SessionViewState> {
  return Object.assign(Object.create(null) as Record<string, SessionViewState>, sessions)
}

function newSession(info: SessionInfo, status: SessionStatus = { type: "idle" }): SessionViewState {
  const model = info.model ? `${info.model.providerID}/${info.model.id}` : undefined
  return { info, messages: [], loaded: false, loadState: "idle", draft: "", unread: 0, status, agent: info.agent, model, variant: info.model?.variant, queue: [], permissions: [], todos: [], changes: [], questions: [], autoApproval: false }
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
  if (action.type === "autoApproval") {
    if (!hasSession(state.sessions, action.sessionID) || state.sessions[action.sessionID]!.autoApproval === action.enabled) return state
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = { ...sessions[action.sessionID]!, autoApproval: action.enabled }
    return { ...state, sessions }
  }

  if (action.type === "reconcile") {
    const sessions = Object.create(null) as Record<string, SessionViewState>
    for (const info of action.sessions) {
      const existing = hasSession(state.sessions, info.id) ? state.sessions[info.id] : undefined
      const status = action.statuses && Object.hasOwn(action.statuses, info.id) ? action.statuses[info.id] : undefined
      sessions[info.id] = existing
        ? {
            ...existing,
            info,
            status: status ?? { type: "idle" },
            agent: info.agent ?? existing.agent,
            model: info.model ? `${info.model.providerID}/${info.model.id}` : existing.model,
            variant: info.model ? info.model.variant : existing.variant,
          }
        : newSession(info, status)
    }
    const order = action.sessions
      .slice()
      .sort((left, right) => right.time.updated - left.time.updated)
      .map((session) => session.id)
    const selectedID = state.selectedID && hasSession(sessions, state.selectedID)
      ? state.selectedID
      : order.find((id) => !sessions[id]?.info.parentID) ?? order[0]
    return { ...state, sessions, order, selectedID }
  }

  if (action.type === "select") {
    if (action.sessionID && !hasSession(state.sessions, action.sessionID)) return state
    const sessions = copySessions(state.sessions)
    if (action.sessionID) sessions[action.sessionID] = { ...sessions[action.sessionID]!, unread: 0 }
    return { ...state, selectedID: action.sessionID, sessions }
  }

  if (action.type === "draft") {
    if (!hasSession(state.sessions, action.sessionID)) return state
    const current = state.sessions[action.sessionID]
    if (current!.draft === action.draft) return state
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = { ...current!, draft: action.draft }
    return { ...state, sessions }
  }
  if (action.type === "preference") {
    if (!hasSession(state.sessions, action.sessionID)) return state
    const current = state.sessions[action.sessionID]
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = {
      ...current!,
      agent: action.agent === undefined ? current!.agent : action.agent || undefined,
      model: action.model === undefined ? current!.model : action.model || undefined,
      variant: action.variant === undefined ? current!.variant : action.variant || undefined,
    }
    return {
      ...state,
      sessions,
    }
  }
  if (action.type === "queue") {
    if (!hasSession(state.sessions, action.sessionID)) return state
    const current = state.sessions[action.sessionID]!
    if (current.queue.some((prompt) => prompt.id === action.prompt.id)) return state
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = { ...current, queue: [...current.queue, action.prompt] }
    return { ...state, sessions }
  }
  if (action.type === "removeQueued") {
    if (!hasSession(state.sessions, action.sessionID)) return state
    const current = state.sessions[action.sessionID]!
    const queue = current.queue.filter((prompt) => prompt.id !== action.promptID)
    if (queue.length === current.queue.length) return state
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = { ...current, queue }
    return { ...state, sessions }
  }
  if (action.type === "reorderQueue") {
    if (!hasSession(state.sessions, action.sessionID)) return state
    const current = state.sessions[action.sessionID]!
    if (action.promptIDs.length !== current.queue.length || new Set(action.promptIDs).size !== action.promptIDs.length) return state
    const prompts = new Map(current.queue.map((prompt) => [prompt.id, prompt]))
    const queue = action.promptIDs.map((id) => prompts.get(id))
    if (queue.some((prompt) => !prompt)) return state
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = { ...current, queue: queue as QueuedPrompt[] }
    return { ...state, sessions }
  }
  if (action.type === "permissions" || action.type === "todos" || action.type === "changes" || action.type === "questions") {
    if (!hasSession(state.sessions, action.sessionID)) return state
    const current = state.sessions[action.sessionID]!
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = action.type === "permissions"
      ? { ...current, permissions: action.permissions }
      : action.type === "todos"
      ? { ...current, todos: action.todos }
      : action.type === "changes"
      ? { ...current, changes: action.changes }
      : { ...current, questions: action.questions }
    return { ...state, sessions }
  }
  if (action.type === "transcript") {
    if (!hasSession(state.sessions, action.sessionID)) return state
    const current = state.sessions[action.sessionID]
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = { ...current!, messages: action.messages, loaded: true, loadState: "ready" }
    return {
      ...state,
      sessions,
    }
  }
  if (action.type === "transcriptLoading" || action.type === "transcriptError") {
    if (!hasSession(state.sessions, action.sessionID)) return state
    const current = state.sessions[action.sessionID]!
    const loadState = action.type === "transcriptLoading" ? "loading" as const : "error" as const
    if (current.loadState === loadState) return state
    const sessions = copySessions(state.sessions)
    sessions[action.sessionID] = { ...current, loadState }
    return { ...state, sessions }
  }
  if (action.type !== "event") return state

  const event = action.event
  if (event.type === "session.created" || event.type === "session.updated") {
    const info = event.properties.info as SessionInfo | undefined
    if (!info?.id) return state
    const existing = hasSession(state.sessions, info.id) ? state.sessions[info.id] : undefined
    const sessions = copySessions(state.sessions)
    sessions[info.id] = existing ? { ...existing, info } : newSession(info)
    const order = [info.id, ...state.order.filter((id) => id !== info.id)]
    return { ...state, sessions, order, selectedID: state.selectedID ?? info.id }
  }
  if (event.type === "session.deleted") {
    const info = event.properties.info as SessionInfo | undefined
    if (!info?.id || !hasSession(state.sessions, info.id)) return state
    const sessions = copySessions(state.sessions)
    delete sessions[info.id]
    const order = state.order.filter((id) => id !== info.id)
    return { ...state, sessions, order, selectedID: state.selectedID === info.id ? order.find((id) => !sessions[id]?.info.parentID) ?? order[0] : state.selectedID }
  }

  const sessionID = eventSessionID(event)
  if (!sessionID || !hasSession(state.sessions, sessionID)) return state
  const session = state.sessions[sessionID]!
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
  } else if (event.type === "todo.updated") {
    const todos = event.properties.todos
    if (Array.isArray(todos)) updated = { ...session, todos: todos as TodoItem[] }
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

  if (updated === session) return state
  const sessions = copySessions(state.sessions)
  sessions[sessionID] = updated
  return { ...state, sessions }
}
