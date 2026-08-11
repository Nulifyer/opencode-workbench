import { assertEquals } from "jsr:@std/assert"
import type { MessageBundle } from "@opencode-workbench/shared"
import { deriveGoal, deriveGoalHistory } from "../src/application/snapshot-projector.ts"

function goalTool(tool: string, output: unknown, id: string): MessageBundle {
  return {
    info: { id, sessionID: "session", role: "assistant", time: { completed: 1 } },
    parts: [{
      id: `${id}-tool`,
      sessionID: "session",
      messageID: id,
      type: "tool",
      tool,
      state: { status: "completed", output: JSON.stringify(output) },
    }],
  }
}

const archived = {
  id: "session:goal:1",
  sequence: 1,
  objective: "First goal",
  status: "complete",
  tokensUsed: 12_000,
  timeUsedSeconds: 90_000,
  turnsUsed: 8,
  autoTurns: 5,
  createdAt: 1,
  closedAt: 90_001,
}

Deno.test("goal projection retains comparable current and archived metrics", () => {
  const messages = [goalTool("create_goal", {
    goal: {
      id: "session:goal:2",
      sequence: 2,
      objective: "Second goal",
      status: "active",
      tokensUsed: 4_000,
      timeUsedSeconds: 3_700,
      turnsUsed: 3,
      autoTurns: 2,
      createdAt: 90_002,
      sampledAt: 93_702,
      archivedGoals: [archived],
    },
  }, "current")]
  const goal = deriveGoal(messages)
  assertEquals(goal?.sequence, 2)
  assertEquals(goal?.turnsUsed, 3)
  assertEquals(goal?.archivedGoals, [archived])
  assertEquals(deriveGoalHistory(messages), [archived])
})

Deno.test("clearing the current goal leaves archived metrics projected", () => {
  const messages = [goalTool("clear_goal", { cleared: true, archived_goals: [archived] }, "clear")]
  assertEquals(deriveGoal(messages), undefined)
  assertEquals(deriveGoalHistory(messages), [archived])
})
