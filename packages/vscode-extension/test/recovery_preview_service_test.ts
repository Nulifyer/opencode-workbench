import { assertEquals, assertNotStrictEquals, assertThrows } from "jsr:@std/assert"
import type { FileChange, MessageBundle } from "@opencode-workbench/shared"
import {
  RecoveryPreviewGuard,
  type RecoveryPreviewInput,
  RecoveryPreviewService,
} from "../src/application/recovery-preview-service.ts"

function message(id: string, role: "user" | "assistant", text?: string): MessageBundle {
  return {
    info: { id, sessionID: "ses_one", role },
    parts: text === undefined ? [] : [{ id: `part_${id}`, sessionID: "ses_one", messageID: id, type: "text", text }],
  }
}

Deno.test("recovery preview reports the exact transcript tail and conservative current file summaries", () => {
  const messages = [
    message("msg_one", "user", "First"),
    message("msg_two", "assistant"),
    message("msg_three", "user", "Try again"),
    message("msg_four", "assistant"),
  ]
  const changes: FileChange[] = [{
    file: "src/main.ts",
    patch: "not exposed",
    additions: 4,
    deletions: 2,
    status: "modified",
  }]
  const preview = new RecoveryPreviewService().preview({
    sessionID: "ses_one",
    status: { type: "idle" },
    messages,
    changes,
    messageID: "msg_three",
    revertMessageID: "msg_one",
  })

  assertEquals(preview.messageID, "msg_three")
  assertEquals(preview.userText, "Try again")
  assertEquals(preview.removedMessageIDs, ["msg_three", "msg_four"])
  assertEquals(preview.removedTurns, 1)
  assertEquals(preview.changedFiles, [{ file: "src/main.ts", additions: 4, deletions: 2 }])
  assertEquals(preview.canRevert, true)
  assertEquals(preview.canFork, true)
  assertEquals(preview.canRedo, false)
  assertEquals(preview.limitations.length, 2)
  assertNotStrictEquals(preview.changedFiles, changes)
})

Deno.test("recovery preview defaults to the latest user message without mutating the transcript", () => {
  const messages = [
    message("msg_one", "user", "First"),
    message("msg_two", "assistant"),
    message("msg_three", "user", "Latest"),
  ]
  const preview = new RecoveryPreviewService().preview({
    sessionID: "ses_one",
    status: { type: "idle" },
    messages,
    changes: [],
  })

  assertEquals(preview.messageID, "msg_three")
  assertEquals(preview.removedMessageIDs, ["msg_three"])
  assertEquals(preview.canRedo, false)
  assertEquals(messages.length, 3)
  assertEquals(preview.limitations.at(-1), "OpenCode currently reports no changed files for this session.")
})

Deno.test("native redo preview is dedicated to OpenCode's current revert marker", () => {
  const messages = [
    message("msg_one", "user", "Original request"),
    message("msg_two", "assistant", "Original response"),
  ]
  const changes: FileChange[] = [{
    file: "src/main.ts",
    patch: "@@ current",
    additions: 2,
    deletions: 1,
    status: "modified",
  }]
  const service = new RecoveryPreviewService()
  const preview = service.preview({
    sessionID: "ses_one",
    status: { type: "idle" },
    messages,
    changes,
    intent: "redo",
    revertMessageID: "msg_one",
  })

  assertEquals(preview.messageID, "msg_one")
  assertEquals(preview.userText, "Original request")
  assertEquals(preview.removedMessageIDs, [])
  assertEquals(preview.removedTurns, 0)
  assertEquals(preview.canRevert, false)
  assertEquals(preview.canFork, false)
  assertEquals(preview.canRedo, true)
  assertEquals(preview.changedFiles, [{ file: "src/main.ts", additions: 2, deletions: 1 }])
  assertEquals(preview.limitations[0], "Redo is available only while OpenCode reports this native revert marker.")
  assertThrows(
    () => service.preview({ sessionID: "ses_one", status: { type: "idle" }, messages, changes, intent: "redo" }),
    Error,
    "native OpenCode revert marker",
  )
  assertThrows(
    () =>
      service.preview({
        sessionID: "ses_one",
        status: { type: "idle" },
        messages,
        changes,
        intent: "redo",
        messageID: "msg_two",
        revertMessageID: "msg_one",
      }),
    Error,
    "must match",
  )
})

Deno.test("recovery preview validates idle state, user boundaries, and exact projection bounds", () => {
  const service = new RecoveryPreviewService()
  const messages = [message("msg_one", "user"), message("msg_two", "assistant")]
  assertThrows(
    () => service.preview({ sessionID: "ses_one", status: { type: "busy" }, messages, changes: [] }),
    Error,
    "idle",
  )
  assertThrows(
    () =>
      service.preview({ sessionID: "ses_one", status: { type: "idle" }, messages, changes: [], messageID: "msg_two" }),
    Error,
    "user message",
  )
  assertThrows(
    () =>
      service.preview({
        sessionID: "ses_one",
        status: { type: "idle" },
        messages: [messages[0]!, messages[0]!],
        changes: [],
      }),
    Error,
    "unique",
  )
  assertThrows(
    () =>
      service.preview({
        sessionID: "ses_one",
        status: { type: "idle" },
        messages: Array.from({ length: 5_001 }, (_, index) =>
          message(`msg_${index}`, index === 0 ? "user" : "assistant")),
        changes: [],
        messageID: "msg_0",
      }),
    Error,
    "exact-preview limit",
  )
})

Deno.test("recovery confirmations are exact, per-surface, and one-shot", () => {
  const service = new RecoveryPreviewService()
  const guard = new RecoveryPreviewGuard<object>()
  const sidebar = {}
  const editor = {}
  const input: RecoveryPreviewInput = {
    sessionID: "ses_one",
    status: { type: "idle" },
    messages: [message("msg_one", "user", "Do it"), message("msg_two", "assistant", "Done")],
    changes: [{ file: "src/main.ts", patch: "@@ exact", additions: 1, deletions: 0, status: "modified" }],
    messageID: "msg_one",
    revertMessageID: "msg_prior",
  }
  const candidate = { input, preview: service.preview(input) }
  guard.remember(sidebar, candidate)
  guard.remember(editor, candidate)

  assertEquals(guard.consume(sidebar, () => ({ input, preview: service.preview(input) })), candidate.preview)
  assertThrows(() => guard.consume(sidebar, () => candidate), Error, "missing or stale")
  assertEquals(guard.consume(editor, () => candidate).messageID, "msg_one")
})

Deno.test("recovery confirmation rejects transcript, change, and native revert drift", () => {
  const service = new RecoveryPreviewService()
  const base = (): RecoveryPreviewInput => ({
    sessionID: "ses_one",
    status: { type: "idle" },
    messages: [message("msg_one", "user", "Do it"), message("msg_two", "assistant", "Done")],
    changes: [{ file: "src/main.ts", patch: "@@ before", additions: 1, deletions: 0, status: "modified" }],
    messageID: "msg_one",
    revertMessageID: "msg_prior",
  })
  const drifts: Array<(input: RecoveryPreviewInput) => RecoveryPreviewInput> = [
    (input) => ({
      ...input,
      messages: [message("msg_one", "user", "Changed prompt"), message("msg_two", "assistant", "Done")],
    }),
    (input) => ({
      ...input,
      changes: [{ file: "src/main.ts", patch: "@@ after", additions: 1, deletions: 0, status: "modified" }],
    }),
    (input) => ({ ...input, revertMessageID: "msg_other" }),
  ]
  for (const drift of drifts) {
    const guard = new RecoveryPreviewGuard<object>()
    const surface = {}
    const original = base()
    guard.remember(surface, { input: original, preview: service.preview(original) })
    const changed = drift(original)
    assertThrows(
      () => guard.consume(surface, () => ({ input: changed, preview: service.preview(changed) })),
      Error,
      "changed",
    )
    assertThrows(
      () => guard.consume(surface, () => ({ input: original, preview: service.preview(original) })),
      Error,
      "missing or stale",
    )
  }
})

Deno.test("recovery confirmation cannot be switched from recover to native redo", () => {
  const service = new RecoveryPreviewService()
  const guard = new RecoveryPreviewGuard<object>()
  const surface = {}
  const recover: RecoveryPreviewInput = {
    sessionID: "ses_one",
    status: { type: "idle" },
    messages: [message("msg_one", "user", "Do it"), message("msg_two", "assistant", "Done")],
    changes: [],
    intent: "recover",
    messageID: "msg_one",
    revertMessageID: "msg_one",
  }
  guard.remember(surface, { input: recover, preview: service.preview(recover) })
  const redo: RecoveryPreviewInput = { ...recover, intent: "redo" }
  assertThrows(() => guard.consume(surface, () => ({ input: redo, preview: service.preview(redo) })), Error, "changed")
})

Deno.test("failed recovery revalidation consumes a preview after status drift", () => {
  const service = new RecoveryPreviewService()
  const guard = new RecoveryPreviewGuard<object>()
  const surface = {}
  const input: RecoveryPreviewInput = {
    sessionID: "ses_one",
    status: { type: "idle" },
    messages: [message("msg_one", "user", "Do it")],
    changes: [],
  }
  guard.remember(surface, { input, preview: service.preview(input) })
  assertThrows(
    () =>
      guard.consume(surface, (preview) => {
        const changed: RecoveryPreviewInput = { ...input, status: { type: "busy" } }
        return { input: changed, preview: service.preview(changed) }
      }),
    Error,
    "idle",
  )
  assertThrows(
    () => guard.consume(surface, () => ({ input, preview: service.preview(input) })),
    Error,
    "missing or stale",
  )
})
