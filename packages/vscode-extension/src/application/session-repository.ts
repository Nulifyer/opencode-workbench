import { initialWorkbenchState, sessionReducer, type WorkbenchState } from "@opencode-workbench/shared"

export type SessionRepositoryUpdate = Parameters<typeof sessionReducer>[1]

export class SessionRepository {
  private state: WorkbenchState = initialWorkbenchState
  private readonly listeners = new Set<(update: SessionRepositoryUpdate) => void>()

  get snapshot(): WorkbenchState {
    return this.state
  }

  subscribe(listener: (update: SessionRepositoryUpdate) => void): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  dispatch(update: SessionRepositoryUpdate): boolean {
    const next = sessionReducer(this.state, update)
    if (next === this.state) return false
    this.state = next
    this.notify(update)
    return true
  }

  notify(update: SessionRepositoryUpdate): void {
    for (const listener of this.listeners) listener(update)
  }

  dispose(): void {
    this.listeners.clear()
  }
}
