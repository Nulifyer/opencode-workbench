import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert"
import { createPlanReference, generatedPlanDisposition, planArtifact, structuredPlanPrompt } from "../src/application/plan-service.ts"

Deno.test("plan workflow creates a read-only structured OpenCode request", () => {
  const prompt = structuredPlanPrompt("Add the feature")
  assertMatch(prompt, /Stay read-only/)
  assertMatch(prompt, /validation/)
  assertThrows(() => structuredPlanPrompt(""))
})

Deno.test("plan artifacts persist only a URI and exact revision reference", () => {
  const artifact = planArtifact("Task", "1. Implement", "session")
  const reference = createPlanReference("untitled:OpenCode Plan.md", artifact, 10)
  assertEquals(reference.approvedAt, 10)
  assertMatch(reference.revision, /^sha256:[0-9a-f]{64}$/)
  assertEquals(Object.hasOwn(reference, "content"), false)
})

Deno.test("completed planning preserves a draft edited during generation", () => {
  assertEquals(generatedPlanDisposition(1, 1), "replace-placeholder")
  assertEquals(generatedPlanDisposition(1, 2), "preserve-user-draft")
  assertThrows(() => generatedPlanDisposition(0, 1))
})
