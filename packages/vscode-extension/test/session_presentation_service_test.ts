import { assertEquals, assertNotStrictEquals, assertRejects, assertThrows } from "jsr:@std/assert"
import { SESSION_PIN_CAPACITY, SessionPresentationService } from "../src/application/session-presentation-service.ts"

Deno.test("session presentation restores only strictly valid cloned pin records", () => {
  const initial: unknown[] = [
    { sessionID: "ses_one", pinnedAt: 10 },
    { sessionID: "ses_one", pinnedAt: 20 },
    { sessionID: " spaced ", pinnedAt: 30 },
    { sessionID: "ses_bad", pinnedAt: -1 },
    { sessionID: "ses_fraction", pinnedAt: 1.5 },
    { sessionID: "ses_two", pinnedAt: 15, archived: true, shared: true },
  ]
  const service = new SessionPresentationService(initial)

  const pins = service.list()
  assertEquals(pins, [
    { sessionID: "ses_one", pinnedAt: 20 },
    { sessionID: "ses_two", pinnedAt: 15 },
  ])
  assertNotStrictEquals(pins, service.list())
  pins[0]!.pinnedAt = 0
  assertEquals(service.list()[0]!.pinnedAt, 20)
})

Deno.test("session presentation persists pin mutations and authoritative reconciliation", async () => {
  const persisted: Array<Array<{ sessionID: string; pinnedAt: number }>> = []
  const service = new SessionPresentationService([], (pins) => {
    persisted.push(pins.map((pin) => ({ ...pin })))
    pins.splice(0)
  })

  assertEquals(service.pin("ses_first", 10), { sessionID: "ses_first", pinnedAt: 10 })
  service.pin("ses_second", 20)
  assertEquals(service.unpin("ses_missing"), false)
  assertEquals(service.reconcile(["ses_second", "ses_third"]), [{ sessionID: "ses_second", pinnedAt: 20 }])
  await service.flush()

  assertEquals(persisted, [
    [{ sessionID: "ses_first", pinnedAt: 10 }],
    [{ sessionID: "ses_second", pinnedAt: 20 }, { sessionID: "ses_first", pinnedAt: 10 }],
    [{ sessionID: "ses_second", pinnedAt: 20 }],
  ])
  assertEquals(service.list(), [{ sessionID: "ses_second", pinnedAt: 20 }])
})

Deno.test("session presentation enforces the 500-record capacity by retaining newest pins", () => {
  const service = new SessionPresentationService(
    Array.from({ length: SESSION_PIN_CAPACITY + 5 }, (_, index) => ({ sessionID: `ses_${index}`, pinnedAt: index })),
  )
  assertEquals(service.list().length, SESSION_PIN_CAPACITY)
  assertEquals(service.list().at(-1), { sessionID: "ses_5", pinnedAt: 5 })

  service.pin("ses_new", 10_000)
  assertEquals(service.list().length, SESSION_PIN_CAPACITY)
  assertEquals(service.list()[0], { sessionID: "ses_new", pinnedAt: 10_000 })
  assertEquals(service.list().some((pin) => pin.sessionID === "ses_5"), false)
})

Deno.test("session presentation rejects unsafe mutation input and reports persistence failures", async () => {
  const service = new SessionPresentationService([], () => Promise.reject(new Error("storage unavailable")))
  assertThrows(() => service.pin(" bad", 1), Error, "Invalid session ID")
  assertThrows(() => service.pin("ses_ok", Number.NaN), Error, "timestamp")
  assertThrows(() => service.reconcile(["ses_ok", "bad/id"]), Error, "Invalid session ID")
  service.pin("ses_ok", 1)
  await assertRejects(() => service.flush(), Error, "storage unavailable")
})
