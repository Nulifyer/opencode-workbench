import { assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert"
import { RunComparisonService } from "../src/application/run-comparison-service.ts"
import type { EvidenceReference, RunGroup } from "@opencode-workbench/shared"

const group: RunGroup = { id: "group", title: "Compare", repository: "/repo", baseRef: "main", promptReceiptID: "receipt", isolation: "worktree", createdAt: 1, runs: [{ id: "one", model: "provider/model", phase: "completed", startedAt: 1, completedAt: 1_001, session: { sessionID: "session", directory: "/run", worktreeID: "wt", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } }] }

Deno.test("objective comparison reports exact Git numstat and labels unavailable evidence", async () => {
  const service = new RunComparisonService({ run: async (args) => {
    if (args[0] === "ls-files") return { stdout: "", stderr: "" }
    if (args.includes("--numstat")) return { stdout: "2\t1\tsrc/a.ts\0-\t-\tasset.png\0", stderr: "" }
    return { stdout: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line\ndiff --git a/asset.png b/asset.png\nBinary files differ\n", stderr: "" }
  } })
  const evidence: EvidenceReference[] = [
    { id: "test", kind: "test", label: "unit", status: "passed", observedAt: 1, summary: "passed" },
    { id: "diagnostics", kind: "diagnostics", label: "diagnostics", status: "passed", observedAt: 2, summary: "0 errors" },
  ]
  const rows = await service.compare(group, { one: { evidence, verifierState: "active / continue", tokens: 25, cost: 0.5 } })
  assertEquals(rows[0]?.changedFiles, 2)
  assertEquals(rows[0]?.complete, false)
  assertEquals(rows[0]?.taskOutcomes, "passed")
  assertEquals(rows[0]?.diagnostics, "clean")
  assertEquals(rows[0]?.tokens, 25)
  assertMatch(service.markdown(group, rows), /No AI winner/)
  assertMatch(service.markdown(group, rows), /Goal \/ verifier/)
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
  const diagnostics = async (entries: EvidenceReference[]) => (await service.compare(group, { one: { evidence: entries } }))[0]?.diagnostics

  assertEquals(await diagnostics([]), "not-recorded")
  assertEquals(await diagnostics([evidence("passed", 20), evidence("failed", 10)]), "clean")
  assertEquals(await diagnostics([evidence("passed", 10), evidence("warning", 20)]), "not-recorded")
  assertEquals(await diagnostics([evidence("passed", 10), evidence("unknown", 20)]), "not-recorded")
  assertEquals(await diagnostics([evidence("passed", 10), evidence("failed", 20)]), "has-errors")
})

Deno.test("objective comparison bounds and redacts Git failure details", async () => {
  const secret = "Authorization: \"Bearer auth-secret\"\nProxy-Authorization: 'Basic proxy-secret'\nCookie: session=cookie-secret\nhttps://user:pass@example.com/path " + "x".repeat(3_000)
  const service = new RunComparisonService({ run: async () => { throw new Error(secret) } })
  const rows = await service.compare(group)
  const limitation = rows[0]?.limitation ?? ""
  assertEquals(limitation.length <= 2_000, true)
  assertStringIncludes(limitation, "Authorization: [redacted]")
  assertStringIncludes(limitation, "Proxy-Authorization: [redacted]")
  assertStringIncludes(limitation, "Cookie: [redacted]")
  assertStringIncludes(limitation, "https://[redacted]@example.com/path")
  for (const value of ["auth-secret", "proxy-secret", "cookie-secret", "user:pass"]) assertEquals(limitation.includes(value), false)
})
