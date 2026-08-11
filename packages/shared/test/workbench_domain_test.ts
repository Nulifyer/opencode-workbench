import { assertEquals, assertThrows } from "jsr:@std/assert"
import { MULTI_RUN_DEFAULT_CONCURRENCY, normalizeTaskArtifact, runGroupStatus, sanitizeContextReceipt, taskArtifactSummary, validateWalkthrough, type DiffSnapshot, type RunGroup, type TaskArtifact } from "../src/index.ts"

const HASH_A = `sha256:${"a".repeat(64)}`
const HASH_B = `sha256:${"b".repeat(64)}`

Deno.test("multi-run defaults to five peer candidates at once", () => {
  assertEquals(MULTI_RUN_DEFAULT_CONCURRENCY, 5)
})

function planArtifact(): TaskArtifact {
  return {
    schemaVersion: 1,
    id: "artifact-plan",
    kind: "plan",
    sessionID: "session-plan",
    lifecycle: "active",
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
    producer: { sessionID: "session-plan", messageID: "message-plan", model: "provider/model" },
    payload: { phase: "ready", uri: "untitled:OpenCode Plan.md", revision: HASH_A },
  }
}

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

Deno.test("plan task artifacts retain only OpenCode provenance and document metadata", () => {
  const normalized = normalizeTaskArtifact(planArtifact())
  assertEquals(normalized.kind, "plan")
  assertEquals(normalized.sessionID, "session-plan")
  assertEquals(normalized.kind === "plan" && normalized.payload.revision, HASH_A)
  assertEquals(taskArtifactSummary(normalized), {
    schemaVersion: 1, id: "artifact-plan", kind: "plan", sessionID: "session-plan", lifecycle: "active",
    revision: 1, createdAt: 10, updatedAt: 10, state: "ready", itemCount: undefined,
  })
  assertThrows(() => normalizeTaskArtifact({ ...planArtifact(), payload: { ...planArtifact().payload, objective: "must never persist" } }), Error, "unsupported field objective")
  assertThrows(() => normalizeTaskArtifact({ ...planArtifact(), payload: { phase: "ready", uri: "untitled:Plan", revision: "not-a-hash" } }), Error, "SHA-256")
  assertThrows(() => normalizeTaskArtifact({ ...planArtifact(), producer: { sessionID: "other-session" } }), Error, "owning OpenCode session")
})

Deno.test("handed-off plans require internally consistent OpenCode session metadata", () => {
  const artifact = planArtifact()
  const normalized = normalizeTaskArtifact({
    ...artifact,
    payload: {
      phase: "handed-off",
      uri: "file:///repo/plan.md",
      revision: HASH_A,
      approvedAt: 11,
      relatedSessionIDs: ["implementation-session"],
      handoffs: [{ mode: "implementation", createdAt: 12, sessionIDs: ["implementation-session"] }],
    },
  })
  assertEquals(normalized.kind === "plan" && normalized.payload.handoffs?.[0]?.sessionIDs, ["implementation-session"])
  assertThrows(() => normalizeTaskArtifact({
    ...artifact,
    payload: {
      phase: "handed-off", uri: "file:///repo/plan.md", revision: HASH_A, approvedAt: 11,
      relatedSessionIDs: [], handoffs: [{ mode: "implementation", createdAt: 12, sessionIDs: ["implementation-session"] }],
    },
  }), Error, "missing from relatedSessionIDs")
})

Deno.test("review artifacts persist structured findings without raw diffs and enforce their hash", () => {
  const review: TaskArtifact = {
    schemaVersion: 1, id: "artifact-review", kind: "review", sessionID: "subject-session", lifecycle: "active", revision: 1, createdAt: 20, updatedAt: 20,
    producer: { sessionID: "review-session", messageID: "review-message", model: "provider/model" },
    payload: {
      repository: "/repo", baseRef: "main", scope: "session", diffHash: HASH_A, stale: false,
      document: {
        id: "review", diffHash: HASH_A, model: "provider/model", promptVersion: "1", generatedAt: 20,
        findings: [{ id: "finding", title: "Missing guard", detail: "Validate the input first.", category: "correctness", severity: "high", anchors: [{ file: "src/main.ts", side: "modified", startLine: 4, endLine: 5, hunkHeader: "@@ -3,2 +3,4 @@" }] }],
      },
      dispositions: [{ findingID: "finding", state: "open", updatedAt: 20 }],
    },
  }
  const normalized = normalizeTaskArtifact(review)
  assertEquals(taskArtifactSummary(normalized).itemCount, 1)
  assertThrows(() => normalizeTaskArtifact({ ...review, payload: { ...review.payload, rawDiff: "+secret" } }), Error, "unsupported field rawDiff")
  assertThrows(() => normalizeTaskArtifact({ ...review, payload: { ...review.payload, diffHash: HASH_B } }), Error, "does not match")
  assertThrows(() => normalizeTaskArtifact({ ...review, payload: { ...review.payload, dispositions: [{ findingID: "unknown", state: "open", updatedAt: 20 }] } }), Error, "unknown finding")
})

Deno.test("goal verification artifacts contain bounded OpenCode attempts but no prompt material", () => {
  const verification: TaskArtifact = {
    schemaVersion: 1, id: "artifact-verification", kind: "goal-verification", sessionID: "goal-session", lifecycle: "active", revision: 1, createdAt: 30, updatedAt: 30,
    producer: { sessionID: "verifier-session", messageID: "verifier-message", model: "provider/model" },
    payload: {
      settlementGeneration: 4,
      verdict: { verdict: "complete", reason: "All deterministic checks passed.", missingCriteria: [], confidence: "high" },
      attempts: [{ attempt: 1, startedAt: 21, completedAt: 29, outcome: "completed", sessionID: "verifier-session", model: "provider/model", tokens: 20, cost: 0.01 }],
      evidenceIDs: ["evidence-one"], applied: true, stale: false, appliedAt: 30,
    },
  }
  assertEquals(taskArtifactSummary(normalizeTaskArtifact(verification)).state, "applied")
  assertThrows(() => normalizeTaskArtifact({ ...verification, payload: { ...verification.payload, prompt: "private prompt" } }), Error, "unsupported field prompt")
  assertThrows(() => normalizeTaskArtifact({ ...verification, producer: { sessionID: "unrelated-verifier" } }), Error, "one of its OpenCode attempts")
  assertThrows(() => normalizeTaskArtifact({ ...verification, payload: { ...verification.payload, applied: false } }), Error, "cannot have appliedAt")
})

Deno.test("run-comparison and context-capture artifacts remain deterministic metadata", () => {
  const comparison: TaskArtifact = {
    schemaVersion: 1, id: "artifact-comparison", kind: "run-comparison", sessionID: "session", lifecycle: "active", revision: 1, createdAt: 40, updatedAt: 40,
    payload: { groupID: "group", rows: [{ runID: "run", status: "completed", model: "provider/model", changedFiles: 2, additions: 4, deletions: 1, taskOutcomes: "passed", diagnostics: "clean", complete: true }] },
  }
  assertEquals(taskArtifactSummary(normalizeTaskArtifact(comparison)).state, "complete")
  assertThrows(() => normalizeTaskArtifact({ ...comparison, producer: { sessionID: "fake-producer" } }), Error, "cannot claim")

  const capture: TaskArtifact = {
    schemaVersion: 1, id: "artifact-context", kind: "context-capture", sessionID: "session", lifecycle: "active", revision: 1, createdAt: 50, updatedAt: 50,
    payload: {
      promptID: "prompt", receiptID: "context:prompt", admittedAt: 50, truncation: "none", estimatedTokens: 3,
      sources: [{ id: "selection", kind: "selection", label: "src/main.ts:1", uri: "file:///repo/src/main.ts?token=private#fragment", contentHash: HASH_A, estimatedTokens: 3 }],
    },
  }
  const normalized = normalizeTaskArtifact(capture)
  assertEquals(normalized.kind === "context-capture" && normalized.payload.sources[0]?.uri, "file:///repo/src/main.ts")
  assertThrows(() => normalizeTaskArtifact({ ...capture, payload: { ...capture.payload, clipboard: "private bytes" } }), Error, "unsupported field clipboard")
  assertThrows(() => normalizeTaskArtifact({ ...capture, payload: { ...capture.payload, receiptID: "other" } }), Error, "does not match")
  assertThrows(() => normalizeTaskArtifact({ ...capture, payload: { ...capture.payload, sources: Array.from({ length: 101 }, (_, index) => ({ id: `source-${index}`, kind: "file", label: "file" })) } }), Error, "at most 100")
})
