import type {
  AgentOption,
  ChatSnapshot,
  ModelOption,
  OpenCodeEvent,
  PermissionRequest,
  WorkbenchState,
} from "@opencode-workbench/shared"
import { initialWorkbenchState, sessionReducer } from "@opencode-workbench/shared"
import { OpenCodeClient, parsePermission } from "./opencode-client.js"

export interface ControllerCallbacks {
  permission(request: PermissionRequest): Promise<"once" | "always" | "reject">
  error(message: string): void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

function mergeTranscripts(server: WorkbenchState["sessions"][string]["messages"], current: WorkbenchState["sessions"][string]["messages"]) {
  const merged = server.map((message) => ({ ...message, parts: message.parts.slice() }))
  for (const live of current) {
    const index = merged.findIndex((message) => message.info.id === live.info.id)
    if (index < 0) {
      merged.push(live)
      continue
    }
    const base = merged[index]!
    const parts = base.parts.slice()
    for (const part of live.parts) {
      const partIndex = parts.findIndex((candidate) => candidate.id === part.id)
      if (partIndex < 0) parts.push(part)
      else parts[partIndex] = part
    }
    merged[index] = { info: { ...base.info, ...live.info }, parts }
  }
  return merged
}

export class SessionController {
  private state: WorkbenchState = initialWorkbenchState
  private readonly listeners = new Set<() => void>()
  private stream?: AbortController
  private disposed = false
  private pendingPermissions = new Set<string>()
  private agents: AgentOption[] = []
  private models: ModelOption[] = []
  private reconcileGeneration = 0
  private sessionRevision = 0
  private statusRevision = 0
  private readonly transcriptRevisions = new Map<string, number>()
  private readonly transcriptGenerations = new Map<string, number>()
  private readonly removedMessages = new Map<string, Map<string, number>>()
  private readonly removedParts = new Map<string, Map<string, number>>()
  private readonly sendGenerations = new Map<string, number>()

  constructor(private readonly client: OpenCodeClient, private readonly callbacks: ControllerCallbacks) {}

  get snapshot(): WorkbenchState {
    return this.state
  }

  subscribe(listener: () => void): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  start(): void {
    if (this.stream || this.disposed) return
    this.stream = new AbortController()
    void this.runEventLoop(this.stream.signal)
  }

  reconnect(): void {
    this.stream?.abort()
    this.stream = undefined
    this.reconcileGeneration += 1
    for (const [sessionID, generation] of this.transcriptGenerations) {
      this.transcriptGenerations.set(sessionID, generation + 1)
    }
    this.dispatch({ type: "connected", connected: false })
    this.start()
  }

  dispose(): void {
    this.disposed = true
    this.stream?.abort()
    this.stream = undefined
    this.listeners.clear()
  }

  private dispatch(action: Parameters<typeof sessionReducer>[1]): void {
    const next = sessionReducer(this.state, action)
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  private async runEventLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted) {
      try {
        await this.client.events(
          signal,
          async () => {
            attempt = 0
            this.dispatch({ type: "connected", connected: true })
            await this.reconcile()
            await this.reconcilePermissions()
          },
          (event) => {
            if (!signal.aborted) this.handleEvent(event)
          },
        )
      } catch (error) {
        if (signal.aborted) return
        this.dispatch({ type: "connected", connected: false })
        if (attempt === 0) this.callbacks.error(message(error))
        attempt += 1
        try {
          await delay(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)), signal)
        } catch {
          return
        }
      }
    }
  }

  async reconcile(): Promise<void> {
    const generation = ++this.reconcileGeneration
    const sessionRevision = this.sessionRevision
    const statusRevision = this.statusRevision
    const [sessions, statuses, catalogs] = await Promise.all([
      this.client.listSessions(),
      this.client.sessionStatuses(),
      this.client.catalogs().catch(() => ({ agents: this.agents, models: this.models })),
    ])
    if (this.disposed || generation !== this.reconcileGeneration) return
    if (sessionRevision !== this.sessionRevision) {
      void this.reconcile()
      return
    }
    this.agents = catalogs.agents
    this.models = catalogs.models
    const effectiveStatuses = statusRevision === this.statusRevision
      ? statuses
      : Object.fromEntries(Object.entries(this.state.sessions).map(([id, session]) => [id, session.status]))
    this.dispatch({ type: "reconcile", sessions, statuses: effectiveStatuses })
    const refreshIDs = this.state.order.filter((id) =>
      id === this.state.selectedID ||
      this.state.sessions[id]?.loaded ||
      effectiveStatuses[id]?.type === "busy" ||
      effectiveStatuses[id]?.type === "retry",
    )
    await Promise.allSettled(refreshIDs.map((id) => this.loadTranscript(id)))
  }

  private async reconcilePermissions(): Promise<void> {
    const requests = await this.client.pendingPermissions().catch(() => [])
    for (const request of requests) {
      if (!this.pendingPermissions.has(request.id)) void this.handlePermission(request)
    }
  }

  async createSession(title?: string): Promise<string> {
    const session = await this.client.createSession(title)
    this.sessionRevision += 1
    this.dispatch({ type: "event", event: { type: "session.created", properties: { info: session } } })
    await this.select(session.id)
    return session.id
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.client.deleteSession(sessionID)
    this.sessionRevision += 1
    const info = this.state.sessions[sessionID]?.info
    if (info) this.dispatch({ type: "event", event: { type: "session.deleted", properties: { info } } })
    const selectedID = this.state.selectedID
    if (selectedID && !this.state.sessions[selectedID]?.loaded) await this.loadTranscript(selectedID)
  }

  async select(sessionID: string): Promise<void> {
    this.dispatch({ type: "select", sessionID })
    if (!this.state.sessions[sessionID]?.loaded) await this.loadTranscript(sessionID)
  }

  private async loadTranscript(sessionID: string): Promise<void> {
    const generation = (this.transcriptGenerations.get(sessionID) ?? 0) + 1
    this.transcriptGenerations.set(sessionID, generation)
    const revision = this.transcriptRevisions.get(sessionID) ?? 0
    const messages = await this.client.messages(sessionID)
    if (this.transcriptGenerations.get(sessionID) !== generation) return
    const current = this.state.sessions[sessionID]
    if (!current) return
    let transcript = (this.transcriptRevisions.get(sessionID) ?? 0) === revision
      ? messages
      : mergeTranscripts(messages, current.messages)
    const removedMessages = this.removedMessages.get(sessionID)
    const removedParts = this.removedParts.get(sessionID)
    transcript = transcript
      .filter((message) => (removedMessages?.get(message.info.id) ?? 0) <= revision)
      .map((message) => ({
        ...message,
        parts: message.parts.filter((part) => (removedParts?.get(`${message.info.id}:${part.id}`) ?? 0) <= revision),
      }))
    this.dispatch({ type: "transcript", sessionID, messages: transcript })
    for (const [id, removedAt] of removedMessages ?? []) if (removedAt <= revision) removedMessages?.delete(id)
    for (const [id, removedAt] of removedParts ?? []) if (removedAt <= revision) removedParts?.delete(id)
    const lastUser = messages.slice().reverse().find((entry) => entry.info.role === "user")?.info
    const model = lastUser?.model
    const modelRecord = model && typeof model === "object" ? model as Record<string, unknown> : undefined
    const inferredModel = modelRecord && typeof modelRecord.providerID === "string" && typeof modelRecord.modelID === "string"
      ? `${modelRecord.providerID}/${modelRecord.modelID}`
      : undefined
    const inferredAgent = typeof lastUser?.agent === "string" ? lastUser.agent : undefined
    if ((!current.agent && inferredAgent) || (!current.model && inferredModel)) {
      this.dispatch({
        type: "preference",
        sessionID,
        agent: current.agent ? undefined : inferredAgent,
        model: current.model ? undefined : inferredModel,
      })
    }
  }

  setDraft(draft: string): void {
    const sessionID = this.state.selectedID
    if (sessionID) this.dispatch({ type: "draft", sessionID, draft })
  }

  setPreference(agent?: string, model?: string): void {
    const sessionID = this.state.selectedID
    if (sessionID) this.dispatch({ type: "preference", sessionID, agent, model })
  }

  async send(text: string, agent?: string, model?: string): Promise<void> {
    const sessionID = this.state.selectedID
    if (!sessionID) throw new Error("Create or select a session first")
    const session = this.state.sessions[sessionID]
    if (session?.status.type === "busy" || session?.status.type === "retry") throw new Error("Wait for the active OpenCode prompt to finish or abort it")
    const generation = (this.sendGenerations.get(sessionID) ?? 0) + 1
    this.sendGenerations.set(sessionID, generation)
    this.dispatch({ type: "preference", sessionID, agent, model })
    this.dispatch({ type: "draft", sessionID, draft: "" })
    this.statusRevision += 1
    this.dispatch({ type: "event", event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    try {
      await this.client.sendAsync(sessionID, text, agent, model)
    } catch (error) {
      if (this.sendGenerations.get(sessionID) === generation) {
        this.dispatch({ type: "draft", sessionID, draft: text })
        this.statusRevision += 1
        this.dispatch({ type: "event", event: { type: "session.status", properties: { sessionID, status: { type: "error", message: message(error) } } } })
      }
      throw error
    }
  }

  async abortSelected(): Promise<void> {
    const sessionID = this.state.selectedID
    if (!sessionID) return
    await this.client.abort(sessionID)
  }

  chatSnapshot(): ChatSnapshot {
    const current = this.state.selectedID ? this.state.sessions[this.state.selectedID] : undefined
    return {
      connected: this.state.connected,
      agents: this.agents,
      models: this.models,
      session: current ? {
        id: current.info.id,
        title: current.info.title,
        draft: current.draft,
        status: current.status,
        messages: current.messages,
        agent: current.agent,
        model: current.model,
      } : undefined,
    }
  }

  private handleEvent(event: OpenCodeEvent): void {
    if (["session.created", "session.updated", "session.deleted"].includes(event.type)) this.sessionRevision += 1
    if (["session.status", "session.idle", "session.error"].includes(event.type)) this.statusRevision += 1
    const info = event.properties.info
    const part = event.properties.part
    const sessionID = typeof event.properties.sessionID === "string"
      ? event.properties.sessionID
      : info && typeof info === "object" && "sessionID" in info && typeof info.sessionID === "string"
      ? info.sessionID
      : part && typeof part === "object" && "sessionID" in part && typeof part.sessionID === "string"
      ? part.sessionID
      : undefined
    if (sessionID && event.type.startsWith("message.")) {
      const revision = (this.transcriptRevisions.get(sessionID) ?? 0) + 1
      this.transcriptRevisions.set(sessionID, revision)
      if (event.type === "message.removed" && typeof event.properties.messageID === "string") {
        const removed = this.removedMessages.get(sessionID) ?? new Map<string, number>()
        removed.set(event.properties.messageID, revision)
        this.removedMessages.set(sessionID, removed)
      }
      if (event.type === "message.part.removed" && typeof event.properties.messageID === "string" && typeof event.properties.partID === "string") {
        const removed = this.removedParts.get(sessionID) ?? new Map<string, number>()
        removed.set(`${event.properties.messageID}:${event.properties.partID}`, revision)
        this.removedParts.set(sessionID, removed)
      }
    }
    this.dispatch({ type: "event", event })
    const permission = parsePermission(event)
    if (permission && !this.pendingPermissions.has(permission.id)) void this.handlePermission(permission)
  }

  private async handlePermission(request: PermissionRequest): Promise<void> {
    this.pendingPermissions.add(request.id)
    try {
      const response = await this.callbacks.permission(request)
      await this.client.respondPermission(request, response)
    } catch (error) {
      this.callbacks.error(`Could not answer permission request: ${message(error)}`)
    } finally {
      this.pendingPermissions.delete(request.id)
    }
  }
}
