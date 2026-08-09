import { assertEquals, assertThrows } from "jsr:@std/assert"
import { runGroupStatus, sanitizeContextReceipt, validateWalkthrough, type DiffSnapshot, type RunGroup } from "../src/index.ts"

Deno.test("context receipts preserve metadata but cannot carry payload fields", () => {
  const receipt = sanitizeContextReceipt({
    id: "receipt", sessionID: "session", promptID: "prompt", admittedAt: 1, truncation: "none",
    items: [{ id: "selection", kind: "selection", label: "src/main.ts:1-3", uri: "file:///repo/src/main.ts", revision: "7", contentHash: "sha256:abc", bytes: 42, estimatedTokens: 10 }],
  })
  assertEquals(receipt.estimatedTokens, 10)
  assertEquals(Object.hasOwn(receipt.items[0]!, "content"), false)
  assertThrows(() => sanitizeContextReceipt({ ...receipt, items: [receipt.items[0]!, receipt.items[0]!] }), Error, "Duplicate")
  assertThrows(() => sanitizeContextReceipt({ ...receipt, items: [{ ...receipt.items[0]!, range: { startLine: 3, startColumn: 1, endLine: 2, endColumn: 1 } }] }), Error, "range")
  assertThrows(() => sanitizeContextReceipt({ ...receipt, items: [{ ...receipt.items[0]!, uri: `file:///${"x".repeat(4_096)}` }] }), Error, "URI")
})

Deno.test("context receipts redact durable text and never retain navigational or credential-bearing URI metadata", () => {
  const receipt = sanitizeContextReceipt({
    id: "receipt", sessionID: "session", promptID: "prompt", admittedAt: 1, truncation: "none",
    items: [
      { id: "url", kind: "url", label: "Authorization: Bearer top-secret", uri: "https://example.test/callback?access_token=top-secret#secret", revision: "token=revision-secret" },
      { id: "mcp", kind: "mcp-resource", label: "Signed resource", uri: "mcp://server/resource?signature=top-secret" },
    ],
  })
  assertEquals(receipt.items[0]?.label.includes("top-secret"), false)
  assertEquals(receipt.items[0]?.revision?.includes("revision-secret"), false)
  assertEquals(receipt.items[0]?.uri, "https://example.test/callback")
  assertEquals(receipt.items[1]?.uri, undefined)
  assertThrows(() => sanitizeContextReceipt({ ...receipt, id: "token=identity-secret" }), Error, "credential-shaped")
})

Deno.test("walkthrough anchors must resolve against the exact complete diff", () => {
  const snapshot: DiffSnapshot = {
    id: "diff", scope: "turn", repository: "/repo", unifiedDiffHash: "hash", generatedAt: 1, complete: true,
    files: [{ path: "src/main.ts", additions: 2, deletions: 1, hunks: [{ header: "@@ -1 +1,2 @@", oldRange: { start: 1, end: 1 }, newRange: { start: 1, end: 2 } }] }],
  }
  validateWalkthrough({ id: "walk", diffHash: "hash", model: "model", promptVersion: "1", language: "en", generatedAt: 1, coverage: "complete", stops: [{ id: "stop", title: "Change", explanation: "Explains it", importance: "key-change", anchors: [{ file: "src/main.ts", side: "modified", startLine: 1, endLine: 2, hunkHeader: "@@ -1 +1,2 @@" }] }] }, snapshot)
  assertThrows(() => validateWalkthrough({ id: "walk", diffHash: "old", model: "model", promptVersion: "1", language: "en", generatedAt: 1, coverage: "complete", stops: [] }, snapshot), Error, "stale")
  assertThrows(() => validateWalkthrough({ id: "walk", diffHash: "hash", model: "model", promptVersion: "1", language: "en", generatedAt: 1, coverage: "complete", stops: [{ id: "stop", title: "Invented range", explanation: "Outside the hunk", importance: "normal", anchors: [{ file: "src/main.ts", side: "modified", startLine: 999_999, endLine: 999_999, hunkHeader: "@@ -1 +1,2 @@" }] }] }, snapshot), Error, "outside")
  assertThrows(() => validateWalkthrough({ id: "walk", diffHash: "hash", model: "model", promptVersion: "1", language: "en", generatedAt: 1, coverage: "complete", stops: [{ id: "stop", title: "Missing hunk", explanation: "No exact identity", importance: "normal", anchors: [{ file: "src/main.ts", side: "modified", startLine: 1, endLine: 1 }] }] }, snapshot), Error, "exact hunk")
})

Deno.test("walkthrough coverage cannot omit changed files", () => {
  const snapshot: DiffSnapshot = {
    id: "diff", scope: "session", repository: "/repo", unifiedDiffHash: "hash", generatedAt: 1, complete: true,
    files: ["a.ts", "b.ts"].map((file) => ({ path: file, additions: 1, deletions: 1, hunks: [{ header: "@@ -1 +1 @@", oldRange: { start: 1, end: 1 }, newRange: { start: 1, end: 1 } }] })),
  }
  const stop = { id: "stop", title: "A", explanation: "A only", importance: "normal" as const, anchors: [{ file: "a.ts", side: "modified" as const, startLine: 1, endLine: 1, hunkHeader: "@@ -1 +1 @@" }] }
  assertThrows(() => validateWalkthrough({ id: "walk", diffHash: "hash", model: "model", promptVersion: "1", language: "en", generatedAt: 1, coverage: "complete", stops: [stop] }, snapshot), Error, "omits")
  validateWalkthrough({ id: "walk", diffHash: "hash", model: "model", promptVersion: "1", language: "en", generatedAt: 1, coverage: "partial", uncoveredFiles: ["b.ts"], stops: [stop] }, snapshot)
})

Deno.test("run group status reports attention before aggregate completion", () => {
  const group = { id: "group", title: "Compare", repository: "/repo", baseRef: "main", promptReceiptID: "receipt", isolation: "worktree", createdAt: 1, runs: [] } satisfies RunGroup
  assertEquals(runGroupStatus({ ...group, runs: [{ id: "one", model: "a", phase: "completed", session: { sessionID: "s1", directory: "/one", experience: "workbench", transport: "http-sse", runtimeEpoch: "e" } }, { id: "two", model: "b", phase: "needs-input", session: { sessionID: "s2", directory: "/two", experience: "workbench", transport: "http-sse", runtimeEpoch: "e" } }] }), "needs-input")
})
