import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert"
import type { AttentionItem } from "@opencode-workbench/shared"
import {
  ATTENTION_READ_CAPACITY,
  attentionFingerprint,
  AttentionReadService,
} from "../src/application/attention-read-service.ts"

function goalAttention(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "goal:session-one:goal-one",
    kind: "blocked-goal",
    sessionID: "session-one",
    title: "Goal needs attention",
    detail: "Approval required",
    createdAt: 100,
    target: { surface: "goal" },
    ...overrides,
  }
}

Deno.test("attention acknowledgement survives goal timestamp updates but not visible revisions", () => {
  const persisted: unknown[][] = []
  const service = new AttentionReadService(
    [],
    (records) => persisted.push(records),
  )
  const original = goalAttention()

  service.markRead([original], 1_000)
  assertEquals(service.unread([{ ...original, createdAt: 200 }]), [])
  assertEquals(
    service.unread([{
      ...original,
      detail: "Hardware required",
      createdAt: 200,
    }]).length,
    1,
  )
  assertEquals(
    service.unread([{
      ...original,
      id: "goal:session-one:goal-two",
      createdAt: 200,
    }]).length,
    1,
  )
  assertEquals(persisted.length, 1)
  assertEquals(persisted[0]?.length, 1)
})

Deno.test("non-goal attention timestamps identify a new occurrence", () => {
  const item: AttentionItem = {
    id: "failure:session-one",
    kind: "prompt-failure",
    sessionID: "session-one",
    title: "OpenCode session failed",
    detail: "Process exited",
    createdAt: 100,
    target: { surface: "conversation" },
  }
  const service = new AttentionReadService()
  service.markRead([item], 1_000)

  assertEquals(service.unread([item]), [])
  assertEquals(service.unread([{ ...item, createdAt: 101 }]).length, 1)
  assertNotEquals(
    attentionFingerprint(item),
    attentionFingerprint({ ...item, createdAt: 101 }),
  )
})

Deno.test("attention acknowledgement restores valid records and remains bounded", () => {
  const seedItem = goalAttention()
  const seed = {
    id: seedItem.id,
    fingerprint: attentionFingerprint(seedItem),
    readAt: 10,
  }
  const service = new AttentionReadService([
    seed,
    { ...seed, readAt: 5 },
    { id: "bad\nrecord", fingerprint: seed.fingerprint, readAt: 20 },
  ])
  assertEquals(service.unread([seedItem]), [])

  service.markRead(
    Array.from(
      { length: ATTENTION_READ_CAPACITY + 5 },
      (_, index) => goalAttention({ id: `goal:session-one:${index}` }),
    ),
    1_000,
  )
  assertEquals(service.list().length, ATTENTION_READ_CAPACITY)
  assertThrows(() => service.markRead([seedItem], -1), Error, "timestamp")
})
