import { applyPatchFiles, applyPatchSection, currentTodoContent, diffLineKind, fileReference, formatDuration, markdownFenceEnd, markdownFenceLanguage, patchActivityLabel, questionAnswerValues, reasoningDetail, reasoningSummary, sessionGroup, shouldSubmitComposerKey, toolKind, turnContent } from "../src/webview/presentation.ts"

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
}

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

Deno.test("summarizes reasoning and tool presentation", () => {
  assertEquals(reasoningSummary("\n**Inspecting** `src/main.ts`\nMore"), "Inspecting src/main.ts")
  assertEquals(reasoningDetail("Planning repo exploration"), "")
  assertEquals(reasoningDetail("Planning repo exploration\n\nInspect package manifests."), "Inspect package manifests.")
  assertEquals(formatDuration(1_250), "1.3s")
  assertEquals(formatDuration(119_999), "1m 59s")
  assertEquals(toolKind({ id: "p", sessionID: "s", messageID: "m", type: "tool", tool: "grep" }), "explore")
  assertEquals(toolKind({ id: "p", sessionID: "s", messageID: "m", type: "tool", tool: "apply_patch" }), "edit")
})

Deno.test("composer submit ignores IME composition", () => {
  assertEquals(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false }), true)
  assertEquals(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true }), false)
  assertEquals(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }), false)
  assertEquals(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, isComposing: false }), false)
})

Deno.test("recognizes indented fenced code blocks", () => {
  assertEquals(markdownFenceLanguage("  ```yaml"), "yaml")
  assertEquals(markdownFenceLanguage("\t```"), "")
  assertEquals(markdownFenceLanguage("not a fence"), undefined)
  assertEquals(markdownFenceEnd("  ```  "), true)
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
