export interface ScheduledEventFlush {
  cancel(): void
}

export type EventFlushScheduler = (callback: () => void, delay: number) => ScheduledEventFlush

export interface OrderedEventBusOptions {
  interval?: number
  batchSize?: number
  highWaterMark?: number
  now?: () => number
  schedule?: EventFlushScheduler
  onError?: (error: unknown) => void
}

function timeoutSchedule(callback: () => void, delay: number): ScheduledEventFlush {
  const timer = setTimeout(callback, delay)
  return { cancel: () => clearTimeout(timer) }
}

export class OrderedEventBus<T> {
  private queue: T[] = []
  private head = 0
  private scheduled?: ScheduledEventFlush
  private flushing = false
  private disposed = false
  private lastFlush = Number.NEGATIVE_INFINITY
  private readonly interval: number
  private readonly batchSize: number
  private readonly highWaterMark: number
  private readonly now: () => number
  private readonly schedule: EventFlushScheduler
  private readonly onError?: (error: unknown) => void

  constructor(private readonly handle: (event: T) => void, options: OrderedEventBusOptions = {}) {
    this.interval = Math.max(0, options.interval ?? 16)
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 512))
    this.highWaterMark = Math.max(this.batchSize, Math.floor(options.highWaterMark ?? 4_096))
    this.now = options.now ?? (() => globalThis.performance?.now() ?? Date.now())
    this.schedule = options.schedule ?? timeoutSchedule
    this.onError = options.onError
  }

  emit(event: T): void {
    if (this.disposed) return
    this.queue.push(event)
    if (this.flushing) return
    if (this.buffered >= this.highWaterMark) {
      this.drain(this.batchSize, true)
      return
    }
    if (this.scheduled) return
    const elapsed = this.now() - this.lastFlush
    if (elapsed >= this.interval) {
      this.drain(this.batchSize, true)
      return
    }
    this.scheduleDrain(Math.max(0, this.interval - elapsed))
  }

  flush(): void {
    this.drain(Number.POSITIVE_INFINITY, false)
  }

  discard(): void {
    this.queue = []
    this.head = 0
    this.scheduled?.cancel()
    this.scheduled = undefined
  }

  private get buffered(): number {
    return this.queue.length - this.head
  }

  private scheduleDrain(delay: number): void {
    if (this.disposed || this.scheduled || !this.buffered) return
    this.scheduled = this.schedule(() => {
      this.scheduled = undefined
      this.drain(this.batchSize, true)
    }, delay)
  }

  private drain(limit: number, continueAsynchronously: boolean): void {
    if (this.disposed || this.flushing || !this.buffered) return
    this.scheduled?.cancel()
    this.scheduled = undefined
    this.flushing = true
    let processed = 0
    try {
      while (!this.disposed && this.buffered && processed < limit) {
        const event = this.queue[this.head++]!
        processed += 1
        try {
          this.handle(event)
        } catch (error) {
          try {
            this.onError?.(error)
          } catch {
            // Error reporting must not interrupt lossless queue draining.
          }
        }
      }
    } finally {
      this.flushing = false
      this.lastFlush = this.now()
      if (this.disposed || this.head === this.queue.length) {
        this.queue = []
        this.head = 0
      } else if (this.head >= this.batchSize * 4 && this.head * 2 >= this.queue.length) {
        this.queue = this.queue.slice(this.head)
        this.head = 0
      }
    }
    if (continueAsynchronously && !this.disposed && this.buffered) this.scheduleDrain(0)
  }

  dispose(): void {
    this.disposed = true
    this.discard()
  }
}
