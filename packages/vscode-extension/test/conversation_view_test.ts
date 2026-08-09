import { assertEquals } from "jsr:@std/assert"
import type { ChatSnapshot, MessageBundle, MessagePart } from "@opencode-workbench/shared"
import { projectConversationTurns } from "../src/webview/views/conversation.ts"

type Session = NonNullable<ChatSnapshot["session"]>

function part(messageID: string, id: string, type: string, extra: Partial<MessagePart> = {}): MessagePart {
  return { id, messageID, sessionID: "session", type, ...extra }
}

function message(id: string, role: "user" | "assistant", parts: MessagePart[], completed?: number): MessageBundle {
  return { info: { id, sessionID: "session", role, time: { created: 1, completed } }, parts }
}

function session(messages: MessageBundle[], revisions: Record<string, number>): Session {
  return {
    id: "session",
    title: "Session",
    draft: "",
    status: { type: "busy" },
    loaded: true,
    loadState: "ready",
    messages,
    messageRevisions: revisions,
  }
}

Deno.test("conversation projection groups turns, coalesces reasoning updates, and identifies final response text", () => {
  const messages = [
    message("preface", "assistant", [part("preface", "preface-text", "text", { text: "Earlier output" })], 2),
    message("prompt", "user", [part("prompt", "prompt-text", "text", { text: "Build it" })], 2),
    message("reason-one", "assistant", [part("reason-one", "r1", "reasoning", { text: "First thought" })], 2),
    message("reason-two", "assistant", [part("reason-two", "r2", "reasoning", { text: "Second thought" })], 2),
    message("answer", "assistant", [part("answer", "answer-text", "text", { text: "Done" })], 2),
    message("next", "user", [part("next", "next-text", "text", { text: "Continue" })], 2),
    message("tool", "assistant", [part("tool", "tool-call", "tool", { tool: "bash", state: { status: "running" } })]),
  ]
  const projected = projectConversationTurns(session(messages, Object.fromEntries(messages.map((entry, index) => [entry.info.id, index + 1]))), true)

  assertEquals(projected.map((turn) => turn.key), ["assistant:preface", "user:prompt", "user:next"])
  assertEquals(projected[0]?.assistantOnly, true)
  assertEquals(projected[1]?.displayEntries.map((entry) => entry.message.info.id), ["prompt", "thoughts:reason-one:reason-two:2", "answer"])
  assertEquals(projected[1]?.displayEntries[1]?.message.parts.map((entry) => entry.id), ["r1", "r2"])
  assertEquals(projected[1]?.hasActivity, true)
  assertEquals(projected[1]?.finalTextPartKeys, ["answer:answer-text"])
  assertEquals(projected[1]?.working, false)
  assertEquals(projected[2]?.working, true)
  assertEquals(projected[2]?.displayEntries.at(-1)?.live, true)
})

Deno.test("conversation projection keeps reasoning separated by output and respects inactive streaming state", () => {
  const messages = [
    message("prompt", "user", [part("prompt", "prompt-text", "text", { text: "Explain" })], 2),
    message("reason-one", "assistant", [part("reason-one", "r1", "reasoning", { text: "First" })], 2),
    message("middle", "assistant", [part("middle", "middle-text", "text", { text: "Update" })], 2),
    message("reason-two", "assistant", [part("reason-two", "r2", "reasoning", { text: "Second" })]),
  ]
  const projected = projectConversationTurns(session(messages, { prompt: 1, "reason-one": 2, middle: 3, "reason-two": 4 }), false)

  assertEquals(projected.length, 1)
  assertEquals(projected[0]?.displayEntries.map((entry) => entry.message.info.id), ["prompt", "reason-one", "middle", "reason-two"])
  assertEquals(projected[0]?.displayEntries.some((entry) => entry.live), false)
  assertEquals(projected[0]?.working, false)
  assertEquals(projected[0]?.finalTextPartKeys, [])
})
