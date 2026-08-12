import { assertEquals, assertMatch, assertStringIncludes, assertThrows } from "jsr:@std/assert"
import {
  exactRunComparisonMarkdown,
  runComparisonMarkdown,
  RunComparisonService,
} from "../src/application/run-comparison-service.ts"
import {
  type EvidenceReference,
  type RunComparisonRow,
  type RunGroup,
  TASK_ARTIFACT_SCHEMA_VERSION,
  type TaskArtifact,
} from "@opencode-workbench/shared"

const group: RunGroup = {
  id: "group",
  title: "Compare",
  repository: "/repo",
  baseRef: "main",
  promptReceiptID: "receipt",
  isolation: "worktree",
  createdAt: 1,
  runs: [{
    id: "one",
    model: "provider/model",
    phase: "completed",
    startedAt: 1,
    completedAt: 1_001,
    session: {
      sessionID: "session",
      directory: "/run",
      worktreeID: "wt",
      experience: "workbench",
      transport: "http-sse",
      runtimeEpoch: "epoch",
    },
  }],
}

Deno.test("objective comparison reports exact Git numstat and labels unavailable evidence", async () => {
  const service = new RunComparisonService({
    run: async (args) => {
      if (args[0] === "ls-files") return { stdout: "", stderr: "" }
      if (args.includes("--numstat")) return { stdout: "2\t1\tsrc/a.ts\0-\t-\tasset.png\0", stderr: "" }
      return {
        stdout:
          "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line\ndiff --git a/asset.png b/asset.png\nBinary files differ\n",
        stderr: "",
      }
    },
  })
  const evidence: EvidenceReference[] = [
    { id: "test", kind: "test", label: "unit", status: "passed", observedAt: 1, summary: "passed" },
    {
      id: "diagnostics",
      kind: "diagnostics",
      label: "diagnostics",
      status: "passed",
      observedAt: 2,
      summary: "0 errors",
    },
  ]
  const rows = await service.compare(group, {
    one: { evidence, verifierState: "active / continue", tokens: 25, cost: 0.5 },
  })
  assertEquals(rows[0]?.changedFiles, 2)
  assertEquals(rows[0]?.complete, false)
  assertEquals(rows[0]?.taskOutcomes, "passed")
  assertEquals(rows[0]?.diagnostics, "clean")
  assertEquals(rows[0]?.tokens, 25)
  assertMatch(service.markdown(group, rows), /No winner or score/)
  assertMatch(service.markdown(group, rows), /Verifier/)
})

Deno.test("objective comparison reports diagnostics only when their state is proven", async () => {
  const service = new RunComparisonService({ run: async () => ({ stdout: "", stderr: "" }) })
  const evidence = (status: EvidenceReference["status"], observedAt: number): EvidenceReference => ({
    id: `${status}-${observedAt}`,
    kind: "diagnostics",
    label: "diagnostics",
    status,
    observedAt,
    summary: status,
  })
  const diagnostics = async (entries: EvidenceReference[]) =>
    (await service.compare(group, { one: { evidence: entries } }))[0]?.diagnostics

  assertEquals(await diagnostics([]), "not-recorded")
  assertEquals(await diagnostics([evidence("passed", 20), evidence("failed", 10)]), "clean")
  assertEquals(await diagnostics([evidence("passed", 10), evidence("warning", 20)]), "not-recorded")
  assertEquals(await diagnostics([evidence("passed", 10), evidence("unknown", 20)]), "not-recorded")
  assertEquals(await diagnostics([evidence("passed", 10), evidence("failed", 20)]), "has-errors")
})

Deno.test("pending runs never compare the main checkout as run output", async () => {
  let gitCalls = 0
  const pending: RunGroup = {
    ...group,
    runs: [{
      ...group.runs[0]!,
      phase: "preparing",
      session: { ...group.runs[0]!.session, sessionID: "pending", directory: group.repository },
    }],
  }
  const rows = await new RunComparisonService({
    run: async () => {
      gitCalls += 1
      return { stdout: "", stderr: "" }
    },
  }).compare(pending)

  assertEquals(gitCalls, 0)
  assertEquals(rows[0]?.changedFiles, 0)
  assertEquals(rows[0]?.complete, false)
  assertEquals(rows[0]?.limitation, "Run directory was not created")
})

Deno.test("objective comparison bounds and redacts Git failure details", async () => {
  const secret =
    "Authorization: \"Bearer auth-secret\"\nProxy-Authorization: 'Basic proxy-secret'\nCookie: session=cookie-secret\nhttps://user:pass@example.com/path " +
    "x".repeat(3_000)
  const service = new RunComparisonService({
    run: async () => {
      throw new Error(secret)
    },
  })
  const rows = await service.compare(group)
  const limitation = rows[0]?.limitation ?? ""
  assertEquals(limitation.length <= 2_000, true)
  assertStringIncludes(limitation, "Authorization: [redacted]")
  assertStringIncludes(limitation, "Proxy-Authorization: [redacted]")
  assertStringIncludes(limitation, "Cookie: [redacted]")
  assertStringIncludes(limitation, "https://[redacted]@example.com/path")
  for (const value of ["auth-secret", "proxy-secret", "cookie-secret", "user:pass"]) {
    assertEquals(limitation.includes(value), false)
  }
})

Deno.test("comparison Markdown exports exact stored rows without scoring or a model turn", () => {
  const row: RunComparisonRow = {
    runID: "run|one",
    status: "completed",
    model: "provider/model",
    agent: "build",
    elapsedMilliseconds: 1_234,
    changedFiles: 2,
    additions: 7,
    deletions: 3,
    taskOutcomes: "passed",
    diagnostics: "clean",
    verifierState: "verified|deterministically",
    tokens: 42,
    cost: 0.125,
    complete: true,
    blocker: "line one\nline|two",
  }
  const markdown = runComparisonMarkdown({ ...group, title: "Compare | exact" }, [row])
  assertStringIncludes(markdown, "# Run comparison: Compare \\| exact")
  assertStringIncludes(markdown, "| run\\|one | completed | provider/model / build | 1234 | 2 | 7 | 3 |")
  assertStringIncludes(markdown, "verified\\|deterministically")
  assertStringIncludes(markdown, "line one<br>line\\|two")
  assertStringIncludes(markdown, "No winner or score is inferred, and this export invokes no model.")
  assertEquals(markdown.includes("| Winner |"), false)
  assertEquals(markdown.includes("| Score |"), false)
})

Deno.test("exact comparison export binds artifact identity, revision, group, and active lifecycle", () => {
  const row: RunComparisonRow = {
    runID: "one",
    status: "completed",
    model: "provider/model",
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    taskOutcomes: "not-recorded",
    diagnostics: "not-recorded",
    complete: true,
  }
  const artifact: TaskArtifact = {
    schemaVersion: TASK_ARTIFACT_SCHEMA_VERSION,
    id: "artifact",
    revision: 3,
    createdAt: 1,
    updatedAt: 2,
    sessionID: "session",
    lifecycle: "active",
    kind: "run-comparison",
    payload: { groupID: group.id, rows: [row] },
  }
  const reference = { groupID: group.id, artifactID: artifact.id, revision: artifact.revision }
  assertEquals(exactRunComparisonMarkdown(group, [artifact], reference), runComparisonMarkdown(group, [row]))
  assertThrows(() => exactRunComparisonMarkdown(group, [artifact], { ...reference, revision: 2 }), Error, "changed")
  assertThrows(
    () => exactRunComparisonMarkdown(group, [artifact], { ...reference, groupID: "other" }),
    Error,
    "group changed",
  )
  assertThrows(
    () => exactRunComparisonMarkdown(group, [{ ...artifact, lifecycle: "archived" }], reference),
    Error,
    "no longer available",
  )
})
