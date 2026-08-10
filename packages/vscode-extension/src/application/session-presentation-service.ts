export interface SessionPinRecord {
  sessionID: string
  pinnedAt: number
}

export const SESSION_PIN_CAPACITY = 500

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/

function validSessionID(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value)
}

function sanitizedPin(value: unknown): SessionPinRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (!validSessionID(record.sessionID) || !Number.isSafeInteger(record.pinnedAt) || Number(record.pinnedAt) < 0) return undefined
  return { sessionID: record.sessionID, pinnedAt: Number(record.pinnedAt) }
}

function clonePin(record: SessionPinRecord): SessionPinRecord {
  return { sessionID: record.sessionID, pinnedAt: record.pinnedAt }
}

function newestFirst(left: SessionPinRecord, right: SessionPinRecord): number {
  return right.pinnedAt - left.pinnedAt || left.sessionID.localeCompare(right.sessionID)
}

/** Owns the only Workbench-local session presentation state: bounded pin records. */
export class SessionPresentationService {
  private readonly pins = new Map<string, SessionPinRecord>()
  private persistenceTail: Promise<void> = Promise.resolve()
  private persistenceFailure: unknown

  constructor(
    initial: readonly unknown[] = [],
    private readonly persist?: (pins: SessionPinRecord[]) => void | PromiseLike<void>,
  ) {
    const newest = new Map<string, SessionPinRecord>()
    for (const candidate of initial) {
      const pin = sanitizedPin(candidate)
      if (!pin) continue
      const previous = newest.get(pin.sessionID)
      if (!previous || pin.pinnedAt > previous.pinnedAt) newest.set(pin.sessionID, pin)
    }
    for (const pin of [...newest.values()].sort(newestFirst).slice(0, SESSION_PIN_CAPACITY)) {
      this.pins.set(pin.sessionID, clonePin(pin))
    }
  }

  list(): SessionPinRecord[] {
    return [...this.pins.values()].sort(newestFirst).map(clonePin)
  }

  pin(sessionID: string, pinnedAt = Date.now()): SessionPinRecord {
    this.assertSessionID(sessionID)
    if (!Number.isSafeInteger(pinnedAt) || pinnedAt < 0) throw new Error("Invalid session pin timestamp")
    const pin = { sessionID, pinnedAt }
    this.pins.set(sessionID, pin)
    this.prune(sessionID)
    this.commit()
    return clonePin(pin)
  }

  unpin(sessionID: string): boolean {
    this.assertSessionID(sessionID)
    if (!this.pins.delete(sessionID)) return false
    this.commit()
    return true
  }

  /** Removes pins for sessions OpenCode no longer reports. It never invents presentation state. */
  reconcile(sessionIDs: Iterable<string>): SessionPinRecord[] {
    const authoritative = new Set<string>()
    for (const sessionID of sessionIDs) {
      this.assertSessionID(sessionID)
      authoritative.add(sessionID)
    }
    let changed = false
    for (const sessionID of this.pins.keys()) {
      if (authoritative.has(sessionID)) continue
      this.pins.delete(sessionID)
      changed = true
    }
    if (changed) this.commit()
    return this.list()
  }

  async flush(): Promise<void> {
    await this.persistenceTail
    if (this.persistenceFailure === undefined) return
    const failure = this.persistenceFailure
    this.persistenceFailure = undefined
    throw failure
  }

  private assertSessionID(sessionID: unknown): asserts sessionID is string {
    if (!validSessionID(sessionID)) throw new Error("Invalid session ID for presentation metadata")
  }

  private prune(retainID?: string): void {
    if (this.pins.size <= SESSION_PIN_CAPACITY) return
    const candidates = this.list().filter((pin) => pin.sessionID !== retainID).reverse()
    while (this.pins.size > SESSION_PIN_CAPACITY) {
      const oldest = candidates.shift()
      if (!oldest) throw new Error("Unable to enforce session pin capacity")
      this.pins.delete(oldest.sessionID)
    }
  }

  private commit(): void {
    if (!this.persist) return
    const snapshot = this.list()
    this.persistenceTail = this.persistenceTail
      .then(() => this.persist?.(snapshot))
      .then(() => undefined)
      .catch((error) => {
        if (this.persistenceFailure === undefined) this.persistenceFailure = error
      })
  }
}
