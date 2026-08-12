import type { SessionLifecycleState, SettlementReason, WorkbenchState } from "@opencode-workbench/shared"

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
  setPromptAdmissionPaused(paused: boolean): void
  waitForSettlement(
    sessionID: string,
    signal?: AbortSignal,
    ignoredReasons?: readonly SettlementReason[],
  ): Promise<SessionLifecycleState>
}

export interface DeferredReloadOptions {
  timeoutMilliseconds?: number
  reload(request: OpenCodeReloadRequest): Promise<void>
  completed?(request: OpenCodeReloadRequest): void
  failed?(request: OpenCodeReloadRequest, error: unknown): void
}

export class DeferredOpenCodeReload {
  private pending?: OpenCodeReloadRequest
  private pendingIdleSessionID?: string
  private running?: OpenCodeReloadRequest
  private settlementCancellation?: AbortController
  private disposed = false

  constructor(private readonly controller: ReloadController, private readonly options: DeferredReloadOptions) {}

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
    const cancellation = new AbortController()
    this.settlementCancellation = cancellation
    const timeout = setTimeout(
      () => cancellation.abort(new Error("Timed out waiting for OpenCode session to settle")),
      timeoutMilliseconds,
    )
    void this.controller.waitForSettlement(idleSessionID, cancellation.signal, ["QUEUED_PROMPT"])
      .then(() => {
        if (this.pending !== request || this.settlementCancellation !== cancellation) return
        this.pending = undefined
        this.pendingIdleSessionID = undefined
        this.settlementCancellation = undefined
        clearTimeout(timeout)
        this.running = request
        void this.execute(request)
      })
      .catch((error) => {
        if (this.pending !== request || this.settlementCancellation !== cancellation) return
        this.pending = undefined
        this.pendingIdleSessionID = undefined
        this.settlementCancellation = undefined
        clearTimeout(timeout)
        this.controller.setPromptAdmissionPaused(false)
        this.options.failed?.(request, error)
      })
    return { scheduled: true, when: "session-idle", sessionID: request.sessionID }
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
    this.settlementCancellation?.abort(new Error("OpenCode reload coordinator was disposed"))
    this.settlementCancellation = undefined
    this.pending = undefined
    this.pendingIdleSessionID = undefined
    this.controller.setPromptAdmissionPaused(false)
  }
}
