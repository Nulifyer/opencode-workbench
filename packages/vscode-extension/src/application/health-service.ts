export interface HealthSnapshot {
  workbenchVersion: string
  vscodeVersion: string
  experienceMode: "workbench" | "native"
  openCodeVersion?: string
  transportMode: "http-sse" | "acp"
  serverMode: "managed" | "external"
  serverState: "starting" | "connected" | "reconnecting" | "failed" | "disconnected"
  pluginState: "available" | "unavailable" | "unknown"
  capabilities: string[]
  eventStream: { state: string; lastEventAt?: number; lastReconciliationAt?: number; reconnectCount: number }
  requestQueueDepth: number
  protocol: { version: number; epoch?: string }
  authorizedRoots: string[]
  ahpVersion?: string
  acpVersion?: string
}

export class HealthService {
  private reconnectCount = 0
  private lastEventAt?: number
  private lastReconciliationAt?: number

  constructor(private readonly read: () => Omit<HealthSnapshot, "eventStream"> & { eventStreamState: string }) {}

  eventObserved(at = Date.now()): void {
    this.lastEventAt = at
  }

  reconciled(at = Date.now()): void {
    this.lastReconciliationAt = at
  }

  reconnected(): void {
    this.reconnectCount += 1
  }

  snapshot(): HealthSnapshot {
    const { eventStreamState, ...current } = this.read()
    return {
      ...current,
      capabilities: [...new Set(current.capabilities)].sort(),
      authorizedRoots: [...new Set(current.authorizedRoots)],
      eventStream: {
        state: eventStreamState,
        lastEventAt: this.lastEventAt,
        lastReconciliationAt: this.lastReconciliationAt,
        reconnectCount: this.reconnectCount,
      },
    }
  }
}
