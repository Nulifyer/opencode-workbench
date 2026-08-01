export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string; next?: number }
  | { type: "error"; message?: string }

export interface SessionInfo {
  id: string
  title: string
  directory: string
  parentID?: string
  time: { created: number; updated: number }
  [key: string]: unknown
}

export interface MessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time?: { created?: number; completed?: number }
  error?: unknown
  [key: string]: unknown
}

export interface MessagePart {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  synthetic?: boolean
  tool?: string
  state?: {
    status?: string
    title?: string
    output?: string
    error?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface MessageBundle {
  info: MessageInfo
  parts: MessagePart[]
}

export interface AgentOption {
  name: string
  description?: string
}

export interface ModelOption {
  id: string
  name: string
  providerID: string
}

export interface PermissionRequest {
  id: string
  sessionID: string
  title: string
  type?: string
  pattern?: string | string[]
  metadata?: Record<string, unknown>
  always?: string[]
  protocol: "legacy" | "current" | "v2"
}

export interface OpenCodeEvent {
  type: string
  properties: Record<string, unknown>
}
