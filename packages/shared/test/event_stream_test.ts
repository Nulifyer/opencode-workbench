import { createEventEpoch, EventCursor, SequencedEventLog, SurfaceEventQueue } from "../src/event-stream.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test("event log sequences patches with exact base and next revisions", () => {
  const state = { value: 0 }
  const log = new SequencedEventLog("1:epoch", () => state, 10)
  state.value = 1
  const first = log.publishPatch("state.changed", { value: 1 })
  const transient = log.publishTransient(
    "status",
    { busy: true },
    "status:session",
  )
  state.value = 2
  const second = log.publishPatch("state.changed", { value: 2 })
  assert(
    first.sequence === 1 && first.baseRevision === 0 &&
      first.nextRevision === 1,
    "First patch revision is invalid",
  )
  assert(
    transient.sequence === 2 && transient.baseRevision === undefined,
    "Transient event mutated revision",
  )
  assert(
    second.sequence === 3 && second.baseRevision === 1 &&
      second.nextRevision === 2,
    "Second patch revision is invalid",
  )
  assert(
    log.snapshot().revision === 2 && log.snapshot().sequence === 3,
    "Snapshot position drifted",
  )
})

Deno.test("replay falls back to a snapshot when retained history has a gap", () => {
  const state = { value: 0 }
  const log = new SequencedEventLog("1:epoch", () => state, 2)
  for (let value = 1; value <= 4; value += 1) {
    state.value = value
    log.publishPatch("state.changed", { value })
  }
  const recent = log.replay(2)
  assert(
    recent.kind === "replay" &&
      recent.events.map((event) => event.sequence).join(",") === "3,4",
    "Available replay was not returned",
  )
  const stale = log.replay(1)
  assert(
    stale.kind === "snapshot" && stale.snapshot.state.value === 4 &&
      stale.snapshot.revision === 4,
    "Retention gap did not produce current snapshot",
  )
})

Deno.test("event cursor rejects stale epochs and sequence or revision gaps", () => {
  const cursor = new EventCursor()
  cursor.applySnapshot({ epoch: "2:new", sequence: 4, revision: 2, state: {} })
  assert(
    cursor.accept({
      epoch: "1:old",
      sequence: 4,
      throughSequence: 4,
      type: "old",
      payload: {},
    }).kind === "stale-epoch",
    "Reloaded surface accepted prior epoch",
  )
  assert(
    cursor.accept({
      epoch: "2:new",
      sequence: 6,
      throughSequence: 6,
      type: "gap",
      payload: {},
    }).kind === "resync",
    "Sequence gap was accepted",
  )
  assert(
    cursor.accept({
      epoch: "2:new",
      sequence: 5,
      throughSequence: 5,
      type: "patch",
      payload: {},
      baseRevision: 1,
      nextRevision: 2,
    }).kind === "resync",
    "Revision gap was accepted",
  )
  assert(
    cursor.accept({
      epoch: "2:new",
      sequence: 5,
      throughSequence: 5,
      type: "patch",
      payload: {},
      baseRevision: 2,
      nextRevision: 3,
    }).kind === "applied",
    "Contiguous patch was rejected",
  )
})

Deno.test("hidden queue coalesces adjacent transient updates without crossing semantic events", () => {
  const queue = new SurfaceEventQueue(10)
  queue.enqueue({
    epoch: "e",
    sequence: 1,
    throughSequence: 1,
    type: "token",
    payload: "a",
    coalesceKey: "token:item",
  })
  queue.enqueue({
    epoch: "e",
    sequence: 2,
    throughSequence: 2,
    type: "token",
    payload: "ab",
    coalesceKey: "token:item",
  })
  queue.enqueue({
    epoch: "e",
    sequence: 3,
    throughSequence: 3,
    type: "permission",
    payload: {},
    baseRevision: 0,
    nextRevision: 1,
  })
  queue.enqueue({
    epoch: "e",
    sequence: 4,
    throughSequence: 4,
    type: "token",
    payload: "abc",
    coalesceKey: "token:item",
  })
  const drained = queue.drain()
  assert(
    !drained.requiresSnapshot && drained.events.length === 3,
    "Adjacent transient updates were not coalesced",
  )
  assert(
    drained.events[0]?.sequence === 1 &&
      drained.events[0]?.throughSequence === 2 &&
      drained.events[0]?.payload === "ab",
    "Coalesced range is invalid",
  )
  assert(
    drained.events[1]?.type === "permission" &&
      drained.events[2]?.sequence === 4,
    "Coalescing reordered a semantic event",
  )
  const cursor = new EventCursor()
  cursor.applySnapshot({ epoch: "e", sequence: 0, revision: 0, state: {} })
  for (const event of drained.events) {
    assert(
      cursor.accept(event).kind === "applied",
      "Client cursor treated a coalesced sequence range as a gap",
    )
  }
})

Deno.test("hidden surface queues stay bounded under a 20,000-event burst", () => {
  const log = new SequencedEventLog("e", () => ({}), 20_000)
  const queue = new SurfaceEventQueue(32)
  for (let index = 0; index < 20_000; index += 1) {
    queue.enqueue(log.publishTransient("token", { index }, "token:item"))
  }
  assert(
    queue.size === 1 && !queue.requiresSnapshot,
    "Coalescible hidden burst grew without bound",
  )
  queue.enqueue(log.publishPatch("permission", {}))
  for (let index = 0; index < 40; index += 1) {
    queue.enqueue(log.publishTransient(`semantic-${index}`, {}))
  }
  const overflowSize: number = queue.size
  assert(
    overflowSize === 0 && queue.requiresSnapshot,
    "Non-coalescible overflow did not switch to snapshot recovery",
  )
  assert(queue.drain().requiresSnapshot, "Snapshot recovery signal was lost")
})

Deno.test("runtime generations create distinct epochs", () => {
  const first = createEventEpoch(1, "nonce")
  const second = createEventEpoch(2, "nonce")
  assert(
    first !== second && first.startsWith("1:") && second.startsWith("2:"),
    "Runtime generation did not affect epoch",
  )
})
