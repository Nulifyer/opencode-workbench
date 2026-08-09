import { assert, assertEquals, assertGreater, assertStrictEquals, assertStringIncludes } from "jsr:@std/assert"
import { enforceProtocolLimits, parseHostMessage, PROTOCOL_V2_SCHEMA_SOURCE, type ChatSnapshot, type ContextReceipt, type RunGroup, type WalkthroughDocument, type WorktreeJournalEntry } from "@opencode-workbench/shared"
import { projectChatSnapshotForWebview, WEBVIEW_SNAPSHOT_BYTE_LIMIT } from "../src/application/webview-snapshot-projector.ts"

function baseSnapshot(): ChatSnapshot {
  return {
    connected: true,
    connectionState: "connected",
    sessions: [{ id: "selected", title: "Current session", status: { type: "idle" }, unread: 0, updatedAt: 10 }],
    agents: [{ name: "build" }],
    models: [{ id: "model", name: "Model", providerID: "provider" }],
    session: {
      id: "selected",
      title: "Current session",
      draft: "keep this draft",
      status: { type: "idle" },
      loaded: true,
      loadState: "ready",
      messages: [{ info: { id: "message-current", sessionID: "selected", role: "assistant" }, parts: [{ id: "part-current", sessionID: "selected", messageID: "message-current", type: "text", text: "Current answer" }] }],
      messageRevisions: { "message-current": 7 },
      history: { totalMessages: 1, visibleMessages: 1, hasOlder: false },
      agent: "build",
      model: "provider/model",
      contextReceipts: [],
    },
  }
}

function aggregateSnapshot(): ChatSnapshot {
  const value = baseSnapshot()
  const unicodeLabel = "🙂".repeat(512) // 1,024 UTF-16 characters but 2,048 UTF-8 bytes.
  const receipts: ContextReceipt[] = Array.from({ length: 400 }, (_, receiptIndex) => ({
    id: `receipt-${receiptIndex}`,
    sessionID: "selected",
    promptID: `prompt-${receiptIndex}`,
    admittedAt: receiptIndex,
    truncation: "none",
    items: Array.from({ length: 20 }, (_, itemIndex) => ({ id: `item-${itemIndex}`, kind: "file", label: unicodeLabel })),
  }))
  value.session!.contextReceipts = receipts

  const directory = `/runs/${"r".repeat(8_000)}`
  const groups: RunGroup[] = Array.from({ length: 300 }, (_, groupIndex) => ({
    id: `group-${groupIndex}`,
    title: `Group ${groupIndex}`,
    repository: "/repo",
    baseRef: "main",
    promptReceiptID: `receipt-${groupIndex}`,
    isolation: "worktree",
    createdAt: groupIndex,
    runs: Array.from({ length: 5 }, (_, runIndex) => ({
      id: `run-${runIndex}`,
      model: `provider/model-${runIndex}`,
      phase: groupIndex === 0 && runIndex === 0 ? "needs-input" : "completed",
      worktreeID: groupIndex === 0 && runIndex === 0 ? "worktree-important" : undefined,
      session: { sessionID: `session-${groupIndex}-${runIndex}`, directory, experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" },
    })),
  }))
  value.runGroups = groups

  const repository = `/repo/${"p".repeat(8_000)}`
  const worktrees: WorktreeJournalEntry[] = Array.from({ length: 500 }, (_, index) => ({
    id: index === 0 ? "worktree-important" : `worktree-${index}`,
    mutationID: `mutation-${index}`,
    owner: "workbench",
    repository,
    repositoryID: "git:repository",
    path: `/worktrees/${"w".repeat(8_000 - String(index).length)}${index}`,
    branch: `workbench/run-${index}`,
    baseRef: "main",
    phase: index === 0 ? "ready" : "removed",
    createdAt: index,
    updatedAt: index,
  }))
  value.worktrees = worktrees

  const walkthroughs: WalkthroughDocument[] = Array.from({ length: 30 }, (_, documentIndex) => ({
    id: `walkthrough-${documentIndex}`,
    diffHash: `sha256:${String(documentIndex).padStart(64, "0")}`,
    model: "provider/model",
    promptVersion: "1",
    language: "en",
    generatedAt: documentIndex,
    coverage: "complete",
    stops: Array.from({ length: 50 }, (_, stopIndex) => ({
      id: `stop-${documentIndex}-${stopIndex}`,
      title: `Step ${stopIndex}`,
      explanation: "e".repeat(10_000),
      importance: "normal",
      anchors: [{ file: "src/main.ts", side: "modified", startLine: 1, endLine: 1, hunkHeader: "@@ -1 +1 @@" }],
    })),
  }))
  value.walkthroughs = walkthroughs
  return value
}

Deno.test("webview snapshot projection is a no-op below the transport budget", () => {
  const snapshot = baseSnapshot()
  assertStrictEquals(projectChatSnapshotForWebview(snapshot), snapshot)
})

Deno.test("webview snapshot projection deterministically bounds aggregate durable state by UTF-8 bytes", () => {
  const source = aggregateSnapshot()
  assertGreater(Buffer.byteLength(JSON.stringify(source), "utf8"), 32 * 1024 * 1024)

  const projected = projectChatSnapshotForWebview(source)
  const repeated = projectChatSnapshotForWebview(source)
  const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8")

  assert(bytes <= WEBVIEW_SNAPSHOT_BYTE_LIMIT)
  assertEquals(projected.projection?.encodedBytes, bytes)
  assertEquals(JSON.stringify(projected), JSON.stringify(repeated))
  assert(parseHostMessage({ type: "snapshot", snapshot: projected }), "The bounded projection must remain valid host protocol state")
  enforceProtocolLimits({
    protocol: 2,
    kind: "event",
    epoch: "epoch",
    sequence: 0,
    revision: 0,
    type: "workbench.snapshot",
    payload: { snapshot: { epoch: "epoch", sequence: 0, revision: 0, state: [{ type: "snapshot", snapshot: projected }] } },
  }, { ...PROTOCOL_V2_SCHEMA_SOURCE.defaultLimits })
  assertEquals(projected.session?.messages.at(-1)?.info.id, "message-current")
  assert(projected.sessions.some((session) => session.id === "selected"))
  assert(projected.runGroups?.some((group) => group.id === "group-0"), "The needs-input run group was not retained")
  assert(projected.worktrees?.some((entry) => entry.id === "worktree-important"), "The referenced active worktree was not retained")
  assertEquals(projected.session?.contextReceipts?.at(-1)?.id, "receipt-399")
  assert(projected.walkthroughs?.some((document) => document.id === "walkthrough-29"), "The newest walkthrough was not retained")

  const omitted = projected.projection!.omitted
  assertEquals(omitted.contextReceipts ?? 0, source.session!.contextReceipts!.length - projected.session!.contextReceipts!.length)
  assertEquals(omitted.runGroups ?? 0, source.runGroups!.length - projected.runGroups!.length)
  assertEquals(omitted.worktrees ?? 0, source.worktrees!.length - projected.worktrees!.length)
  assertEquals(omitted.walkthroughs ?? 0, source.walkthroughs!.length - projected.walkthroughs!.length)
  assertEquals(
    omitted.walkthroughStops ?? 0,
    source.walkthroughs!.reduce((total, document) => total + document.stops.length, 0) - projected.walkthroughs!.reduce((total, document) => total + document.stops.length, 0),
  )
  assertStringIncludes(projected.projection!.message, "were not deleted")
})
