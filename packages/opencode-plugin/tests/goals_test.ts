import {
  accountGoalTokens,
  cancelGoalAutoContinueReservation,
  clearGoal,
  closeGoal,
  commitGoalContinuation,
  configureGoalVerification,
  createGoal,
  emptyGoalState,
  failGoalAutoContinue,
  importLegacyGoalState,
  pauseGoalContinuationRecovery,
  parseGoalState,
  recordGoalCheckpoint,
  recordGoalVerdict,
  refreshGoal,
  reserveGoalAutoContinue,
  setGoalStatus,
  snapshotGoal,
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
  const first = reserveGoalAutoContinue(state, "auto", 11, "prt_first", "msg_first")
  equal(first?.autoTurns, 1)
  equal(first?.pendingContinuationID, "prt_first")
  equal(first?.pendingContinuationMessageID, "msg_first")
  const repeated = reserveGoalAutoContinue(state, "auto", 12, "prt_duplicate", "msg_duplicate")
  equal(repeated?.autoTurns, 1)
  equal(repeated?.pendingContinuationID, "prt_first")
  equal(repeated?.pendingContinuationMessageID, "msg_first")
  equal(state.goals.auto?.history.filter((entry) => entry.type === "autoContinue").length, 1)
  equal(cancelGoalAutoContinueReservation(state, "auto", 1, 11)?.autoTurns, 0)
  equal(reserveGoalAutoContinue(state, "auto", 11)?.autoTurns, 1)
  commitGoalContinuation(state, "auto", 12)
  equal(reserveGoalAutoContinue(state, "auto", 12)?.autoTurns, 2)
  commitGoalContinuation(state, "auto", 13)
  equal(reserveGoalAutoContinue(state, "auto", 13), null)
  equal(state.goals.auto?.status, "usageLimited")

  createGoal(state, "failure", { objective: "Stop safely" }, 20)
  reserveGoalAutoContinue(state, "failure", 21)
  const failed = failGoalAutoContinue(state, "failure", "prompt admission was rejected", 22)
  equal(failed?.status, "paused")
  assert(failed?.lastStatus?.includes("prompt admission was rejected") === true)

  createGoal(state, "recovery", { objective: "Recover conservatively" }, 30)
  reserveGoalAutoContinue(state, "recovery", 31, "prt_recovery")
  const recovery = pauseGoalContinuationRecovery(state, "recovery", "transcript unavailable", 32)
  equal(recovery?.status, "paused")
  equal(recovery?.pendingContinuation, false)
  equal(recovery?.autoTurns, 1)
  assert(recovery?.lastStatus?.includes("explicitly resume") === true)
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
  equal(imported?.version, 2)
  assert(parseGoalState(imported).goals.session !== undefined)
  assert(clearGoal(imported!, "session"))
})

Deno.test("goal schema v2 tracks criteria, evidence, repeated blocks, and settlement continuation", () => {
  const state = emptyGoalState()
  createGoal(state, "session", { objective: "Ship it", acceptanceCriteria: ["Tests pass"], verifier: { enabled: true, repeatedBlockThreshold: 2 }, planReference: "plan:1" }, 1)
  configureGoalVerification(state, "session", { runGroupReference: "group" }, 2)
  const first = recordGoalVerdict(state, "session", { verdict: "blocked", reason: "Test fails", missingCriteria: ["Tests pass"], confidence: "high" }, ["evidence:1"], 3)
  equal(first.status, "active")
  equal(first.consecutiveBlockedVerdicts, 1)
  const second = recordGoalVerdict(state, "session", { verdict: "blocked", reason: "Test still fails", missingCriteria: ["Tests pass"], confidence: "high" }, ["evidence:2"], 4)
  equal(second.status, "unmet")
  equal(second.evidenceReferences.length, 2)
  const continuationState = emptyGoalState()
  createGoal(continuationState, "continue", { objective: "Continue" }, 1)
  equal(recordGoalVerdict(continuationState, "continue", { verdict: "continue", reason: "More work remains", missingCriteria: [], confidence: "high" }, [], 2).pendingContinuation, false)
  equal(reserveGoalAutoContinue(continuationState, "continue", 2)?.pendingContinuation, true)
  equal(commitGoalContinuation(continuationState, "continue", 3)?.pendingContinuation, false)
})

Deno.test("goal verdict rejects a stale settlement generation atomically", async () => {
  const state = emptyGoalState()
  const created = createGoal(state, "session", { objective: "Ship it" }, 1)
  configureGoalVerification(state, "session", { acceptanceCriteria: ["Tests pass"] }, 2)
  await rejects(
    () => recordGoalVerdict(state, "session", { verdict: "complete", reason: "Old result", missingCriteria: [], confidence: "high" }, [], 3, created.settlementGeneration),
    /stale/,
  )
  equal(snapshotGoal(state.goals.session!, 3).latestVerdict, null)
})

Deno.test("goal configuration updates limits and independent verifier settings", () => {
  const state = emptyGoalState()
  createGoal(state, "configured", { objective: "Verify every criterion" }, 1)
  const configured = configureGoalVerification(state, "configured", {
    acceptanceCriteria: ["Synthetic tests pass", "No diagnostics remain"],
    tokenBudget: 2_000,
    maxAutoTurns: 4,
    maxDurationSeconds: 600,
    verifier: { enabled: true, model: "provider/model", agent: "plan", timeoutMilliseconds: 45_000, repeatedBlockThreshold: 3 },
  }, 2)
  equal(configured.tokenBudget, 2_000)
  equal(configured.maxAutoTurns, 4)
  equal(configured.maxDurationSeconds, 600)
  equal(configured.acceptanceCriteria.length, 2)
  equal(configured.verifier.model, "provider/model")
  equal(configured.verifier.repeatedBlockThreshold, 3)

  const unlimited = configureGoalVerification(state, "configured", { tokenBudget: null, maxAutoTurns: null, maxDurationSeconds: null }, 3)
  equal(unlimited.tokenBudget, null)
  equal(unlimited.maxAutoTurns, null)
  equal(unlimited.maxDurationSeconds, null)
})

Deno.test("goal verifier generation advances whenever verifier inputs or settlement state change", () => {
  const state = emptyGoalState()
  let goal = createGoal(state, "generation", { objective: "Original", acceptanceCriteria: ["Original criterion"] }, 1)
  const createdGeneration = goal.settlementGeneration
  goal = updateGoalObjective(state, "generation", "Updated", "active", "build", 2)
  assert(goal.settlementGeneration > createdGeneration)
  const objectiveGeneration = goal.settlementGeneration
  goal = configureGoalVerification(state, "generation", { acceptanceCriteria: ["Updated criterion"] }, 3)
  assert(goal.settlementGeneration > objectiveGeneration)
  const configurationGeneration = goal.settlementGeneration
  goal = recordGoalCheckpoint(state, "generation", "Evidence changed", 4)
  assert(goal.settlementGeneration > configurationGeneration)
  const checkpointGeneration = goal.settlementGeneration
  goal = setGoalStatus(state, "generation", "paused", "build", 5)
  assert(goal.settlementGeneration > checkpointGeneration)
})
