import { assertEquals, assertRejects } from "jsr:@std/assert"
import { boundedVerifierEvidence, GoalVerifierService } from "../src/application/goal-verifier-service.ts"

Deno.test("independent verifier is bounded, schema-driven, and evidence-only", async () => {
  let observed = ""
  const verifier = new GoalVerifierService(async (prompt) => {
    observed = prompt
    return { verdict: "complete", reason: "All deterministic checks passed", missingCriteria: [], confidence: "high" }
  })
  const result = await verifier.verify({
    objective: "Ship",
    acceptanceCriteria: ["Tests pass"],
    evidence: [{ id: "e", kind: "test", label: "unit", status: "passed", observedAt: 1, summary: "10 passed" }],
  })
  assertEquals(result.verdict, "complete")
  assertEquals(observed.includes("Do not inspect the filesystem, call tools"), true)
})

Deno.test("verifier retries invalid output and honors cancellation", async () => {
  let attempts = 0
  const verifier = new GoalVerifierService(
    async () => {
      attempts++
      return attempts === 1
        ? {}
        : { verdict: "continue", reason: "Missing test", missingCriteria: ["Test"], confidence: "medium" }
    },
    1_000,
    1,
  )
  assertEquals((await verifier.verify({ objective: "Ship", acceptanceCriteria: [], evidence: [] })).verdict, "continue")
  const aborted = new AbortController()
  aborted.abort(new Error("cancelled"))
  await assertRejects(
    () => verifier.verify({ objective: "Ship", acceptanceCriteria: [], evidence: [] }, aborted.signal),
    Error,
    "cancelled",
  )
})

Deno.test("verifier rejects oversized inputs explicitly instead of silently truncating them", async () => {
  const verifier = new GoalVerifierService(async () => ({
    verdict: "complete",
    reason: "unused",
    missingCriteria: [],
    confidence: "high",
  }))
  await assertRejects(
    () => verifier.verify({ objective: "Ship", acceptanceCriteria: ["x".repeat(2_001)], evidence: [] }),
    Error,
    "criteria",
  )
  await assertRejects(
    () =>
      verifier.verify({
        objective: "Ship",
        acceptanceCriteria: [],
        latestAssistantResult: "x".repeat(20_001),
        evidence: [],
      }),
    Error,
    "assistant result",
  )
  await assertRejects(
    () =>
      verifier.verify({
        objective: "Ship",
        acceptanceCriteria: [],
        evidence: Array.from(
          { length: 201 },
          (_, index) => ({
            id: String(index),
            kind: "test" as const,
            label: "test",
            status: "passed" as const,
            observedAt: 1,
            summary: "passed",
          }),
        ),
      }),
    Error,
    "evidence",
  )
})

Deno.test("verifier retains bounded independent-session attempt metadata", async () => {
  const verifier = new GoalVerifierService(async () => ({
    workbenchVerifierInvocation: true,
    output: { verdict: "complete", reason: "Verified", missingCriteria: [], confidence: "high" },
    metadata: { sessionID: "verifier-session", model: "provider/model", tokens: 42, cost: 0.01 },
  }))
  const result = await verifier.verifyDetailed({ objective: "Ship", acceptanceCriteria: ["Verified"], evidence: [] })
  assertEquals(result.attempts.length, 1)
  assertEquals(result.attempts[0]?.sessionID, "verifier-session")
  assertEquals(result.attempts[0]?.tokens, 42)
  assertEquals(result.attempts[0]?.outcome, "completed")
})

Deno.test("verifier evidence selection keeps the newest bounded set and marks omitted history", () => {
  const selected = boundedVerifierEvidence(Array.from({ length: 205 }, (_, index) => ({
    id: `evidence-${index}`,
    kind: "test" as const,
    label: `Test ${index}`,
    status: "passed" as const,
    observedAt: index,
    summary: "passed",
  })))
  assertEquals(selected.length, 200)
  assertEquals(selected.some((entry) => entry.id === "evidence-0"), false)
  assertEquals(selected.some((entry) => entry.id === "evidence-204"), true)
  assertEquals(selected.at(-1)?.kind, "criterion")
  assertEquals(selected.at(-1)?.status, "warning")
  assertEquals(boundedVerifierEvidence(selected.slice(0, 10)), selected.slice(0, 10))
})
