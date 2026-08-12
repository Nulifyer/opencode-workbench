interface StoredMutation<T> {
  fingerprint: string
  promise: Promise<T>
  createdAt: number
}

export class MutationConflictError extends Error {
  constructor(readonly mutationID: string) {
    super(`Mutation ${mutationID} was reused with a different request`)
    this.name = "MutationConflictError"
  }
}

export class IdempotencyStore<T> {
  private readonly entries = new Map<string, StoredMutation<T>>()

  constructor(
    readonly maximum = 1_000,
    readonly retentionMilliseconds = 15 * 60_000,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("Idempotency maximum must be positive")
    }
    if (
      !Number.isSafeInteger(retentionMilliseconds) || retentionMilliseconds < 1
    ) throw new Error("Idempotency retention must be positive")
  }

  execute(
    mutationID: string,
    fingerprint: string,
    operation: () => Promise<T>,
    now = Date.now(),
  ): Promise<T> {
    this.prune(now)
    const existing = this.entries.get(mutationID)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new MutationConflictError(mutationID)
      }
      return existing.promise
    }
    const promise = operation()
    this.entries.set(mutationID, { fingerprint, promise, createdAt: now })
    while (this.entries.size > this.maximum) {
      this.entries.delete(this.entries.keys().next().value!)
    }
    return promise
  }

  private prune(now: number): void {
    for (const [mutationID, entry] of this.entries) {
      if (now - entry.createdAt > this.retentionMilliseconds) {
        this.entries.delete(mutationID)
      }
    }
  }
}
