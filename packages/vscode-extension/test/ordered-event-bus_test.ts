import { type EventFlushScheduler, OrderedEventBus } from "../src/ordered-event-bus.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test("ordered event bus drains large bursts in FIFO order without dropping events", () => {
  const callbacks: Array<() => void> = []
  const schedule: EventFlushScheduler = (callback) => {
    callbacks.push(callback)
    return {
      cancel: () => {
        const index = callbacks.indexOf(callback)
        if (index >= 0) callbacks.splice(index, 1)
      },
    }
  }
  const handled: number[] = []
  const errors: unknown[] = []
  let now = 100
  const bus = new OrderedEventBus<number>((event) => {
    handled.push(event)
    if (event === 5_000) throw new Error("isolated handler failure")
  }, { now: () => now, schedule, onError: (error) => errors.push(error) })

  bus.emit(0)
  now += 1
  for (let event = 1; event < 20_000; event += 1) bus.emit(event)
  assert(callbacks.length <= 1, "Burst scheduled parallel event flushes")
  bus.flush()

  assert(handled.length === 20_000, `Event bus dropped events: handled ${handled.length}`)
  assert(handled.every((event, index) => event === index), "Event bus reordered a burst")
  assert(errors.length === 1, "One handler failure stopped or duplicated the burst")
  bus.dispose()
})

Deno.test("ordered event bus drains reentrant events after earlier queued events", () => {
  const callbacks: Array<() => void> = []
  const handled: number[] = []
  let now = 100
  let bus!: OrderedEventBus<number>
  bus = new OrderedEventBus<number>((event) => {
    handled.push(event)
    if (event === 1) bus.emit(3)
  }, {
    now: () => now,
    schedule: (callback) => {
      callbacks.push(callback)
      return {
        cancel: () => {
          const index = callbacks.indexOf(callback)
          if (index >= 0) callbacks.splice(index, 1)
        },
      }
    },
  })

  bus.emit(0)
  handled.length = 0
  now += 1
  bus.emit(1)
  bus.emit(2)
  callbacks.shift()!()
  assert(handled.join(",") === "1,2,3", "Reentrant events bypassed earlier queued events")
  bus.dispose()
})

Deno.test("ordered event bus isolates a throwing error reporter", () => {
  const handled: number[] = []
  const bus = new OrderedEventBus<number>((event) => {
    handled.push(event)
    if (event === 2) throw new Error("handler failed")
  }, {
    interval: 1_000,
    onError: () => {
      throw new Error("reporter failed")
    },
  })

  bus.emit(1)
  bus.emit(2)
  bus.emit(3)
  bus.flush()
  assert(handled.join(",") === "1,2,3", "Throwing error reporter dropped the detached batch")
  bus.dispose()
})

Deno.test("ordered event bus stops a detached batch on reentrant disposal", () => {
  const handled: number[] = []
  let bus!: OrderedEventBus<number>
  bus = new OrderedEventBus<number>((event) => {
    handled.push(event)
    if (event === 2) bus.dispose()
  }, { interval: 1_000 })

  bus.emit(1)
  bus.emit(2)
  bus.emit(3)
  bus.flush()
  assert(handled.join(",") === "1,2", "Disposed event bus continued mutating state")
})

Deno.test("ordered event bus yields large automatic drains in bounded batches", () => {
  const callbacks: Array<() => void> = []
  const handled: number[] = []
  let now = 100
  const bus = new OrderedEventBus<number>((event) => handled.push(event), {
    batchSize: 3,
    highWaterMark: 20,
    now: () => now,
    schedule: (callback) => {
      callbacks.push(callback)
      return {
        cancel: () => {
          const index = callbacks.indexOf(callback)
          if (index >= 0) callbacks.splice(index, 1)
        },
      }
    },
  })

  bus.emit(0)
  handled.length = 0
  now += 1
  for (let event = 1; event <= 8; event += 1) bus.emit(event)
  callbacks.shift()!()
  assert(handled.join(",") === "1,2,3" && callbacks.length === 1, "Automatic drain did not yield after its batch limit")
  callbacks.shift()!()
  assert(handled.join(",") === "1,2,3,4,5,6" && callbacks.length === 1, "Second drain did not preserve FIFO batching")
  callbacks.shift()!()
  assert(handled.join(",") === "1,2,3,4,5,6,7,8" && Number(callbacks.length) === 0, "Final drain omitted queued events")
  bus.dispose()
})

Deno.test("ordered event bus discards stale work without disabling future events", () => {
  const handled: number[] = []
  let now = 100
  const callbacks: Array<() => void> = []
  const bus = new OrderedEventBus<number>((event) => handled.push(event), {
    now: () => now,
    schedule: (callback) => {
      callbacks.push(callback)
      return {
        cancel: () => {
          const index = callbacks.indexOf(callback)
          if (index >= 0) callbacks.splice(index, 1)
        },
      }
    },
  })

  bus.emit(0)
  now += 1
  bus.emit(1)
  bus.discard()
  assert(callbacks.length === 0, "Discard retained a scheduled stale flush")
  now += 20
  bus.emit(2)
  assert(handled.join(",") === "0,2", "Discard processed stale events or disabled the bus")
  bus.dispose()
})
