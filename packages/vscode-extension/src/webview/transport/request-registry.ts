interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class WebviewRequestRegistry {
  private readonly pending = new Map<string, PendingRequest>()
  constructor(readonly maximumPending = 128) {
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1) {
      throw new Error("Webview request maximum must be positive")
    }
  }
  register<TResult>(requestID: string, timeoutMilliseconds = 30_000): Promise<TResult> {
    if (!requestID || this.pending.has(requestID)) {
      return Promise.reject(new Error(`Duplicate webview request ${requestID || "<empty>"}`))
    }
    if (this.pending.size >= this.maximumPending) return Promise.reject(new Error("Webview request registry is full"))
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID)
        reject(new Error(`Webview request ${requestID} timed out`))
      }, timeoutMilliseconds)
      this.pending.set(requestID, { resolve: (value) => resolve(value as TResult), reject, timer })
    })
  }
  resolve(requestID: string, value: unknown): boolean {
    const request = this.pending.get(requestID)
    if (!request) return false
    this.pending.delete(requestID)
    clearTimeout(request.timer)
    request.resolve(value)
    return true
  }
  reject(requestID: string, error: Error): boolean {
    const request = this.pending.get(requestID)
    if (!request) return false
    this.pending.delete(requestID)
    clearTimeout(request.timer)
    request.reject(error)
    return true
  }
  dispose(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("Webview transport disposed"))
    }
    this.pending.clear()
  }
}
