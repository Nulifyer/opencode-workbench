import { assert, assertEquals, assertGreater, assertStrictEquals, assertStringIncludes } from "jsr:@std/assert"
import {
  type ChatSnapshot,
  type ContextReceipt,
  enforceProtocolLimits,
  type EvidenceReference,
  parseHostMessage,
  PROTOCOL_V2_SCHEMA_SOURCE,
  type RunComparisonSnapshot,
  type RunGroup,
  type TaskArtifactSummary,
  type WalkthroughDocument,
  type WorktreeJournalEntry,
} from "@opencode-workbench/shared"
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

Deno.test("webview snapshot projection prioritizes running PTYs and accounts for omitted PTY metadata", () => {
  const source = baseSnapshot()
  source.ptys = [
    ...Array.from({ length: 64 }, (_, index) => ({
      id: `pty-exited-${index}`,
      title: `Exited ${index}`,
      command: "deno",
      args: ["a".repeat(20_000)],
      cwd: "/work",
      status: "exited" as const,
      pid: index,
      exitCode: 0,
    })),
    {
      id: "pty-running",
      title: "Current test",
      command: "deno",
      args: ["a".repeat(20_000)],
      cwd: "/work",
      status: "running" as const,
      pid: 100,
    },
  ]

  assertGreater(
    Buffer.byteLength(JSON.stringify(source), "utf8"),
    1_024 * 1_024,
  )
  const projected = projectChatSnapshotForWebview(source, 1_024 * 1_024)

  assert(
    projected.ptys?.some((pty) => pty.id === "pty-running"),
    "Running PTY was not prioritized",
  )
  assertGreater(projected.projection?.omitted.ptys ?? 0, 0)
  assertEquals(
    projected.projection?.omitted.ptys,
    source.ptys.length - (projected.ptys?.length ?? 0),
  )
  assertEquals(Object.keys(projected.projection?.omitted ?? {}).sort(), [
    "ptys",
  ], "PTY projection used an unexpected omission key")
  assertEquals(projected.session?.messages.at(-1)?.info.id, "message-current")
  assert(
    parseHostMessage({ type: "snapshot", snapshot: projected }),
    "Projected PTY state violated host protocol validation",
  )
})

Deno.test("webview snapshot projection keeps selected OpenCode lineage and accounts for descendants", () => {
  const source = baseSnapshot()
  source.lineage = [
    { sessionID: "selected", rootID: "selected", depth: 0, relation: "root", title: "Current session", status: { type: "idle" }, updatedAt: 10 },
    { sessionID: "active-child", parentID: "selected", rootID: "selected", depth: 1, relation: "child", title: "Active child", status: { type: "busy" }, updatedAt: 20, attention: 1 },
    ...Array.from({ length: 998 }, (_, index) => ({
      sessionID: `child-${index}`,
      parentID: "selected",
      rootID: "selected",
      depth: 1,
      relation: "child" as const,
      title: `Child ${index} ${"x".repeat(1_760)}`,
      status: { type: "idle" as const },
      updatedAt: index,
    })),
  ]

  const projected = projectChatSnapshotForWebview(source, 1_024 * 1_024)
  assert(projected.lineage?.some((node) => node.sessionID === "selected"), "Selected lineage root was not retained")
  assert(projected.lineage?.some((node) => node.sessionID === "active-child"), "Active child lineage was not prioritized")
  assertGreater(projected.projection?.omitted.lineage ?? 0, 0)
  assertEquals(projected.projection?.omitted.lineage, source.lineage.length - (projected.lineage?.length ?? 0))
  assert(parseHostMessage({ type: "snapshot", snapshot: projected }), "Projected lineage violated host protocol validation")
})

Deno.test("webview snapshot projection bounds and prioritizes selected-session artifact, evidence, and comparison metadata", () => {
  const source = baseSnapshot()
  const selectedSessionID = "s".repeat(1_024)
  const longID = (prefix: string, fill: string): string =>
    `${prefix}${fill.repeat(1_024 - prefix.length)}`
  source.sessions[0] = { ...source.sessions[0]!, id: selectedSessionID }
  source.session = {
    ...source.session!,
    id: selectedSessionID,
    messages: [],
    messageRevisions: {},
    history: { totalMessages: 0, visibleMessages: 0, hasOlder: false },
  }

  const importantArtifactID = longID("artifact-important-", "i")
  const importantArtifact: TaskArtifactSummary = {
    schemaVersion: 1,
    id: importantArtifactID,
    kind: "review",
    sessionID: selectedSessionID,
    lifecycle: "active",
    revision: 3,
    createdAt: 1,
    updatedAt: 10_000,
    state: "stale",
    itemCount: 1,
    stale: true,
  }
  source.artifacts = [
    ...Array.from({ length: 499 }, (_, index): TaskArtifactSummary => ({
      schemaVersion: 1,
      id: longID(`artifact-${index}-`, "a"),
      kind: "plan",
      sessionID: selectedSessionID,
      lifecycle: "archived",
      revision: 1,
      createdAt: index,
      updatedAt: index,
      state: "ready",
    })),
    importantArtifact,
  ]

  const importantEvidenceID = longID("evidence-important-", "f")
  const importantEvidence: EvidenceReference = {
    id: importantEvidenceID,
    kind: "task",
    label: "Failed task",
    status: "failed",
    observedAt: 10_000,
    sessionID: selectedSessionID,
    summary: "The recorded task failed",
  }
  source.evidence = [
    ...Array.from({ length: 99 }, (_, index): EvidenceReference => ({
      id: longID(`evidence-${index}-`, "e"),
      kind: "test",
      label: "L".repeat(1_024),
      status: "passed",
      observedAt: index,
      sessionID: selectedSessionID,
      repository: `/${"r".repeat(8_191)}`,
      summary: "S".repeat(4_000),
    })),
    importantEvidence,
  ]

  const importantComparisonID = longID("comparison-important-", "c")
  const comparisonRow = (comparisonIndex: number, rowIndex: number) => ({
    runID: longID(`run-${comparisonIndex}-${rowIndex}-`, "u"),
    status: "completed" as const,
    model: "M".repeat(1_024),
    agent: "A".repeat(1_024),
    variant: "V".repeat(1_024),
    elapsedMilliseconds: 1,
    changedFiles: 1,
    additions: 1,
    deletions: 0,
    taskOutcomes: "passed" as const,
    diagnostics: "clean" as const,
    verifierState: "R".repeat(2_000),
    tokens: 1,
    cost: 0,
    blocker: "B".repeat(4_000),
    complete: true,
    limitation: "N".repeat(4_000),
  })
  const importantComparison: RunComparisonSnapshot = {
    artifactID: importantComparisonID,
    revision: 2,
    groupID: "important-group",
    rows: [{
      ...comparisonRow(99, 0),
      model: "provider/model",
      agent: undefined,
      variant: undefined,
      verifierState: undefined,
      blocker: undefined,
      limitation: undefined,
    }],
    updatedAt: 10_000,
  }
  source.runComparisons = [
    ...Array.from({ length: 19 }, (_, index): RunComparisonSnapshot => ({
      artifactID: longID(`comparison-${index}-`, "c"),
      revision: 1,
      groupID: longID(`group-${index}-`, "g"),
      rows: Array.from(
        { length: 5 },
        (_, rowIndex) => comparisonRow(index, rowIndex),
      ),
      updatedAt: index,
    })),
    importantComparison,
  ]

  const sourceBefore = JSON.stringify(source)
  const projected = projectChatSnapshotForWebview(source, 1024 * 1024)
  const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8")

  assert(bytes <= 1024 * 1024)
  assert(
    parseHostMessage({ type: "snapshot", snapshot: projected }),
    "Projected durable surface metadata must remain valid protocol state",
  )
  assert(
    projected.artifacts?.some((artifact) =>
      artifact.id === importantArtifactID
    ),
    "Stale active artifact was not prioritized",
  )
  assert(
    projected.evidence?.some((evidence) => evidence.id === importantEvidenceID),
    "Failed evidence was not prioritized",
  )
  assert(
    projected.runComparisons?.some((comparison) =>
      comparison.artifactID === importantComparisonID
    ),
    "Newest run comparison was not prioritized",
  )
  assertGreater(projected.projection?.omitted.taskArtifacts ?? 0, 0)
  assertGreater(projected.projection?.omitted.evidence ?? 0, 0)
  assertGreater(projected.projection?.omitted.runComparisons ?? 0, 0)
  assertEquals(
    projected.projection?.omitted.taskArtifacts,
    source.artifacts.length - (projected.artifacts?.length ?? 0),
  )
  assertEquals(
    projected.projection?.omitted.evidence,
    source.evidence.length - (projected.evidence?.length ?? 0),
  )
  assertEquals(
    projected.projection?.omitted.runComparisons,
    source.runComparisons.length - (projected.runComparisons?.length ?? 0),
  )
  assertEquals(Object.keys(projected.projection?.omitted ?? {}).sort(), [
    "evidence",
    "runComparisons",
    "taskArtifacts",
  ], "durable surfaces used unexpected projection omission keys")
  assertEquals(
    "artifacts" in (projected.projection?.omitted ?? {}),
    false,
    "artifact projection used the field name instead of the protocol taskArtifacts omission key",
  )
  for (const artifact of projected.artifacts ?? []) {
    for (
      const forbidden of [
        "payload",
        "body",
        "objective",
        "diff",
        "prompt",
        "uri",
        "producer",
      ]
    ) assert(!(forbidden in artifact), `Artifact summary leaked ${forbidden}`)
  }
  for (const evidence of projected.evidence ?? []) {
    for (
      const forbidden of [
        "rawOutput",
        "bytes",
        "clipboard",
        "screenshot",
        "prompt",
        "diff",
      ]
    ) {
      assert(
        !(forbidden in evidence),
        `Evidence reference leaked ${forbidden}`,
      )
    }
  }
  for (const comparison of projected.runComparisons ?? []) {
    assert(
      !("rawDiff" in comparison),
      "Run-comparison projection leaked a raw diff",
    )
  }
  assertEquals(
    JSON.stringify(source),
    sourceBefore,
    "Projection mutated durable source state",
  )
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
