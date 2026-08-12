import { ConnectionCoordinator } from "../src/session/connection-coordinator.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function until(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Condition was not reached")
}

Deno.test("connection coordinator reconnects with a fresh generation and disposes deterministically", async () => {
  let connections = 0
  let opens = 0
  let flushes = 0
  const events: number[] = []
  const coordinator = new ConnectionCoordinator<number>({
    connect: async (signal, opened, event) => {
      connections += 1
      await opened()
      event(connections)
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    },
    flush: () => flushes += 1,
    opened: async () => {
      opens += 1
    },
    event: (event) => events.push(event),
    disconnected: () => undefined,
    error: (error) => {
      throw error
    },
  })
  coordinator.start()
  await until(() => connections === 1 && events.length === 1)
  coordinator.start()
  assert(connections === 1, "start created a duplicate connection")
  coordinator.reconnect()
  await until(() => connections === 2 && events.length === 2)
  coordinator.dispose()
  await Promise.resolve()
  coordinator.start()
  const finalConnections: number = connections
  const finalOpens: number = opens
  assert(
    finalConnections === 2 && finalOpens === 2,
    "Disposed coordinator restarted",
  )
  assert(flushes >= 2, "Connection boundaries did not flush ordered events")
})
