import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert"
import type { ChatSnapshot, RunComparisonRow } from "@opencode-workbench/shared"
import { inspectorPresentation, sortRunComparisonRows } from "../src/webview/views/inspector/presentation.ts"

function snapshot(): ChatSnapshot {
  return {
    connected: true,
    connectionState: "connected",
    sessions: [],
    agents: [],
    models: [],
    session: {
      id: "session",
      title: "Session",
      draft: "",
      status: { type: "busy" },
      loaded: true,
      loadState: "ready",
      messages: [],
      messageRevisions: {},
      queue: [],
      permissions: [],
      questions: [],
      todos: [{ content: "Done", status: "completed" }, { content: "Next", status: "pending" }],
      changes: [{ file: "src/<unsafe>.ts", additions: 3, deletions: 1, status: "modified" }],
      context: {
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 35,
        model: "provider/<model>",
        usagePercent: 41.6,
        cost: 0.125,
      },
      contextReceipts: [{
        id: "receipt",
        sessionID: "session",
        promptID: "prompt",
      admittedAt: 10,
      truncation: "explicit",
      items: [
        { id: "item", kind: "file", label: "File", uri: "file:///workspace/src/file.ts", revision: "10:20" },
        { id: "missing", kind: "selection", label: "Unavailable selection" },
      ],
      }],
      goal: {
        sourceTool: "get_goal",
        objective: "Ship <safely>",
        status: "active",
        autoTurns: 2,
        maxAutoTurns: 4,
        tokensUsed: 50,
        tokenBudget: 100,
        blocker: "Need & review",
      },
    },
  }
}

Deno.test("inspector presentation covers activity, changes, context, goal, and empty selection safely", () => {
  const value = snapshot()
  assertStringIncludes(inspectorPresentation(value, "activity").markup, "<dd>Working</dd>")
  assertStringIncludes(inspectorPresentation(value, "activity").markup, "<dd>1/2</dd>")

  const changes = inspectorPresentation(value, "changes")
  assertStringIncludes(changes.markup, "src/&lt;unsafe&gt;.ts")
  assertStringIncludes(changes.markup, "+3 −1 · modified")
  assert(!changes.markup.includes("src/<unsafe>.ts"))

  const context = inspectorPresentation(value, "context", () => "STAMP")
  assertStringIncludes(context.markup, "provider/&lt;model&gt;")
  assertStringIncludes(context.markup, "42%")
  assertStringIncludes(context.markup, "$0.1250")
  assertStringIncludes(context.markup, "2 items · STAMP")
  assertStringIncludes(context.markup, "truncation explicit")
  assertStringIncludes(context.markup, 'data-context-receipt-id="receipt" data-context-receipt-item-id="item"')
  assertStringIncludes(context.markup, "Open source")
  assertStringIncludes(context.markup, "Stored revision; staleness checked when opened")
  assertStringIncludes(context.markup, "Source unavailable after reload")

  const goal = inspectorPresentation(value, "goal")
  assertStringIncludes(goal.markup, "Ship &lt;safely&gt;")
  assertStringIncludes(goal.markup, "2/4")
  assertStringIncludes(goal.markup, "Need &amp; review")

  const empty = inspectorPresentation({ connected: false, connectionState: "connecting", sessions: [], agents: [], models: [] }, "activity")
  assertStringIncludes(empty.markup, "Select a session to inspect.")
  assert(goal.signature !== context.signature)
})

Deno.test("inspector run presentation exposes only actions valid for pending, retained, and discarded runs", () => {
  const value = snapshot()
  value.runGroups = [{
    id: "group",
    title: "Compare <models>",
    repository: "/repo",
    baseRef: "main",
    promptReceiptID: "receipt",
    isolation: "worktree",
    createdAt: 1,
    runs: [
      { id: "pending", model: "one", phase: "failed", session: { sessionID: "pending", directory: "pending", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
      { id: "kept", model: "two", phase: "completed", retained: true, session: { sessionID: "kept", directory: "/runs/kept", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
      { id: "discarded", model: "three", phase: "cancelled", discarded: true, session: { sessionID: "discarded", directory: "/runs/discarded", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
    ],
  }]

  const markup = inspectorPresentation(value, "runs").markup
  assertStringIncludes(markup, "Compare &lt;models&gt;")
  assertStringIncludes(markup, "Worktree unavailable; refresh this run group to recover.")
  assertStringIncludes(markup, 'data-run-action="refresh"')
  assertStringIncludes(markup, 'data-run-action="compare"')
  assertStringIncludes(markup, 'data-run-action="fuse"')
  assertStringIncludes(markup, 'data-run-id="kept" data-run-action="open"')
  assert(!markup.includes('run:group:kept:discard"'))
  const discardedStart = markup.indexOf('data-run-id="discarded"')
  const discardedEnd = markup.indexOf("</li>", discardedStart)
  assert(!markup.slice(discardedStart, discardedEnd).includes("inspector-actions"))
})

Deno.test("objective comparison is sortable, export-bound, responsive, and eligibility-aware", () => {
  const value = snapshot()
  value.runGroups = [{
    id: "group",
    title: "Objective rows",
    repository: "/repo",
    baseRef: "main",
    promptReceiptID: "receipt",
    isolation: "worktree",
    createdAt: 1,
    runs: [
      { id: "available", model: "zeta", phase: "completed", session: { sessionID: "available-session", directory: "/run/available", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
      { id: "pending", model: "alpha", phase: "preparing", session: { sessionID: "pending", directory: "/run/pending", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
      { id: "discarded", model: "beta", phase: "cancelled", discarded: true, session: { sessionID: "discarded-session", directory: "/run/discarded", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
      { id: "retained", model: "gamma", phase: "completed", retained: true, session: { sessionID: "retained-session", directory: "/run/retained", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
    ],
  }]
  const row = (runID: string, model: string, tokens?: number, cost?: number): RunComparisonRow => ({ runID, model, status: "completed", elapsedMilliseconds: tokens, changedFiles: tokens ?? 0, additions: tokens ?? 0, deletions: 0, taskOutcomes: "not-recorded", diagnostics: "not-recorded", tokens, cost, complete: true })
  const rows = [row("available", "zeta", 20, 2), row("pending", "alpha", undefined, undefined), row("discarded", "beta", 10, 1), row("retained", "gamma", 30, 3)]
  value.runComparisons = [{ artifactID: "comparison", revision: 4, groupID: "group", rows, updatedAt: 2 }]

  assertEquals(sortRunComparisonRows(rows, { key: "cost", direction: "descending" }).map((entry) => entry.runID), ["retained", "available", "discarded", "pending"])
  const markup = inspectorPresentation(value, "runs", undefined, { comparisonSorts: { comparison: { key: "tokens", direction: "descending" } } }).markup
  assertStringIncludes(markup, 'aria-sort="descending"')
  assertStringIncludes(markup, 'data-comparison-sort="tokens"')
  assertStringIncludes(markup, "Sort rows <select")
  assertStringIncludes(markup, 'data-run-action="export-comparison" data-comparison-artifact-id="comparison" data-comparison-revision="4"')
  assertStringIncludes(markup, "No winner or score is inferred.")
  assert(markup.indexOf('data-run-id="retained"') < markup.indexOf('data-run-id="available"'))
  const comparisonRow = (runID: string): string => {
    const start = markup.indexOf(`<tr data-run-id="${runID}">`)
    return markup.slice(start, markup.indexOf("</tr>", start))
  }
  for (const runID of ["pending", "discarded"]) {
    assertStringIncludes(comparisonRow(runID), "Unavailable")
    assert(!comparisonRow(runID).includes("data-run-action"))
  }
  for (const action of ["open", "diff", "review"]) assertStringIncludes(comparisonRow("retained"), `data-run-action="${action}"`)
  for (const action of ["keep", "discard"]) assert(!comparisonRow("retained").includes(`data-run-action="${action}"`))
  for (const action of ["open", "diff", "review", "keep", "discard"]) assertStringIncludes(comparisonRow("available"), `data-run-action="${action}"`)
})

Deno.test("inspector run presentation exposes standalone worktree failures as exact focus targets", () => {
  const value = snapshot()
  value.worktrees = [{
    id: "worktree",
    mutationID: "mutation",
    owner: "workbench",
    repository: "/repo",
    repositoryID: "git:repo",
    path: "/repo-worktrees/failed",
    branch: "workbench/failed",
    baseRef: "main",
    phase: "failed",
    createdAt: 1,
    updatedAt: 2,
    error: { code: "OPERATION_CONFLICT", message: "Interrupted session creation", retryable: true },
  }]

  const markup = inspectorPresentation(value, "runs").markup
  assertStringIncludes(markup, 'data-worktree-id="worktree"')
  assertStringIncludes(markup, "workbench/failed")
  assertStringIncludes(markup, "Interrupted session creation")
})

Deno.test("inspector lineage and Jobs include OpenCode grandchildren, cycles, and standalone worktrees", () => {
  const value = snapshot()
  value.lineage = [
    { sessionID: "session", rootID: "session", depth: 0, relation: "root", title: "Root", status: { type: "idle" }, updatedAt: 10 },
    { sessionID: "child", parentID: "session", rootID: "session", depth: 1, relation: "child", title: "Child", status: { type: "idle" }, updatedAt: 9 },
    { sessionID: "grandchild", parentID: "child", rootID: "session", depth: 2, relation: "child", title: "Grandchild", status: { type: "busy" }, updatedAt: 11, tokens: 123, cost: 0.25 },
    { sessionID: "cycle-a", parentID: "cycle-b", rootID: "cycle-a", depth: 1, relation: "child", title: "Cycle A", status: { type: "idle" }, updatedAt: 2 },
    { sessionID: "cycle-b", parentID: "cycle-a", rootID: "cycle-a", depth: 1, relation: "child", title: "Cycle B", status: { type: "idle" }, updatedAt: 1 },
  ]
  value.worktrees = [{
    id: "orphan-worktree", mutationID: "mutation", owner: "workbench", repository: "/repo", repositoryID: "git:repo",
    path: "/repo-worktrees/orphan", branch: "workbench/orphan", baseRef: "main", phase: "cleanup-pending", createdAt: 1, updatedAt: 2,
  }]

  const jobs = inspectorPresentation(value, "jobs").markup
  assertStringIncludes(jobs, "Grandchild")
  assertStringIncludes(jobs, "123 tokens")
  assertStringIncludes(jobs, "$0.2500")
  assertStringIncludes(jobs, "workbench/orphan")
  assertStringIncludes(jobs, "Needs input")
  assertStringIncludes(jobs, 'role="search" aria-label="Job filters"')
  assertStringIncludes(jobs, 'data-job-filter="text"')
  assertStringIncludes(jobs, 'data-job-filter="kind"')
  assertStringIncludes(jobs, 'data-job-filter="session"')
  assertStringIncludes(jobs, 'data-job-filter="run"')
  assertStringIncludes(jobs, 'data-job-row data-job-kind="session" data-job-session-id="grandchild"')
  assertStringIncludes(jobs, 'data-job-row data-job-kind="worktree"')

  const lineage = inspectorPresentation(value, "lineage").markup
  assertStringIncludes(lineage, 'aria-level="3"')
  assertStringIncludes(lineage, "Cycle A")
  assertStringIncludes(lineage, "cycle recovered")
})

Deno.test("Jobs needs-input controls route to the session projecting aggregated attention", () => {
  const value = snapshot()
  value.session!.delegations = [{
    partID: "part-delegated", sessionID: "delegated", title: "Delegated attention", status: { type: "idle" }, messages: [], revision: 1,
  }]
  value.session!.questions = [{
    id: "question", sessionID: "delegated", protocol: "v2",
    questions: [{ header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Proceed" }] }],
  }]
  value.lineage = [
    { sessionID: "session", rootID: "session", depth: 0, relation: "root", title: "Selected root", status: { type: "idle" }, updatedAt: 10 },
    { sessionID: "child-attention", parentID: "session", rootID: "session", depth: 1, relation: "child", title: "Child attention", status: { type: "idle" }, updatedAt: 9, questionCount: 1 },
    { sessionID: "grandchild", parentID: "child-attention", rootID: "session", depth: 2, relation: "child", title: "Grandchild work", status: { type: "busy" }, updatedAt: 8 },
    { sessionID: "run-root", rootID: "run-root", depth: 0, relation: "root", title: "Run root", status: { type: "idle" }, updatedAt: 7 },
    { sessionID: "run-child", parentID: "run-root", rootID: "run-root", depth: 1, relation: "child", title: "Run child", status: { type: "idle" }, updatedAt: 6 },
  ]
  value.runGroups = [{
    id: "group", title: "Runs", repository: "/repo", baseRef: "main", promptReceiptID: "receipt", isolation: "worktree", createdAt: 1,
    runs: [
      { id: "rooted", model: "Rooted run", phase: "needs-input", session: { sessionID: "run-child", directory: "/run/rooted", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
      { id: "bounded", model: "Bounded run", phase: "needs-input", session: { sessionID: "run-bounded", directory: "/run/bounded", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
    ],
  }]

  const jobs = inspectorPresentation(value, "jobs").markup
  const row = (label: string): string => {
    const at = jobs.indexOf(`<strong>${label}</strong>`)
    assert(at >= 0, `Missing Jobs row: ${label}`)
    return jobs.slice(jobs.lastIndexOf("<li", at), jobs.indexOf("</li>", at))
  }
  assertStringIncludes(row("Delegated attention"), 'data-job-session="session"')
  assertStringIncludes(row("Child attention"), 'data-job-session="session"')
  assertStringIncludes(row("Grandchild work"), 'data-job-session="grandchild"')
  assertStringIncludes(row("Rooted run"), 'data-job-session="run-root"')
  assertStringIncludes(row("Bounded run"), 'data-job-session="run-bounded"')
  assert(!row("Rooted run").includes("data-run-action"))
  assert(!row("Bounded run").includes("data-run-action"))
})

Deno.test("inspector review exposes bounded finding triage and hides archived artifacts", () => {
  const value = snapshot()
  value.artifacts = [
    { schemaVersion: 1, id: "active-review", kind: "review", sessionID: "session", lifecycle: "active", revision: 3, createdAt: 1, updatedAt: 4, state: "ready", itemCount: 1, stale: false },
    { schemaVersion: 1, id: "archived-review", kind: "review", sessionID: "session", lifecycle: "archived", revision: 2, createdAt: 1, updatedAt: 3, state: "ready", itemCount: 1, stale: false },
  ]
  value.reviewFindings = [{
    sessionID: "session", artifactID: "active-review", artifactRevision: 3, artifactUpdatedAt: 4, stale: false,
    diffHash: `sha256:${"a".repeat(64)}`, findingID: "finding", title: "Unsafe <input>", detail: "Validate & reject it.",
    category: "security", severity: "critical", anchors: [{ file: "src/main.ts", side: "modified", startLine: 2, endLine: 3 }], disposition: "open",
  }]

  const markup = inspectorPresentation(value, "review").markup
  assertStringIncludes(markup, "Unsafe &lt;input&gt;")
  assertStringIncludes(markup, "Validate &amp; reject it.")
  assertStringIncludes(markup, 'data-artifact-action="open-finding"')
  assertStringIncludes(markup, 'data-finding-disposition="fixed"')
  assertStringIncludes(markup, 'data-finding-disposition="accepted-risk"')
  assertStringIncludes(markup, 'role="group" aria-label="Review finding filters"')
  assertStringIncludes(markup, 'data-review-filter="severity"')
  assertStringIncludes(markup, 'data-review-filter="category"')
  assertStringIncludes(markup, 'data-review-filter="disposition"')
  assertStringIncludes(markup, 'data-review-severity="critical" data-review-category="security" data-review-disposition="open"')
  assertStringIncludes(markup, 'role="status" aria-live="polite" data-review-filter-status')
  assertStringIncludes(markup, "1 archived review artifact is hidden")
  assert(!markup.includes('data-artifact-row="archived-review"'))
})

Deno.test("inspector walkthrough presentation is deterministic, escaped, and newest-first", () => {
  const value = snapshot()
  value.walkthroughs = [
    { id: "older", diffHash: "aaaaaaaaaaaaaaaa", model: "one", promptVersion: "1", language: "en", generatedAt: 1, coverage: "complete", stops: [{ id: "old", title: "Old", explanation: "Old", importance: "normal", anchors: [] }] },
    { id: "newer", diffHash: "bbbbbbbbbbbbbbbb", model: "two", promptVersion: "1", language: "en", generatedAt: 2, coverage: "partial", stops: [{ id: "new", title: "New <step>", explanation: "Check & verify", importance: "key-change", anchors: [{ file: "a.ts", side: "modified", startLine: 1, endLine: 1 }] }] },
  ]
  const presentation = inspectorPresentation(value, "walkthrough", (value) => `T${value}`)

  assert(presentation.markup.indexOf("T2") < presentation.markup.indexOf("T1"))
  assertStringIncludes(presentation.markup, "New &lt;step&gt;")
  assertStringIncludes(presentation.markup, "Check &amp; verify")
  assertStringIncludes(presentation.markup, "key-change · 1 anchor")
  assertEquals(presentation.signature, inspectorPresentation(value, "walkthrough", () => "ignored").signature)
})

Deno.test("inspector names records omitted by a bounded transport projection", () => {
  const value = snapshot()
  value.projection = {
    truncated: true,
    limitBytes: 24 * 1024 * 1024,
    encodedBytes: 20 * 1024 * 1024,
    omitted: { contextReceipts: 4, runGroups: 2, worktrees: 3, walkthroughs: 1, walkthroughStops: 6 },
    message: "Some history is temporarily hidden.",
  }

  assertStringIncludes(inspectorPresentation(value, "context").markup, "4 older items are hidden")
  assertStringIncludes(inspectorPresentation(value, "runs").markup, "5 older items are hidden")
  assertStringIncludes(inspectorPresentation(value, "walkthrough").markup, "7 older items are hidden")
  assertStringIncludes(inspectorPresentation(value, "runs").markup, "stored records were not deleted")
})
