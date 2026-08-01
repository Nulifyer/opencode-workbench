export function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message)
}

export function equal(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`expected ${right}, got ${left}`)
}

export async function rejects(operation: () => unknown | Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!pattern.test(message)) throw new Error(`expected rejection matching ${pattern}, got ${message}`)
    return
  }
  throw new Error("expected operation to reject")
}
