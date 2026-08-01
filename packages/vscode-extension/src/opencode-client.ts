import type {
  AgentOption,
  MessageBundle,
  ModelOption,
  OpenCodeEvent,
  PermissionRequest,
  SessionInfo,
  SessionStatus,
} from "@opencode-workbench/shared"

export interface OpenCodeConnection {
  baseUrl: string
  username: string
  password: string
  directory: string
}

export function validateServerUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OpenCode server URL must use HTTP or HTTPS")
  if (url.username || url.password) throw new Error("OpenCode server URL must not contain credentials")
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("OpenCode HTTP server URL must use numeric loopback; use HTTPS for remote servers")
  }
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function parseEvent(value: unknown): OpenCodeEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.properties)) return undefined
  return { type: value.type, properties: value.properties }
}

export function parsePermission(event: OpenCodeEvent): PermissionRequest | undefined {
  if (event.type !== "permission.updated" && event.type !== "permission.asked" && event.type !== "permission.v2.asked") return undefined
  const value = event.properties
  if (typeof value.id !== "string" || typeof value.sessionID !== "string") return undefined
  if (event.type === "permission.v2.asked") {
    if (typeof value.action !== "string" || !Array.isArray(value.resources) || !value.resources.every((item) => typeof item === "string") ||
      (value.save !== undefined && (!Array.isArray(value.save) || !value.save.every((item) => typeof item === "string")))) return undefined
    return {
      id: value.id,
      sessionID: value.sessionID,
      title: `OpenCode permission: ${value.action}`,
      type: value.action,
      pattern: value.resources,
      always: value.save as string[] | undefined,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
      protocol: "v2",
    }
  }
  if (event.type === "permission.asked") {
    if (typeof value.permission !== "string" || !Array.isArray(value.patterns) || !value.patterns.every((item) => typeof item === "string") ||
      !Array.isArray(value.always) || !value.always.every((item) => typeof item === "string")) return undefined
    return {
      id: value.id,
      sessionID: value.sessionID,
      title: `OpenCode permission: ${value.permission}`,
      type: value.permission,
      pattern: value.patterns,
      always: value.always,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
      protocol: "current",
    }
  }
  if (typeof value.title !== "string" || typeof value.type !== "string") return undefined
  return {
    id: value.id,
    sessionID: value.sessionID,
    title: typeof value.title === "string" ? value.title : "OpenCode permission request",
    type: typeof value.type === "string" ? value.type : undefined,
    pattern: typeof value.pattern === "string" || (Array.isArray(value.pattern) && value.pattern.every((item) => typeof item === "string"))
      ? value.pattern as string | string[]
      : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
    protocol: "legacy",
  }
}

export class OpenCodeClient {
  constructor(private connection: OpenCodeConnection) {
    validateServerUrl(connection.baseUrl)
  }

  update(connection: OpenCodeConnection): void {
    validateServerUrl(connection.baseUrl)
    this.connection = connection
  }

  private endpoint(pathname: string): URL {
    const base = this.connection.baseUrl.endsWith("/") ? this.connection.baseUrl : `${this.connection.baseUrl}/`
    const url = new URL(pathname.replace(/^\//, ""), base)
    url.searchParams.set("directory", this.connection.directory)
    return url
  }

  private headers(json = false): Headers {
    const headers = new Headers({ Accept: "application/json" })
    if (json) headers.set("Content-Type", "application/json")
    if (this.connection.password) {
      const credential = Buffer.from(`${this.connection.username}:${this.connection.password}`, "utf8").toString("base64")
      headers.set("Authorization", `Basic ${credential}`)
    }
    return headers
  }

  private async request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.endpoint(pathname), {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000)
      throw new Error(`OpenCode ${method} ${pathname} failed (${response.status})${detail ? `: ${detail}` : ""}`)
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.request("GET", "/session")
  }

  sessionStatuses(): Promise<Record<string, SessionStatus>> {
    return this.request("GET", "/session/status")
  }

  createSession(title?: string): Promise<SessionInfo> {
    return this.request("POST", "/session", title ? { title } : {})
  }

  deleteSession(sessionID: string): Promise<boolean> {
    return this.request("DELETE", `/session/${encodeURIComponent(sessionID)}`)
  }

  messages(sessionID: string): Promise<MessageBundle[]> {
    return this.request("GET", `/session/${encodeURIComponent(sessionID)}/message`)
  }

  abort(sessionID: string): Promise<boolean> {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/abort`)
  }

  sendAsync(sessionID: string, text: string, agent?: string, model?: string): Promise<void> {
    const body: JsonRecord = { parts: [{ type: "text", text }] }
    if (agent) body.agent = agent
    if (model) {
      const slash = model.indexOf("/")
      if (slash <= 0 || slash === model.length - 1) throw new Error("Model must be provider/model")
      body.model = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
    }
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/prompt_async`, body)
  }

  respondPermission(request: PermissionRequest, response: "once" | "always" | "reject"): Promise<boolean> {
    if (request.protocol === "v2") {
      return this.request("POST", `/api/session/${encodeURIComponent(request.sessionID)}/permission/${encodeURIComponent(request.id)}/reply`, { reply: response })
    }
    return request.protocol === "current"
      ? this.request("POST", `/permission/${encodeURIComponent(request.id)}/reply`, { reply: response })
      : this.request("POST", `/session/${encodeURIComponent(request.sessionID)}/permissions/${encodeURIComponent(request.id)}`, { response })
  }

  async pendingPermissions(): Promise<PermissionRequest[]> {
    const values = await this.request<unknown>("GET", "/permission")
    if (!Array.isArray(values)) return []
    return values.flatMap((value) => {
      if (!isRecord(value)) return []
      const parsed = parsePermission({ type: "permission.asked", properties: value })
        ?? parsePermission({ type: "permission.updated", properties: value })
      return parsed ? [parsed] : []
    })
  }

  async catalogs(): Promise<{ agents: AgentOption[]; models: ModelOption[] }> {
    const [agentData, providerData] = await Promise.all([
      this.request<unknown>("GET", "/agent"),
      this.request<unknown>("GET", "/provider"),
    ])
    const agents = Array.isArray(agentData)
      ? agentData.flatMap((value): AgentOption[] => {
          if (!isRecord(value) || typeof value.name !== "string" || value.mode === "subagent") return []
          return [{ name: value.name, description: typeof value.description === "string" ? value.description : undefined }]
        })
      : []
    const all = isRecord(providerData) && Array.isArray(providerData.all) ? providerData.all : []
    const connected = isRecord(providerData) && Array.isArray(providerData.connected)
      ? new Set(providerData.connected.filter((id): id is string => typeof id === "string"))
      : undefined
    const models: ModelOption[] = []
    for (const provider of all) {
      if (!isRecord(provider) || typeof provider.id !== "string" || !isRecord(provider.models)) continue
      if (connected && !connected.has(provider.id)) continue
      for (const [id, model] of Object.entries(provider.models)) {
        if (!isRecord(model)) continue
        models.push({ id, providerID: provider.id, name: typeof model.name === "string" ? model.name : id })
      }
    }
    return { agents, models }
  }

  async events(signal: AbortSignal, onOpen: () => Promise<void> | void, onEvent: (event: OpenCodeEvent) => void): Promise<void> {
    const headers = this.headers()
    headers.set("Accept", "text/event-stream")
    const response = await fetch(this.endpoint("/event"), {
      method: "GET",
      headers,
      signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`OpenCode event stream failed (${response.status})`)
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    try {
      await onOpen()
      while (true) {
        const { done, value } = await reader.read()
        if (done) throw new Error("OpenCode event stream closed")
        buffer += value
        buffer = buffer.replace(/\r\n/g, "\n")
        if (buffer.length > 512 * 1024) throw new Error("OpenCode event stream frame exceeds 512 KiB")
        let boundary = buffer.indexOf("\n\n")
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
          if (data) {
            try {
              const event = parseEvent(JSON.parse(data))
              if (event) onEvent(event)
            } catch (error) {
              console.warn("Ignored malformed OpenCode SSE event", errorMessage(error))
            }
          }
          boundary = buffer.indexOf("\n\n")
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}
