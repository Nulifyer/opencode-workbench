import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert"
import type { ChatSnapshot } from "@opencode-workbench/shared"
import { inspectorPresentation } from "../src/webview/views/inspector/presentation.ts"

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
        items: [{ id: "item", kind: "file", label: "File" }],
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
  assertStringIncludes(context.markup, "STAMP · explicit")

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
