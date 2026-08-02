export interface ScheduledUpdate {
  cancel(): void
}

export type UpdateScheduler = (callback: () => void) => ScheduledUpdate

export function timeoutScheduler(delay = 50): UpdateScheduler {
  return (callback) => {
    const timer = setTimeout(callback, delay)
    return { cancel: () => clearTimeout(timer) }
  }
}

export class LatestUpdatePump<T> {
  private scheduled?: ScheduledUpdate
  private running = false
  private dirty = false
  private disposed = false

  constructor(
    private readonly read: () => T,
    private readonly publish: (value: T) => Promise<void>,
    private readonly schedule: UpdateScheduler = timeoutScheduler(),
  ) {}

  request(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.running || this.scheduled) return
    this.scheduled = this.schedule(() => {
      this.scheduled = undefined
      void this.flush()
    })
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.running || !this.dirty) return
    this.running = true
    this.dirty = false
    try {
      await this.publish(this.read())
    } catch {
      // Webviews can disappear while a publication is in flight. A later update resynchronizes visible surfaces.
    } finally {
      this.running = false
      if (this.dirty) this.request()
    }
  }

  dispose(): void {
    this.disposed = true
    this.dirty = false
    this.scheduled?.cancel()
    this.scheduled = undefined
  }
}
