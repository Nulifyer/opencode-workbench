import { assertEquals, assertRejects } from "jsr:@std/assert"
import type { MessageBundle } from "@opencode-workbench/shared"
import { createOpenCodeGoalVerifierInvocation, type OpenCodeGoalVerifierRuntime } from "../src/application/goal-verifier-invocation.ts"
import { GoalVerifierInvocationError } from "../src/application/goal-verifier-service.ts"

function assistantMessages(parts: MessageBundle["parts"] = []): MessageBundle[] {
  return [{ info: { id: "user", sessionID: "verifier-session", role: "user" }, parts: [] }, {
    info: {
      id: "assistant",
      sessionID: "verifier-session",
      role: "assistant",
      providerID: "provider",
      modelID: "actual-model",
      cost: 0.25,
      structured: { verdict: "complete", reason: "Verified", missingCriteria: [], confidence: "high" },
    },
    parts: [{ id: "finish", sessionID: "verifier-session", messageID: "assistant", type: "step-finish", tokens: { input: 2, output: 3, reasoning: 5, cache: { read: 7, write: 11 } } }, ...parts],
  }]
}

function runtime(overrides: Partial<OpenCodeGoalVerifierRuntime> = {}): OpenCodeGoalVerifierRuntime {
  return {
    createSession: () => Promise.resolve({ id: "verifier-session" }),
    sendStructuredPrompt: () => Promise.resolve(),
    sessionStatuses: () => Promise.resolve({ "verifier-session": { type: "idle" } }),
    listSessions: () => Promise.resolve([{ id: "verifier-session" }]),
    messages: () => Promise.resolve(assistantMessages()),
    abort: () => Promise.resolve(true),
    ...overrides,
  }
}

Deno.test("OpenCode verifier invocation preserves schema, tool-free agent defaults, and usage metadata", async () => {
  let sent: { sessionID: string; prompt: string; agent?: string; model?: string; schema?: Record<string, unknown>; retryCount?: number } | undefined
  let aborts = 0
  const schema = { type: "object" }
  const invoke = createOpenCodeGoalVerifierInvocation(() => runtime({
    sendStructuredPrompt: (sessionID, prompt, input) => {
      sent = { sessionID, prompt, ...input }
      return Promise.resolve()
    },
    abort: () => { aborts++; return Promise.resolve(true) },
  }), 0)
  const result = await invoke("Evidence only", schema, new AbortController().signal, { model: "provider/fallback" })

  assertEquals(sent, { sessionID: "verifier-session", prompt: "Evidence only", agent: "plan", model: "provider/fallback", schema, retryCount: 2 })
  assertEquals(result.output, { verdict: "complete", reason: "Verified", missingCriteria: [], confidence: "high" })
  assertEquals(result.metadata, { sessionID: "verifier-session", model: "provider/actual-model", tokens: 28, cost: 0.25 })
  assertEquals(aborts, 0)
})

Deno.test("OpenCode verifier invocation rejects tool use and interrupts the isolated session", async () => {
  let aborts = 0
  const invoke = createOpenCodeGoalVerifierInvocation(() => runtime({
    messages: () => Promise.resolve(assistantMessages([{ id: "tool", sessionID: "verifier-session", messageID: "assistant", type: "tool", tool: "read" }])),
    abort: () => { aborts++; return Promise.resolve(true) },
  }), 0)
  const error = await assertRejects(() => invoke("Evidence only", {}, new AbortController().signal), GoalVerifierInvocationError, "forbidden tool")

  assertEquals(error.metadata, { sessionID: "verifier-session", model: "provider/actual-model", tokens: 28, cost: 0.25 })
  assertEquals(aborts, 1)
})

Deno.test("OpenCode verifier keeps polling through a sparse post-admission status gap", async () => {
  let reads = 0
  let aborts = 0
  const invoke = createOpenCodeGoalVerifierInvocation(() => runtime({
    sessionStatuses: () => Promise.resolve({}),
    messages: () => Promise.resolve(++reads === 1
      ? [{ info: { id: "user", sessionID: "verifier-session", role: "user" }, parts: [] }]
      : assistantMessages()),
    abort: () => { aborts++; return Promise.resolve(true) },
  }), 0)

  const result = await invoke("Evidence only", {}, new AbortController().signal)
  assertEquals(result.output, { verdict: "complete", reason: "Verified", missingCriteria: [], confidence: "high" })
  assertEquals(reads, 2)
  assertEquals(aborts, 0)
})

Deno.test("OpenCode verifier fails a missing admitted session without waiting for timeout", async () => {
  let aborts = 0
  const invoke = createOpenCodeGoalVerifierInvocation(() => runtime({
    sessionStatuses: () => Promise.resolve({}),
    listSessions: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    abort: () => { aborts++; return Promise.resolve(true) },
  }), 0)
  await assertRejects(() => invoke("Evidence only", {}, new AbortController().signal), GoalVerifierInvocationError, "no longer exists")
  assertEquals(aborts, 1)
})

Deno.test("an immediate structured-prompt rejection cleans up ambiguous admission", async () => {
  const controller = new AbortController()
  let aborts = 0
  const invoke = createOpenCodeGoalVerifierInvocation(() => runtime({
    sendStructuredPrompt: () => Promise.reject(new Error("prompt response disconnected")),
    abort: () => { aborts++; return Promise.resolve(true) },
  }), 0)

  await assertRejects(() => invoke("Evidence only", {}, controller.signal), GoalVerifierInvocationError, "invocation failed")
  assertEquals(aborts, 1)
  controller.abort(new Error("late cancellation"))
  await Promise.resolve()
  assertEquals(aborts, 1)
})

Deno.test("aborting an ambiguously admitted verifier prompt interrupts its session exactly once", async () => {
  const controller = new AbortController()
  let admissions = 0
  let aborts = 0
  const invoke = createOpenCodeGoalVerifierInvocation(() => runtime({
    sendStructuredPrompt: () => {
      admissions++
      controller.abort(new Error("cancelled"))
      return Promise.reject(new Error("prompt response disconnected"))
    },
    abort: () => { aborts++; return Promise.resolve(true) },
  }), 0)

  await assertRejects(() => invoke("Evidence only", {}, controller.signal), GoalVerifierInvocationError, "cancelled")
  assertEquals(admissions, 1)
  assertEquals(aborts, 1)
})
