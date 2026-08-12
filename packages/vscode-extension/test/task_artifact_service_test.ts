import { assert, assertEquals, assertThrows } from "jsr:@std/assert"
import type { TaskArtifact } from "@opencode-workbench/shared"
import {
  type NewTaskArtifact,
  TASK_ARTIFACT_CAPACITY,
  TaskArtifactService,
  type TaskArtifactState as PersistedTaskArtifactState,
} from "../src/application/task-artifact-service.ts"

const HASH = `sha256:${"a".repeat(64)}`

function planInput(sessionID = "session-one"): NewTaskArtifact {
  return {
    kind: "plan",
    sessionID,
    lifecycle: "active",
    producer: { sessionID, messageID: `message-${sessionID}` },
    payload: { phase: "ready", uri: `untitled:Plan-${sessionID}.md`, revision: HASH },
  }
}

function fullArtifact(sessionID = "session-one"): TaskArtifact {
  return {
    schemaVersion: 1,
    id: `artifact-${sessionID}`,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...planInput(sessionID),
  } as TaskArtifact
}

Deno.test("task artifacts persist across restart and remain isolated from caller mutation", () => {
  let persisted: PersistedTaskArtifactState | undefined
  const service = new TaskArtifactService(undefined, (state) => {
    persisted = state
  })
  const created = service.create(planInput(), "create-one")
  assert(persisted)

  if (created.kind !== "plan") throw new Error("Expected a plan artifact")
  created.payload.phase = "failed"
  const listed = service.list("session-one")
  if (listed[0]?.kind !== "plan") throw new Error("Expected a plan artifact")
  assertEquals(listed[0].payload.phase, "ready")
  listed[0].payload.phase = "unavailable"
  assertEquals((service.get("session-one", created.id) as TaskArtifact & { kind: "plan" }).payload.phase, "ready")

  const restarted = new TaskArtifactService(persisted)
  assertEquals(restarted.get("session-one", created.id), service.get("session-one", created.id))
  assertEquals(restarted.create(planInput(), "create-one").id, created.id)
  assertEquals(restarted.list().length, 1)
})

Deno.test("task artifacts are keyed by canonical OpenCode session IDs", () => {
  const service = new TaskArtifactService(undefined)
  const first = service.create(planInput("session-one"))
  const second = service.create(planInput("session-two"))
  assertEquals(service.list("session-one").map((artifact) => artifact.id), [first.id])
  assertEquals(service.list("session-two").map((artifact) => artifact.id), [second.id])
  assertEquals(service.get("session-two", first.id), undefined)
})

Deno.test("updates use optimistic revisions and durable mutation idempotency", () => {
  let persisted: PersistedTaskArtifactState | undefined
  const service = new TaskArtifactService(undefined, (state) => {
    persisted = state
  })
  const created = service.create(planInput(), "create")
  let mutations = 0
  const approve = (draft: TaskArtifact): void => {
    mutations += 1
    if (draft.kind !== "plan") throw new Error("Expected plan")
    draft.payload.phase = "approved"
    draft.payload.approvedAt = 20
  }
  const approved = service.update(created.sessionID, created.id, 1, approve, "approve")
  assertEquals(approved.revision, 2)
  assertEquals(service.update(created.sessionID, created.id, 1, approve, "approve").revision, 2)
  assertEquals(mutations, 1)
  assertThrows(() => service.update(created.sessionID, created.id, 1, () => undefined), Error, "stale")
  assertThrows(
    () => service.update(created.sessionID, created.id, 2, () => undefined, "approve"),
    Error,
    "different operation",
  )

  const restarted = new TaskArtifactService(persisted)
  assertEquals(
    restarted.update(created.sessionID, created.id, 1, () => {
      throw new Error("must not run")
    }, "approve").revision,
    2,
  )
})

Deno.test("archive and remove are explicit, revisioned, and idempotent", () => {
  const service = new TaskArtifactService(undefined)
  const created = service.create(planInput())
  const archived = service.archive(created.sessionID, created.id, created.revision, "archive")
  assertEquals(archived.lifecycle, "archived")
  assertEquals(service.archive(created.sessionID, created.id, created.revision, "archive").revision, archived.revision)
  assertThrows(() => service.remove(created.sessionID, created.id, created.revision), Error, "stale")
  assertEquals(service.remove(created.sessionID, created.id, archived.revision, "remove"), true)
  assertEquals(service.remove(created.sessionID, created.id, archived.revision, "remove"), true)
  assertEquals(service.list().length, 0)
})

Deno.test("constructor ignores and reports corrupt records without losing valid artifacts", () => {
  const messages: string[] = []
  const valid = fullArtifact()
  const raw = {
    schemaVersion: 1,
    artifacts: [valid, { ...valid, id: "bad", payload: { ...valid.payload, objective: "not durable" } }, { ...valid }],
    mutations: [{ id: "bad mutation with spaces" }],
  }
  const service = new TaskArtifactService(raw, undefined, (message) => messages.push(message))
  assertEquals(service.list().length, 1)
  assertEquals(service.list()[0]?.id, valid.id)
  assert(messages.some((message) => message.includes("unsupported field objective")))
  assert(messages.some((message) => message.includes("duplicate artifact ID")))
  assert(messages.some((message) => message.includes("mutation")))
})

Deno.test("privacy fields are rejected before persistence", () => {
  let writes = 0
  const service = new TaskArtifactService(undefined, () => {
    writes += 1
  })
  assertThrows(
    () =>
      service.create({
        ...planInput(),
        payload: { ...planInput().payload, objective: "private objective", body: "private Markdown" },
      } as unknown as NewTaskArtifact),
    Error,
    "unsupported field",
  )
  assertThrows(
    () =>
      service.create({
        kind: "context-capture",
        sessionID: "session",
        lifecycle: "active",
        payload: {
          promptID: "prompt",
          receiptID: "context:prompt",
          admittedAt: 1,
          truncation: "none",
          sources: [],
          screenshot: "base64 bytes",
        },
      } as unknown as NewTaskArtifact),
    Error,
    "unsupported field screenshot",
  )
  assertEquals(writes, 0)
  assertEquals(service.list().length, 0)
})

Deno.test("artifact capacity fails closed without silently evicting durable records", () => {
  const initial: PersistedTaskArtifactState = {
    schemaVersion: 1,
    artifacts: Array.from({ length: TASK_ARTIFACT_CAPACITY }, (_, index) => ({
      ...fullArtifact(`session-${index}`),
      id: `artifact-${index}`,
    })),
    mutations: [],
  }
  const service = new TaskArtifactService(initial)
  assertEquals(service.list().length, TASK_ARTIFACT_CAPACITY)
  assertThrows(() => service.create(planInput("overflow")), Error, "capacity")
  assertEquals(service.list().length, TASK_ARTIFACT_CAPACITY)
})
