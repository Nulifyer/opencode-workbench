export interface TraceEntry {
  sequence: number
  timestamp: number
  type: string
  sessionID?: string
  requestID?: string
  mutationID?: string
  revision?: number
  durationMilliseconds?: number
  transition?: string
  diffHash?: string
  error?: string
}

const SECRET = /(authorization|cookie|password|secret|token|credential|prompt|attachment|content|result|unsaved)/i
const AUTHORIZATION_VALUE = /\b((?:proxy-)?authorization\s*:\s*)[^\r\n]*/gi
const COOKIE_VALUE = /\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi
const SECRET_VALUE = /((?:password|secret|token|credential)\s*[:=]\s*)([^\s,;]+)/gi
const URL_CREDENTIAL = /(https?:\/\/)[^/@\s]+@/gi

function bounded(value: string | undefined, limit = 1_024): string | undefined {
  if (!value) return undefined
  return value.replace(AUTHORIZATION_VALUE, "$1[redacted]").replace(COOKIE_VALUE, "$1[redacted]").replace(
    SECRET_VALUE,
    "$1[redacted]",
  ).replace(URL_CREDENTIAL, "$1[redacted]@").replace(/[\r\n\t]+/g, " ").slice(0, limit)
}

export function controllerTraceCategory(updateType: string, eventType?: string): string {
  const value = `${updateType}.${eventType ?? ""}`.toLowerCase()
  const category = /admit|prompt/.test(value)
    ? "admission"
    : /permission/.test(value)
    ? "permission"
    : /question|input/.test(value)
    ? "question"
    : /status|idle|busy|retry/.test(value)
    ? "status"
    : /queue/.test(value)
    ? "queue"
    : /change|diff|file/.test(value)
    ? "changes"
    : /message|part/.test(value)
    ? "message"
    : /session|select|reconcile/.test(value)
    ? "session"
    : /connect|server/.test(value)
    ? "connection"
    : /goal|settle/.test(value)
    ? "settlement"
    : "runtime"
  return `controller.${category}.${eventType ? "event" : "update"}`
}

export class TraceService {
  private readonly entries: TraceEntry[] = []
  private sequence = 0

  constructor(private readonly capacity = 2_000, private readonly clock: () => number = Date.now) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 20_000) {
      throw new Error("Trace capacity must be between 1 and 20,000")
    }
  }

  record(entry: Omit<TraceEntry, "sequence" | "timestamp"> & { timestamp?: number }): TraceEntry {
    if (!entry.type || entry.type.length > 256 || SECRET.test(entry.type)) throw new Error("Unsafe trace event type")
    const sanitized: TraceEntry = {
      sequence: ++this.sequence,
      timestamp: entry.timestamp ?? this.clock(),
      type: entry.type,
      sessionID: bounded(entry.sessionID),
      requestID: bounded(entry.requestID),
      mutationID: bounded(entry.mutationID),
      revision: entry.revision,
      durationMilliseconds: entry.durationMilliseconds,
      transition: bounded(entry.transition, 256),
      diffHash: bounded(entry.diffHash, 256),
      error: bounded(entry.error, 2_000),
    }
    this.entries.push(sanitized)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    return sanitized
  }

  snapshot(): readonly TraceEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  toJsonLines(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join("\n")
  }
}
