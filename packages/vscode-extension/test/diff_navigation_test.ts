import { assertEquals, assertThrows } from "jsr:@std/assert"
import type { DiffSnapshot } from "@opencode-workbench/shared"
import { diffNavigationPaths } from "../src/application/diff-navigation.ts"

const snapshot: DiffSnapshot = {
  id: "diff",
  scope: "session",
  repository: "/repo",
  baseRef: "main",
  unifiedDiffHash: "sha256:test",
  generatedAt: 1,
  complete: true,
  files: [{ path: "new/name.ts", previousPath: "old/name.ts", additions: 1, deletions: 1 }],
}

Deno.test("diff navigation respects rename provenance and requested side", () => {
  assertEquals(diffNavigationPaths(snapshot, { file: "new/name.ts", side: "base", startLine: 1, endLine: 1 }), {
    basePath: "old/name.ts",
    modifiedPath: "new/name.ts",
    focusPath: "old/name.ts",
  })
  assertEquals(
    diffNavigationPaths(snapshot, { file: "new/name.ts", side: "modified", startLine: 1, endLine: 1 }).focusPath,
    "new/name.ts",
  )
})

Deno.test("diff navigation rejects anchors outside the captured diff", () => {
  assertThrows(
    () => diffNavigationPaths(snapshot, { file: "invented.ts", side: "modified", startLine: 1, endLine: 1 }),
    Error,
    "unknown file",
  )
})
