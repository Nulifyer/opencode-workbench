import { activityCollapsed, activityWorking, applyPatchFiles, applyPatchSection, attachmentDisplay, attachmentReference, connectionPresentation, currentTodoContent, delegationCompletionSummary, diffLineKind, fileReference, fileUriFromPath, formatDuration, isCompactionMessage, isGoalContinuationMessage, mergeRevisionValues, pastedTextReference, patchActivityLabel, permissionPresentation, questionAnswerValues, reasoningDetail, reasoningSummary, runtimeServicePresentation, sessionGroup, sessionLoadPhase, shouldCollapsePaste, shouldSubmitComposerKey, toolKind, turnContent, workspaceMentionReference } from "../src/webview/presentation.ts"

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
}

Deno.test("recognizes compaction-only user messages as timeline markers", () => {
  const compacted = isCompactionMessage({
    info: { id: "message", sessionID: "session", role: "user" },
    parts: [{ id: "part", messageID: "message", sessionID: "session", type: "compaction" }],
  })
  if (!compacted) throw new Error("Compaction marker was treated as an empty user prompt")
})

Deno.test("recognizes tagged and legacy goal continuations without hiding ordinary prompts", () => {
  const message = (part: Record<string, unknown>, role: "user" | "assistant" = "user") => ({
    info: { id: "message", sessionID: "session", role },
    parts: [{ id: "part", messageID: "message", sessionID: "session", type: "text", ...part }],
  })
  if (!isGoalContinuationMessage(message({
    text: "Continue toward the goal.",
    synthetic: true,
    metadata: { "opencode-workbench": { kind: "goal-continuation", version: 1 } },
  }))) throw new Error("Tagged goal continuation was treated as an empty user prompt")
  if (!isGoalContinuationMessage(message({
    text: "Continue working autonomously toward the active goal. Call get_goal first.",
    synthetic: true,
  }))) throw new Error("Existing untagged goal continuation was not recognized")
  if (isGoalContinuationMessage(message({ text: "Internal context", synthetic: true })) ||
    isGoalContinuationMessage(message({ text: "Continue working autonomously toward the active goal.", synthetic: false })) ||
    isGoalContinuationMessage(message({ text: "Continue working autonomously toward the active goal.", synthetic: true }, "assistant"))) {
    throw new Error("An ordinary or non-user message was classified as a goal continuation")
  }
})

Deno.test("groups sessions by actionable state before age", () => {
  const now = new Date(2026, 7, 2, 12).getTime()
  const start = new Date(now).setHours(0, 0, 0, 0)
  const day = 24 * 60 * 60 * 1_000
  const base = { id: "s", title: "Session", status: { type: "idle" as const }, unread: 0, updatedAt: now }
  assertEquals(sessionGroup({ ...base, questionCount: 1, attention: 1 }, now), "Needs input")
  assertEquals(sessionGroup({ ...base, status: { type: "error" } }, now), "Needs input")
  assertEquals(sessionGroup({ ...base, status: { type: "busy" } }, now), "Working")
  assertEquals(sessionGroup({ ...base, unread: 1 }, now), "Completed")
  assertEquals(sessionGroup(base, now), "Today")
  assertEquals(sessionGroup({ ...base, updatedAt: start - 1 }, now), "Yesterday")
  assertEquals(sessionGroup({ ...base, updatedAt: start - 2 * day }, now), "Previous 7 days")
  assertEquals(sessionGroup({ ...base, updatedAt: start - 8 * day }, now), "Older")
})

Deno.test("distinguishes initial transcript hydration from background refresh", () => {
  assertEquals(sessionLoadPhase(undefined), "none")
  assertEquals(sessionLoadPhase({ loaded: false, loadState: "idle" }), "initial")
  assertEquals(sessionLoadPhase({ loaded: false, loadState: "loading" }), "initial")
  assertEquals(sessionLoadPhase({ loaded: true, loadState: "loading" }), "refreshing")
  assertEquals(sessionLoadPhase({ loaded: true, loadState: "ready" }), "ready")
  assertEquals(sessionLoadPhase({ loaded: true, loadState: "error" }), "error")
})

Deno.test("connection presentation stays quiet while loading and warns after failure", () => {
  assertEquals(connectionPresentation("connecting"), { showNotice: false, label: "", title: "", message: "" })
  assertEquals(connectionPresentation("connected"), { showNotice: false, label: "", title: "", message: "" })
  assertEquals(connectionPresentation("reconnecting"), { showNotice: true, label: "Reconnecting", title: "Reconnecting to OpenCode", message: "The OpenCode connection failed. Workbench is retrying automatically." })
  assertEquals(connectionPresentation("failed", "No server"), { showNotice: true, label: "Offline", title: "OpenCode is offline", message: "No server" })
})

Deno.test("work activity stays expanded while active and collapses on completion", () => {
  assertEquals(activityWorking(true, "assistant-step-one", ["assistant-step-one"]), true)
  assertEquals(activityWorking(true, "assistant-step-two", ["assistant-step-one"]), false)
  assertEquals(activityWorking(false, "assistant-step-one", ["assistant-step-one"]), false)
  assertEquals(activityCollapsed(true, false, true, true), false)
  assertEquals(activityCollapsed(false, true, false, false), true)
  assertEquals(activityCollapsed(false, false, false, true), false)
  assertEquals(activityCollapsed(false, false, undefined, undefined), true)
})

Deno.test("summarizes reasoning and tool presentation", () => {
  assertEquals(reasoningSummary("\n**Inspecting** `src/main.ts`\nMore"), "Inspecting src/main.ts")
  assertEquals(reasoningDetail("Planning repo exploration"), "")
  assertEquals(reasoningDetail("A long single-line thought stays in the summary without being repeated in the detail."), "")
  assertEquals(reasoningDetail("Planning repo exploration\n\nInspect package manifests."), "Inspect package manifests.")
  assertEquals(formatDuration(1_250), "1.3s")
  assertEquals(formatDuration(119_999), "1m 59s")
  assertEquals(delegationCompletionSummary([{ kind: "reasoning" }, { kind: "tool" }, { kind: "output" }]), "1 tool call")
  assertEquals(delegationCompletionSummary([{ kind: "tool" }, { kind: "tool" }], true), "Failed · 2 tool calls")
  assertEquals(delegationCompletionSummary([]), "Completed")
  assertEquals(toolKind({ id: "p", sessionID: "s", messageID: "m", type: "tool", tool: "grep" }), "explore")
  assertEquals(toolKind({ id: "p", sessionID: "s", messageID: "m", type: "tool", tool: "apply_patch" }), "edit")
})

Deno.test("presents OpenCode runtime service contracts accurately", () => {
  assertEquals(runtimeServicePresentation({ id: "typescript", status: "connected", root: "/work" }, "lsp"), { status: "Connected", detail: "/work", healthy: true, tone: "status" })
  assertEquals(runtimeServicePresentation({ id: "broken", status: "error", root: "/work" }, "lsp"), { status: "Error", detail: "/work", healthy: false, tone: "error" })
  assertEquals(runtimeServicePresentation({ id: "prettier", name: "prettier", enabled: true, extensions: [".js", ".ts"] }, "formatter"), { status: "Available", detail: ".js .ts", healthy: true, tone: "status" })
  assertEquals(runtimeServicePresentation({ id: "gofmt", enabled: false, extensions: [".go"] }, "formatter"), { status: "Executable not found", detail: ".go", healthy: false, tone: "error" })
  assertEquals(runtimeServicePresentation({ id: "docs", status: "needs_auth" }, "mcp"), { status: "Authentication required", healthy: false, tone: "warning" })
  assertEquals(runtimeServicePresentation({ id: "off", status: "disabled" }, "mcp"), { status: "Disabled", healthy: false, tone: "muted" })
  assertEquals(runtimeServicePresentation({ id: "fs", status: "connected" }, "mcp"), { status: "Connected", healthy: true, tone: "status" })
})

Deno.test("composer submit ignores IME composition", () => {
  assertEquals(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false }), true)
  assertEquals(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true }), false)
  assertEquals(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }), false)
  assertEquals(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, isComposing: false }), false)
})

Deno.test("composer revision merge preserves concurrent additions and removals", () => {
  const item = (id: string) => ({ id })
  assertEquals(mergeRevisionValues([item("a"), item("remote")], [item("a")], [item("a"), item("local")]), [item("a"), item("remote"), item("local")])
  assertEquals(mergeRevisionValues([item("a"), item("b"), item("remote")], [item("a"), item("b")], [item("a")]), [item("a"), item("remote")])
})

Deno.test("formats attachment references and collapses only substantial pastes", () => {
  assertEquals(attachmentReference("Image", 2), "[Image 2]")
  assertEquals(attachmentReference("PDF", 1), "[PDF 1]")
  assertEquals(pastedTextReference(3, 15), "[Pasted text 3 · ~15 lines]")
  assertEquals(shouldCollapsePaste("one\ntwo"), false)
  assertEquals(shouldCollapsePaste(Array.from({ length: 8 }, (_, index) => String(index)).join("\n")), true)
  assertEquals(shouldCollapsePaste("x".repeat(1_000)), true)
  assertEquals(attachmentDisplay("[Image 1] image.png"), { label: "[Image 1]", name: "image.png" })
  assertEquals(attachmentDisplay("[Pasted text 2 · ~15 lines] pasted-text-2.txt"), { label: "[Pasted text 2 · ~15 lines]", name: "pasted-text-2.txt" })
})

Deno.test("collapsed todos summarize current work", () => {
  assertEquals(currentTodoContent([
    { content: "Queued", status: "pending" },
    { content: "Working now", status: "in_progress" },
  ]), "Working now")
  assertEquals(currentTodoContent([{ content: "Done", status: "completed" }]), "All todos complete")
})

Deno.test("patch labels reflect execution state", () => {
  assertEquals(patchActivityLabel("pending"), "Preparing patch")
  assertEquals(patchActivityLabel("running"), "Preparing patch")
  assertEquals(patchActivityLabel("completed"), "Applied patch")
  assertEquals(patchActivityLabel("error"), "Patch failed")
})

Deno.test("multi-select custom answers preserve checked choices", () => {
  assertEquals(questionAnswerValues(["One", "Two"], "Other", true), ["One", "Two", "Other"])
  assertEquals(questionAnswerValues(["One"], "Other", false), ["Other"])
  assertEquals(questionAnswerValues(["One"], "", true), ["One"])
})

Deno.test("parses relative, absolute, and ranged workspace file references", () => {
  assertEquals(fileReference("src/main.ts:42:3"), { file: "src/main.ts", line: 42, column: 3, endLine: undefined, endColumn: undefined })
  assertEquals(fileReference("/home/user/project/settings.gradle.kts:20-21"), { file: "/home/user/project/settings.gradle.kts", line: 20, column: undefined, endLine: 21, endColumn: undefined })
  assertEquals(fileReference("app/Main.java:10:2-14:8"), { file: "app/Main.java", line: 10, column: 2, endLine: 14, endColumn: 8 })
  assertEquals(fileReference("app/Main.java#L10C2-L14C8"), { file: "app/Main.java", line: 10, column: 2, endLine: 14, endColumn: 8 })
  assertEquals(fileReference("https://example.test/main.ts:2"), undefined)
  assertEquals(fileReference("app/Main.java:14-10"), undefined)
})

Deno.test("parses explicit workspace mentions without requiring a file extension", () => {
  assertEquals(workspaceMentionReference("README"), { file: "README", line: undefined, endLine: undefined })
  assertEquals(workspaceMentionReference("src/main.ts#12-15"), { file: "src/main.ts", line: 12, endLine: 15 })
  assertEquals(workspaceMentionReference("src/main.ts#15-12"), undefined)
})

Deno.test("encodes reserved characters in dropped file paths", () => {
  assertEquals(fileUriFromPath("C:\\repo\\a#b?.ts"), "file:///C:/repo/a%23b%3F.ts")
  assertEquals(fileUriFromPath("C:\\repo\\100% done.ts"), "file:///C:/repo/100%25%20done.ts")
})

Deno.test("summarizes permission requests with visible tool-specific context", () => {
  const base = { id: "permission", sessionID: "session", title: "OpenCode permission", protocol: "current" as const }
  assertEquals(permissionPresentation({ ...base, type: "bash", pattern: ["git:*"], metadata: { command: "git status --short" } }), {
    icon: "#",
    title: "Shell command",
    lines: ["$ git status --short"],
  })
  assertEquals(permissionPresentation({ ...base, type: "read", pattern: ["src/main.ts"], metadata: {} }), {
    icon: "→",
    title: "Read src/main.ts",
    lines: ["Path: src/main.ts"],
  })
  assertEquals(permissionPresentation({ ...base, type: "edit", pattern: ["src/main.ts"], metadata: { filepath: "/work/src/main.ts", diff: "-old\n+new" } }), {
    icon: "→",
    title: "Edit /work/src/main.ts",
    lines: [],
    diff: "-old\n+new",
    file: "/work/src/main.ts",
  })
})

Deno.test("turns apply-patch envelopes into readable per-file diffs", () => {
  const patch = "*** Begin Patch\n*** Update File: src/one.txt\n@@\n-old\n+new\n*** Add File: src/two.txt\n+created\n*** End Patch"
  assertEquals(applyPatchFiles(patch), ["src/one.txt", "src/two.txt"])
  assertEquals(applyPatchSection(patch, "src/one.txt"), "@@\n-old\n+new")
  assertEquals(applyPatchSection(patch, "/work/src/two.txt"), "+created")
  assertEquals(diffLineKind("+new"), "add")
  assertEquals(diffLineKind("-old"), "remove")
  assertEquals(diffLineKind("@@"), "hunk")
  assertEquals(diffLineKind("*** End Patch"), "meta")
})

Deno.test("classifies streamed text after the last process action as final response", () => {
  const base = { sessionID: "s", role: "assistant" as const }
  const content = turnContent([
    { info: { ...base, id: "one" }, parts: [{ id: "intro", sessionID: "s", messageID: "one", type: "text", text: "I will inspect this." }] },
    { info: { ...base, id: "two" }, parts: [{ id: "tool", sessionID: "s", messageID: "two", type: "tool", tool: "read" }] },
    { info: { ...base, id: "three" }, parts: [{ id: "final", sessionID: "s", messageID: "three", type: "text", text: "Inspection complete." }] },
  ])
  assertEquals(content, { hasActivity: true, finalTextPartKeys: ["three:final"] })
})
