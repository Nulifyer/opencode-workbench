import { LatestUpdatePump, type UpdateScheduler } from "../src/latest-update-pump.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => resolve = done)
  return { promise, resolve }
}

Deno.test("latest update pump coalesces bursts and publishes one trailing update", async () => {
  const callbacks: Array<() => void> = []
  const schedule: UpdateScheduler = (callback) => {
    callbacks.push(callback)
    return { cancel: () => callbacks.splice(callbacks.indexOf(callback), 1) }
  }
  const first = deferred()
  let value = 0
  const published: number[] = []
  const pump = new LatestUpdatePump(
    () => value,
    async (next) => {
      published.push(next)
      if (next === 3) await first.promise
    },
    schedule,
  )

  value = 1
  pump.request()
  value = 2
  pump.request()
  value = 3
  pump.request()
  assert(callbacks.length === 1, "Burst scheduled more than one publication")
  callbacks.shift()!()
  await Promise.resolve()
  assert(published.join(",") === "3", "Pump did not read the latest value")

  value = 4
  pump.request()
  value = 5
  pump.request()
  assert(Number(callbacks.length) === 0, "Pump scheduled a parallel publication")
  first.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert(callbacks.length === 1, "Pump omitted the trailing publication")
  callbacks.shift()!()
  await Promise.resolve()
  assert(published.join(",") === "3,5", "Trailing publication was not the latest value")
  pump.dispose()
})

Deno.test("latest update pump cancels scheduled work on disposal", () => {
  const callbacks: Array<() => void> = []
  const pump = new LatestUpdatePump(
    () => 1,
    async () => undefined,
    (callback) => {
      callbacks.push(callback)
      return { cancel: () => callbacks.splice(callbacks.indexOf(callback), 1) }
    },
  )
  pump.request()
  pump.dispose()
  assert(callbacks.length === 0, "Disposal retained scheduled work")
})
