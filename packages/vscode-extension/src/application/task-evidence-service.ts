export interface TaskProcessEvent<TExecution> {
  execution: TExecution
  exitCode?: number
}

export interface DisposableSubscription {
  dispose(): void
}

export async function executeAndCaptureTask<TExecution>(
  execute: () => PromiseLike<TExecution>,
  subscribe: (listener: (event: TaskProcessEvent<TExecution>) => void) => DisposableSubscription,
  timeoutMilliseconds = 600_000,
): Promise<number | undefined> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 3_600_000) {
    throw new Error("Invalid task evidence timeout")
  }
  return await new Promise<number | undefined>((resolve, reject) => {
    let execution: TExecution | undefined
    let settled = false
    const earlyEvents: TaskProcessEvent<TExecution>[] = []
    const finish = (exitCode?: number, error?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      subscription.dispose()
      if (error !== undefined) reject(error)
      else resolve(exitCode)
    }
    const subscription = subscribe((event) => {
      if (execution === undefined) {
        if (earlyEvents.length < 100) earlyEvents.push(event)
        return
      }
      if (event.execution === execution) finish(event.exitCode)
    })
    const timeout = setTimeout(() => finish(undefined, new Error("Task evidence timed out")), timeoutMilliseconds)
    void execute().then((started) => {
      if (settled) return
      execution = started
      const completed = earlyEvents.find((event) => event.execution === started)
      if (completed) finish(completed.exitCode)
    }, (error) => finish(undefined, error))
  })
}
