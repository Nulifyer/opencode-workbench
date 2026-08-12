import type { WorkbenchState } from "@opencode-workbench/shared"
import type { ControllerUpdate } from "./session-controller.js"

export type OpenCodeReloadReason = "skill-activation" | "configuration-change"

export interface OpenCodeReloadRequest {
  sessionID: string
  reason: OpenCodeReloadReason
}

export interface ReloadRequestReceipt {
  scheduled: true
  when: "session-idle" | "reloading"
  sessionID: string
  deduplicated?: true
}

interface ReloadController {
  readonly snapshot: WorkbenchState
  subscribe(listener: (update: ControllerUpdate) => void): { dispose(): void }
  setPromptAdmissionPaused(paused: boolean): void
}

export interface DeferredReloadOptions {
  timeoutMilliseconds?: number
  reload(request: OpenCodeReloadRequest): Promise<void>
  completed?(request: OpenCodeReloadRequest): void
  failed?(request: OpenCodeReloadRequest, error: unknown): void
}

function eventSessionID(update: ControllerUpdate): string | undefined {
  if (update.type !== "event") return undefined
  const properties = update.event.properties
  if (typeof properties.sessionID === "string") return properties.sessionID
  const info = properties.info
  return typeof info === "object" && info !== null && "sessionID" in info && typeof info.sessionID === "string"
    ? info.sessionID
    : undefined
}

function terminalUpdate(update: ControllerUpdate, sessionID: string): boolean {
  if (update.type !== "event" || eventSessionID(update) !== sessionID) return false
  if (update.event.type === "session.idle" || update.event.type === "session.error") return true
  const status = update.event.properties.status
  return update.event.type === "session.status" && typeof status === "object" && status !== null && "type" in status &&
    (status.type === "idle" || status.type === "error")
}

export class DeferredOpenCodeReload {
  private readonly subscription: { dispose(): void }
  private pending?: OpenCodeReloadRequest
  private pendingIdleSessionID?: string
  private running?: OpenCodeReloadRequest
  private timeout?: NodeJS.Timeout
  private disposed = false

  constructor(private readonly controller: ReloadController, private readonly options: DeferredReloadOptions) {
    this.subscription = controller.subscribe((update) => this.update(update))
  }

  request(request: OpenCodeReloadRequest): ReloadRequestReceipt {
    if (this.disposed) throw new Error("OpenCode reload coordinator is unavailable")
    if (!Object.hasOwn(this.controller.snapshot.sessions, request.sessionID)) {
      throw new Error("OpenCode reload request used an unknown session")
    }
    const existing = this.pending ?? this.running
    if (existing) {
      if (existing.sessionID !== request.sessionID || existing.reason !== request.reason) {
        throw new Error("Another OpenCode reload is already pending")
      }
      return {
        scheduled: true,
        when: this.running ? "reloading" : "session-idle",
        sessionID: request.sessionID,
        deduplicated: true,
      }
    }
    this.pending = request
    let idleSessionID = request.sessionID
    const visited = new Set<string>()
    while (!visited.has(idleSessionID)) {
      visited.add(idleSessionID)
      const parentID = this.controller.snapshot.sessions[idleSessionID]?.info.parentID
      if (!parentID || !Object.hasOwn(this.controller.snapshot.sessions, parentID)) break
      idleSessionID = parentID
    }
    this.pendingIdleSessionID = idleSessionID
    this.controller.setPromptAdmissionPaused(true)
    const timeoutMilliseconds = this.options.timeoutMilliseconds ?? 5 * 60_000
    this.timeout = setTimeout(() => {
      if (this.pending !== request) return
      this.pending = undefined
      this.pendingIdleSessionID = undefined
      this.timeout = undefined
      this.controller.setPromptAdmissionPaused(false)
      this.options.failed?.(request, new Error("Timed out waiting for OpenCode session to become idle"))
    }, timeoutMilliseconds)
    return { scheduled: true, when: "session-idle", sessionID: request.sessionID }
  }

  private update(update: ControllerUpdate): void {
    const request = this.pending
    if (!request || !this.pendingIdleSessionID || !terminalUpdate(update, this.pendingIdleSessionID)) return
    this.pending = undefined
    this.pendingIdleSessionID = undefined
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    this.running = request
    void this.execute(request)
  }

  private async execute(request: OpenCodeReloadRequest): Promise<void> {
    try {
      await this.options.reload(request)
      this.options.completed?.(request)
    } catch (error) {
      this.options.failed?.(request, error)
    } finally {
      this.running = undefined
      if (!this.disposed) this.controller.setPromptAdmissionPaused(false)
    }
  }

  dispose(): void {
    this.disposed = true
    this.subscription.dispose()
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    this.pending = undefined
    this.pendingIdleSessionID = undefined
    this.controller.setPromptAdmissionPaused(false)
  }
}
