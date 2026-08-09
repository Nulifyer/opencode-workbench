import { assertEquals, assertThrows } from "jsr:@std/assert"
import type { RunGroup } from "@opencode-workbench/shared"
import { createHash } from "node:crypto"
import { boundedFusionContinuityEvidence, boundedFusionSourceEvidence, buildFusionBundle } from "../src/application/fusion-service.ts"

const group: RunGroup = {
  id: "group", title: "Compare", repository: "/repo", baseRef: "HEAD", promptReceiptID: "receipt", isolation: "worktree", createdAt: 1,
  runs: ["one", "two"].map((id) => ({ id, phase: "completed", model: `provider/${id}`, session: { sessionID: `session-${id}`, directory: `/runs/${id}`, experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } })),
}

function artifact(run: RunGroup["runs"][number], unifiedDiff = `diff --git a/${run.id} b/${run.id}\n`) {
  const unifiedDiffHash = `sha256:${createHash("sha256").update(unifiedDiff).digest("hex")}`
  return { runID: run.id, directory: run.session.directory, sessionID: run.session.sessionID, model: run.model, phase: run.phase, unifiedDiff, diffSnapshot: { id: `diff-${run.id}`, scope: "branch" as const, repository: run.session.directory, baseRef: "HEAD", unifiedDiffHash, generatedAt: 1, complete: true, files: [] }, evidence: [], objectiveSummary: { runID: run.id, status: run.phase, model: run.model, changedFiles: 0, additions: 0, deletions: 0, taskOutcomes: "not-recorded" as const, diagnostics: "not-recorded" as const, complete: true }, assistantSummary: `Summary ${run.id}` }
}

Deno.test("Fusion bundle preserves exact source provenance without merge instructions", () => {
  const artifacts = group.runs.map((run) => artifact(run))
  const bundle = buildFusionBundle(group, "build", artifacts)
  assertEquals(bundle.files.map((file) => file.filename), ["fusion-provenance.json", "one.diff", "one-record.json", "two.diff", "two-record.json"])
  assertEquals(bundle.provenanceHash.length, 64)
  assertEquals(bundle.prompt.includes("do not merge, cherry-pick, push, or publish"), true)
})

Deno.test("Fusion rejects mismatched and oversized source evidence", () => {
  const valid = group.runs.map((run) => artifact(run))
  assertThrows(() => buildFusionBundle(group, "review", [{ ...valid[0]!, sessionID: "wrong" }, valid[1]!]))
  assertThrows(() => buildFusionBundle(group, "plan", [artifact(group.runs[0]!, "x".repeat(1_500_001)), valid[1]!]))
})

Deno.test("Fusion continuity evidence is deterministic, byte bounded, and reports omissions", () => {
  const artifacts = group.runs.map((run, runIndex) => ({
    ...artifact(run),
    evidence: Array.from({ length: 120 }, (_, index) => ({
      id: `evidence-${runIndex}-${index}`,
      kind: "test" as const,
      label: `Test ${runIndex}-${index}`,
      status: "passed" as const,
      observedAt: index,
      sessionID: run.session.sessionID,
      summary: `Result ${runIndex}-${index} ${"x".repeat(3_500)}`,
    })),
  }))
  const first = boundedFusionContinuityEvidence(artifacts, "fusion-session", "provenance")
  const second = boundedFusionContinuityEvidence(artifacts.slice().reverse(), "fusion-session", "provenance")

  assertEquals(first, second)
  assertEquals(first.length <= 96, true)
  assertEquals(Buffer.byteLength(JSON.stringify(first)) <= 240 * 1024, true)
  assertEquals(first.at(-1)?.status, "warning")
  assertEquals(first.at(-1)?.summary.includes("source evidence references were omitted"), true)
  assertEquals(first.at(-1)?.sessionID, "fusion-session")
})

Deno.test("Fusion source evidence selects the newest 199 references and an explicit omission marker", () => {
  const source = Array.from({ length: 205 }, (_, index) => ({ id: `evidence-${index}`, kind: "test" as const, label: `Test ${index}`, status: "passed" as const, observedAt: index, summary: "passed" }))
  const selected = boundedFusionSourceEvidence(source, "one", "session-one")
  assertEquals(selected.length, 200)
  assertEquals(selected.some((entry) => entry.id === "evidence-0"), false)
  assertEquals(selected.some((entry) => entry.id === "evidence-204"), true)
  assertEquals(selected.at(-1)?.status, "warning")
  assertEquals(selected.at(-1)?.summary.includes("older evidence references were omitted"), true)
})
