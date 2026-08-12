import { assertEquals } from "jsr:@std/assert"
import { observeRunMessages } from "../src/application/run-observation-service.ts"

Deno.test("run observations expose only reliable usage, cost, summary, and goal state", () => {
  const observation = observeRunMessages([
    {
      info: { id: "goal", sessionID: "s", role: "assistant" },
      parts: [{
        id: "tool",
        sessionID: "s",
        messageID: "goal",
        type: "tool",
        tool: "record_goal_verdict",
        state: { output: JSON.stringify({ goal: { status: "complete", latestVerdict: { verdict: "complete" } } }) },
      }],
    },
    {
      info: {
        id: "answer",
        sessionID: "s",
        role: "assistant",
        tokens: { input: 10, output: 5, cache: { read: 2 } },
        cost: 0.25,
      },
      parts: [{ id: "text", sessionID: "s", messageID: "answer", type: "text", text: "Implemented and tested." }],
    },
  ])
  assertEquals(observation, {
    tokens: 17,
    cost: 0.25,
    verifierState: "complete / complete",
    assistantSummary: "Implemented and tested.",
  })
})

Deno.test("run observations leave unavailable metrics unknown", () => {
  assertEquals(observeRunMessages([]), {
    tokens: undefined,
    cost: undefined,
    verifierState: undefined,
    assistantSummary: undefined,
  })
})
