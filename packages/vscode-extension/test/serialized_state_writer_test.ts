import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert"
import { SerializedStateWriter } from "../src/application/serialized-state-writer.ts"

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => resolve = done)
  return { promise, resolve }
}

Deno.test("serialized state writes preserve invocation order and snapshot queued values", async () => {
  const first = deferred()
  const writes: Array<{ key: string; value: unknown }> = []
  let active = 0
  let maximumActive = 0
  const writer = new SerializedStateWriter(async (key, value) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    writes.push({ key, value })
    if (key === "first") await first.promise
    active -= 1
  })

  const firstValue = { nested: { count: 1 } }
  const secondValue = [{ id: "original" }]
  writer.write("first", firstValue)
  firstValue.nested.count = 99
  writer.write("second", secondValue)
  secondValue[0]!.id = "mutated"

  await Promise.resolve()
  assertEquals(writes, [{ key: "first", value: { nested: { count: 1 } } }])
  first.resolve()
  await writer.flush()

  assertEquals(maximumActive, 1)
  assertEquals(writes, [
    { key: "first", value: { nested: { count: 1 } } },
    { key: "second", value: [{ id: "original" }] },
  ])
})

Deno.test("flush surfaces drained failures without poisoning later writes", async () => {
  const attempted: string[] = []
  const writer = new SerializedStateWriter(async (key) => {
    attempted.push(key)
    if (key === "failure") throw new Error("persistence failed")
  })

  writer.write("failure", 1)
  writer.write("still-runs", 2)
  await assertRejects(() => writer.flush(), Error, "persistence failed")
  assertEquals(attempted, ["failure", "still-runs"])

  writer.write("recovered", 3)
  await writer.flush()
  await writer.flush()
  assertEquals(attempted, ["failure", "still-runs", "recovered"])
})

Deno.test("dispose drains queued state and rejects new writes", async () => {
  const durability = deferred()
  const persisted: string[] = []
  const writer = new SerializedStateWriter(async (key) => {
    await durability.promise
    persisted.push(key)
  })
  writer.write("queued", { value: true })

  let disposed = false
  const disposal = writer.dispose().then(() => disposed = true)
  await Promise.resolve()
  assertEquals(disposed, false)
  assertThrows(
    () => writer.write("late", null),
    Error,
    "disposed",
  )

  durability.resolve()
  await disposal
  assertEquals(persisted, ["queued"])
})

Deno.test("non-serializable state is rejected before it reaches the queue", async () => {
  let updates = 0
  const writer = new SerializedStateWriter(() => {
    updates++
  })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic

  assertThrows(
    () => writer.write("cyclic", cyclic),
    TypeError,
    "JSON-serializable",
  )
  await writer.flush()
  assertEquals(updates, 0)
})
