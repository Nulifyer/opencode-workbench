import { assertEquals } from "jsr:@std/assert"
import type { MessageBundle, SessionStatus } from "@opencode-workbench/shared"
import { assistantTurnFailed, sessionTurnOutcome } from "../src/application/session-turn-outcome.ts"

function messages(assistant?: Partial<MessageBundle["info"]>, parts: MessageBundle["parts"] = []): MessageBundle[] {
  return [
    { info: { id: "user", sessionID: "session", role: "user" }, parts: [] },
    ...(assistant
      ? [{ info: { id: "assistant", sessionID: "session", role: "assistant" as const, ...assistant }, parts }]
      : []),
  ]
}

Deno.test("session turn outcome distinguishes sparse idle, missing, active, completed, and failed turns", () => {
  assertEquals(sessionTurnOutcome(undefined, false, []), { state: "missing" })
  assertEquals(sessionTurnOutcome(undefined, true, messages()), { state: "active" })
  assertEquals(sessionTurnOutcome({ type: "busy" }, true, messages({ error: { message: "late" } })), {
    state: "active",
  })
  assertEquals(
    sessionTurnOutcome(
      undefined,
      true,
      messages({}, [{ id: "part", sessionID: "session", messageID: "assistant", type: "text", text: "done" }]),
    ),
    { state: "completed" },
  )
  assertEquals(sessionTurnOutcome({ type: "idle" }, true, messages({ error: { name: "ProviderError" } })), {
    state: "failed",
  })
  assertEquals(
    sessionTurnOutcome({ type: "error", message: "secret provider error" } as SessionStatus, true, messages()),
    { state: "failed" },
  )
  assertEquals(assistantTurnFailed(messages({ error: { name: "ProviderError" } })), true)
})
