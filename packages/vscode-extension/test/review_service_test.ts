import { assertEquals, assertRejects } from "jsr:@std/assert"
import { ReviewService } from "../src/application/review-service.ts"
import type { DiffCapture } from "../src/application/diff-service.ts"

const capture: DiffCapture = {
  unifiedDiff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
  snapshot: {
    id: "diff",
    scope: "session",
    repository: "/repo",
    unifiedDiffHash: "hash",
    generatedAt: 1,
    complete: true,
    files: [{
      path: "a.ts",
      additions: 1,
      deletions: 1,
      hunks: [{ header: "@@ -1 +1 @@", oldRange: { start: 1, end: 1 }, newRange: { start: 1, end: 1 } }],
    }],
  },
}

Deno.test("review findings remain model-labeled and exact-anchor validated", async () => {
  const review = await new ReviewService().generate(capture, "model", async ({ prompt }) => {
    assertEquals(prompt.includes("model assessments, not deterministic facts"), true)
    return JSON.stringify({
      findings: [{
        title: "Issue",
        detail: "Could regress",
        category: "regression",
        severity: "medium",
        anchors: [{ file: "a.ts", side: "modified", startLine: 1, endLine: 1, hunkHeader: "@@ -1 +1 @@" }],
      }],
    })
  })
  assertEquals(review.findings[0]?.category, "regression")
  await assertRejects(
    () =>
      new ReviewService().generate(capture, "model", async () =>
        JSON.stringify({
          findings: [{
            title: "Bad",
            detail: "Bad",
            category: "security",
            severity: "high",
            anchors: [{ file: "missing", side: "modified", startLine: 1, endLine: 1 }],
          }],
        })),
    Error,
    "unknown file",
  )
})
