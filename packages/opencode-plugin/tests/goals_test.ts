import {
  accountGoalTokens,
  cancelGoalAutoContinueReservation,
  clearGoal,
  closeGoal,
  createGoal,
  emptyGoalState,
  failGoalAutoContinue,
  importLegacyGoalState,
  parseGoalState,
  recordGoalCheckpoint,
  refreshGoal,
  reserveGoalAutoContinue,
  setGoalStatus,
  updateGoalObjective,
} from "../src/goals.ts"
import { assert, equal, rejects } from "./assert.ts"

Deno.test("native goals enforce lifecycle evidence and Plan-mode safety", async () => {
  const state = emptyGoalState()
  const planned = createGoal(state, "plan-session", { objective: "Implement the design", agent: "plan" }, 100)
  equal(planned.status, "paused")
  equal(planned.stopReason, "plan mode")
  await rejects(() => Promise.resolve(setGoalStatus(state, "plan-session", "active", "plan", 101)), /Plan mode/)

  const active = updateGoalObjective(state, "plan-session", "Implement and verify the design", "active", "build", 102)
  equal(active.status, "active")
  const checkpoint = recordGoalCheckpoint(state, "plan-session", "Implemented the core and passed focused tests.", 103)
  equal(checkpoint.lastCheckpoint?.summary, "Implemented the core and passed focused tests.")
  await rejects(() => Promise.resolve(closeGoal(state, "plan-session", "complete", undefined, 103)), /Completion evidence/)
  const complete = closeGoal(state, "plan-session", "complete", "Focused tests and package verification passed.", 104)
  equal(complete.status, "complete")
  assert(Boolean(complete.completionEvidence))
})

Deno.test("native goals track token and duration limits", () => {
  const tokenState = emptyGoalState()
  createGoal(tokenState, "token", { objective: "Stay bounded", tokenBudget: 100 }, 10)
  accountGoalTokens(tokenState, "token", 500, 11)
  const tokenLimited = accountGoalTokens(tokenState, "token", 600, 12)
  equal(tokenLimited?.status, "budgetLimited")
  equal(tokenLimited?.tokensUsed, 100)
  assert(tokenLimited?.stopReason?.includes("token budget") === true)

  const timeState = emptyGoalState()
  createGoal(timeState, "time", { objective: "Finish quickly", maxDurationSeconds: 5 }, 20)
  const timeLimited = refreshGoal(timeState, "time", 26)
  equal(timeLimited?.status, "usageLimited")
  equal(timeLimited?.timeUsedSeconds, 6)
})

Deno.test("native goals persistently reserve auto-continuations and pause after admission failure", () => {
  const state = emptyGoalState()
  createGoal(state, "auto", { objective: "Finish without placeholders", maxAutoTurns: 2 }, 10)
  equal(reserveGoalAutoContinue(state, "auto", 11)?.autoTurns, 1)
  equal(cancelGoalAutoContinueReservation(state, "auto", 1, 11)?.autoTurns, 0)
  equal(reserveGoalAutoContinue(state, "auto", 11)?.autoTurns, 1)
  equal(reserveGoalAutoContinue(state, "auto", 12)?.autoTurns, 2)
  equal(reserveGoalAutoContinue(state, "auto", 13), null)
  equal(state.goals.auto?.status, "usageLimited")

  createGoal(state, "failure", { objective: "Stop safely" }, 20)
  reserveGoalAutoContinue(state, "failure", 21)
  const failed = failGoalAutoContinue(state, "failure", "prompt admission was rejected", 22)
  equal(failed?.status, "paused")
  assert(failed?.lastStatus?.includes("prompt admission was rejected") === true)
})

Deno.test("legacy goal state imports into the bounded native schema", () => {
  const imported = importLegacyGoalState({
    version: 1,
    goals: {
      session: {
        sessionID: "session",
        objective: "Continue existing work",
        status: "usageLimited",
        tokenBudget: null,
        tokensUsed: 123,
        timeUsedSeconds: 45,
        createdAt: 1,
        updatedAt: 2,
        lastAccountedAt: null,
        autoTurns: 25,
        maxAutoTurns: null,
        maxDurationSeconds: null,
        lastStatus: "limit reached",
        stopReason: "max auto-continues reached",
        completionEvidence: null,
        blocker: null,
        closedAt: null,
        history: [{ type: "autoContinue", detail: "Auto-continue 25 reserved.", timestamp: 2 }],
        checkpoints: [{ summary: "Tests are passing.", timestamp: 2 }],
      },
    },
  })
  equal(imported?.goals.session?.objective, "Continue existing work")
  equal(imported?.goals.session?.history[0]?.type, "autoContinue")
  equal(imported?.goals.session?.lastCheckpoint?.summary, "Tests are passing.")
  assert(parseGoalState(imported).goals.session !== undefined)
  assert(clearGoal(imported!, "session"))
})
