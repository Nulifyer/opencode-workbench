import {
  reconstructSessionLifecycle,
  type SessionLifecycleState,
  type SessionViewState,
  type SettlementReason,
} from "@opencode-workbench/shared"

export interface SessionSettlementProjection {
  connected: boolean
  session: SessionViewState
  retryPending?: boolean
  committingOperationIDs?: string[]
}

export class SettlementCoordinator {
  readonly pendingPromptSessions = new Map<string, string>()
  readonly pendingPromptTexts = new Map<string, string>()
  readonly pendingPromptFileCounts = new Map<string, number>()
  readonly sessionFailures = new Map<string, string>()
  promptAdmissionPaused = false
  private readonly lifecycle = new Map<string, SessionLifecycleState>()
  private readonly listeners = new Set<(sessionID: string, state?: SessionLifecycleState) => void>()

  pendingText(messageID: string, queued?: (sessionID: string) => string | undefined): string | undefined {
    const retained = this.pendingPromptTexts.get(messageID)
    if (retained !== undefined) return retained
    const sessionID = this.pendingPromptSessions.get(messageID)
    return sessionID ? queued?.(sessionID) : undefined
  }

  project(sessionID: string, projection: SessionSettlementProjection): SessionLifecycleState {
    const authority = { epoch: `session:${sessionID}`, generation: 0 }
    const active = projection.session.status.type === "busy" || projection.session.status.type === "retry"
    const activeTurnID = active ? `active:${sessionID}` : undefined
    const prompts = projection.session.queue.map((prompt) => ({
      id: prompt.id,
      delivery: prompt.delivery === "follow-up" ? "follow-up" as const : "steer" as const,
      state: "queued" as const,
    }))
    const next = reconstructSessionLifecycle({
      authority,
      runtime: projection.connected ? authority : { epoch: "runtime:disconnected", generation: 0 },
      revision: (this.lifecycle.get(sessionID)?.revision ?? -1) + 1,
      prompts,
      queue: prompts.map((prompt) => prompt.id),
      turns: activeTurnID ? [{ id: activeTurnID, promptID: `runtime:${sessionID}`, state: "streaming" }] : [],
      activeTurnID,
      unresolvedPermissionIDs: projection.session.permissions.map((request) => request.id),
      unresolvedQuestionIDs: projection.session.questions.map((request) => request.id),
      pendingContinuations: projection.retryPending || projection.session.status.type === "retry" ? ["retry"] : [],
      committingOperationIDs: projection.committingOperationIDs,
    })
    const previous = this.lifecycle.get(sessionID)
    this.lifecycle.set(sessionID, next)
    if (
      !previous || previous.settlement.status !== next.settlement.status ||
      previous.settlement.reasons.join("\0") !== next.settlement.reasons.join("\0")
    ) {
      for (const listener of this.listeners) listener(sessionID, next)
    }
    return next
  }

  getSnapshot(sessionID: string): SessionLifecycleState | undefined {
    return this.lifecycle.get(sessionID)
  }

  getSettlementReasons(sessionID: string): SettlementReason[] {
    return this.lifecycle.get(sessionID)?.settlement.reasons.slice() ?? ["RUNTIME_EPOCH_MISMATCH"]
  }

  isSettled(sessionID: string, ignoredReasons: readonly SettlementReason[] = []): boolean {
    const state = this.lifecycle.get(sessionID)
    return Boolean(state && state.settlement.reasons.every((reason) => ignoredReasons.includes(reason)))
  }

  waitForSettlement(
    sessionID: string,
    signal?: AbortSignal,
    ignoredReasons: readonly SettlementReason[] = [],
  ): Promise<SessionLifecycleState> {
    const current = this.lifecycle.get(sessionID)
    if (current && this.isSettled(sessionID, ignoredReasons)) return Promise.resolve(current)
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Settlement wait cancelled"))
    return new Promise((resolve, reject) => {
      const finish = (state?: SessionLifecycleState, error?: unknown) => {
        this.listeners.delete(listener)
        signal?.removeEventListener("abort", aborted)
        if (error !== undefined) reject(error)
        else resolve(state!)
      }
      const listener = (changedSessionID: string, state?: SessionLifecycleState) => {
        if (changedSessionID !== sessionID) return
        if (!state) finish(undefined, new Error("OpenCode session was removed while waiting for settlement"))
        else if (state.settlement.reasons.every((reason) => ignoredReasons.includes(reason))) finish(state)
      }
      const aborted = () => finish(undefined, signal?.reason ?? new Error("Settlement wait cancelled"))
      this.listeners.add(listener)
      signal?.addEventListener("abort", aborted, { once: true })
    })
  }

  remove(sessionID: string): void {
    if (!this.lifecycle.delete(sessionID)) return
    for (const listener of this.listeners) listener(sessionID, undefined)
  }

  dispose(): void {
    this.pendingPromptSessions.clear()
    this.pendingPromptTexts.clear()
    this.pendingPromptFileCounts.clear()
    this.sessionFailures.clear()
    this.lifecycle.clear()
    this.listeners.clear()
  }
}
