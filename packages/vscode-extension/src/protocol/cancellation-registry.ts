interface CancellationEntry {
  surfaceID: string
  disposition: "cancel" | "detach"
  controller: AbortController
}

export class CancellationRegistry {
  private readonly entries = new Map<string, CancellationEntry>()

  create(
    requestID: string,
    surfaceID: string,
    disposition: "cancel" | "detach",
  ): AbortSignal {
    if (this.entries.has(requestID)) {
      throw new Error(`Cancellation entry already exists for ${requestID}`)
    }
    const controller = new AbortController()
    this.entries.set(requestID, { surfaceID, disposition, controller })
    return controller.signal
  }

  cancel(
    requestID: string,
    reason: unknown = new Error("Request cancelled"),
  ): boolean {
    const entry = this.entries.get(requestID)
    if (!entry || entry.controller.signal.aborted) return false
    entry.controller.abort(reason)
    return true
  }

  finish(requestID: string): void {
    this.entries.delete(requestID)
  }

  disposeSurface(
    surfaceID: string,
  ): { cancelled: string[]; detached: string[] } {
    const cancelled: string[] = []
    const detached: string[] = []
    for (const [requestID, entry] of this.entries) {
      if (entry.surfaceID !== surfaceID) continue
      if (entry.disposition === "cancel") {
        entry.controller.abort(new Error("Surface disposed"))
        cancelled.push(requestID)
      } else detached.push(requestID)
    }
    return { cancelled, detached }
  }
}
