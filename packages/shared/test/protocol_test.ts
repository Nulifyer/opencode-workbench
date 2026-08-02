import { parseHostMessage, parseWebviewMessage } from "../src/protocol.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test("validates webview messages", () => {
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: "hello", model: "provider/model" })?.type === "send", "valid send rejected")
  assert(parseWebviewMessage({ type: "send", text: "hello" }) === undefined, "sessionless send accepted")
  assert(parseWebviewMessage({ type: "selectSession", sessionID: "session-1" })?.type === "selectSession", "valid selection rejected")
  assert(parseWebviewMessage({ type: "selectSession", sessionID: "" }) === undefined, "empty selection accepted")
  assert(parseWebviewMessage({ type: "createSession", draft: "Review this workspace" })?.type === "createSession", "valid starter rejected")
  assert(parseWebviewMessage({ type: "reorderQueue", sessionID: "session-1", promptIDs: ["one", "two"] })?.type === "reorderQueue", "valid queue order rejected")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "once" })?.type === "respondPermission", "valid permission response rejected")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "v2", response: "reject", feedback: "Use the sandbox instead" })?.type === "respondPermission", "permission rejection feedback rejected")
  assert(parseWebviewMessage({ type: "respondQuestion", sessionID: "session-1", requestID: "question", answers: [["Yes"]] })?.type === "respondQuestion", "valid question response rejected")
  assert(parseWebviewMessage({ type: "openPatch", sessionID: "session-1", file: "src/main.ts" })?.type === "openPatch", "valid patch request rejected")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "src/main.ts", line: 42, column: 3 })?.type === "openFile", "located file request rejected")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "src/main.ts", line: 42, column: 3, endLine: 48, endColumn: 9 })?.type === "openFile", "file range request rejected")
  assert(parseWebviewMessage({ type: "setAutoApproval", sessionID: "session", enabled: true })?.type === "setAutoApproval", "valid auto approval rejected")
  assert(parseWebviewMessage({ type: "openInEditor" })?.type === "openInEditor", "valid editor request rejected")
  assert(parseWebviewMessage({ type: "openInSidebar" })?.type === "openInSidebar", "valid sidebar request rejected")
  assert(parseWebviewMessage({ type: "navigateBack" })?.type === "navigateBack", "valid back-navigation request rejected")
  assert(parseWebviewMessage({ type: "navigateBack", command: "workbench.action.closeWindow" }) === undefined, "back-navigation command injection accepted")
  assert(parseWebviewMessage({ type: "refresh" })?.type === "refresh", "valid refresh request rejected")
  assert(parseWebviewMessage({ type: "copyText", text: "const ready = true" })?.type === "copyText", "valid block copy rejected")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: "", attachments: [{ name: "image.png", mime: "image/png", data: "eA==" }] })?.type === "send", "attachment-only send rejected")
  assert(parseWebviewMessage({ type: "attachCurrentEditor", sessionID: "session-1" })?.type === "attachCurrentEditor", "current-editor attachment rejected")
  assert(parseWebviewMessage({ type: "resolveDroppedUris", sessionID: "session-1", uris: ["file:///work/main.ts"] })?.type === "resolveDroppedUris", "dropped workspace URI rejected")
  assert(parseWebviewMessage({ type: "searchFiles", sessionID: "session-1", requestID: 1, query: "src/main" })?.type === "searchFiles", "workspace file search rejected")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: "", contextIDs: ["context-1"] })?.type === "send", "context-only send rejected")
  assert(parseWebviewMessage({ type: "removeContextAttachment", sessionID: "session-1", attachmentID: "context-1" })?.type === "removeContextAttachment", "context removal rejected")
  assert(parseWebviewMessage({ type: "attachWorkspacePath", sessionID: "session-1", path: "src/main.ts" })?.type === "attachWorkspacePath", "workspace path attachment rejected")
  assert(parseWebviewMessage({ type: "attachResource", sessionID: "session-1", uri: "mcp://docs" })?.type === "attachResource", "MCP resource attachment rejected")
  assert(parseWebviewMessage({ type: "openPlan", sessionID: "session-1" })?.type === "openPlan", "plan request rejected")
  assert(parseWebviewMessage({ type: "mcpAction", sessionID: "session-1", name: "docs", action: "authenticate" })?.type === "mcpAction", "MCP action rejected")
  assert(parseWebviewMessage({ type: "send", text: "" }) === undefined, "empty send accepted")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: "", attachments: [{ name: "image.png", mime: "image/png", data: "not-base64" }] }) === undefined, "invalid attachment data accepted")
  assert(parseWebviewMessage({ type: "reorderQueue", sessionID: "session-1", promptIDs: ["same", "same"] }) === undefined, "duplicate queue order accepted")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "yes" }) === undefined, "unknown permission response accepted")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "unknown", response: "once" }) === undefined, "unknown permission protocol accepted")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "once", feedback: "unexpected" }) === undefined, "feedback on permission approval accepted")
  assert(parseWebviewMessage({ type: "respondQuestion", sessionID: "session-1", requestID: "question", answers: [[]] })?.type === "respondQuestion", "structurally valid empty answer rejected before controller validation")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "x".repeat(8_193) }) === undefined, "oversized file path accepted")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "src/main.ts", line: 0 }) === undefined, "invalid file line accepted")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "src/main.ts", line: 48, endLine: 42 }) === undefined, "backward file range accepted")
  assert(parseWebviewMessage({ type: "setAutoApproval", sessionID: "session", enabled: true, extra: true }) === undefined, "extra auto approval fields accepted")
  assert(parseWebviewMessage({ type: "setAutoApproval", enabled: true }) === undefined, "sessionless auto approval accepted")
  assert(parseWebviewMessage({ type: "copyText", text: "x".repeat(500_001) }) === undefined, "oversized block copy accepted")
  assert(parseWebviewMessage({ type: "unknown", command: "workbench.action.closeWindow" }) === undefined, "unknown message accepted")
})

Deno.test("validates host snapshots", () => {
  const valid = {
    type: "snapshot",
    snapshot: {
      connected: true,
      sessions: [{ id: "s", title: "Session", status: { type: "idle" }, unread: 0, directory: "/work", updatedAt: 1, attention: 1, questionCount: 1, permissionCount: 0, queued: 1, todo: { completed: 0, total: 1 }, changeCount: 0 }],
      agents: [{ name: "build", model: { providerID: "p", modelID: "m" } }],
      providers: [{ id: "p", name: "Provider", source: "api" }],
      mentionAgents: [{ name: "research", mode: "subagent" }],
      resources: [{ name: "Docs", uri: "mcp://docs", client: "docs" }],
      catalog: { status: "ready", updatedAt: 1 },
      models: [{ id: "m", name: "Model", providerID: "p", contextLimit: 10_000, inputLimit: 8_000, outputLimit: 2_000, capabilities: { reasoning: true, input: { text: true, image: true } }, variants: ["low", "high"] }],
      autoApproval: false,
      runtime: { lsp: [], formatters: [], mcp: [], updatedAt: 1 },
      session: {
        id: "s",
        directory: "/work",
        title: "Session",
        draft: "",
        status: { type: "idle" },
        loadState: "ready",
        messages: [],
        messageRevisions: {},
        variant: "high",
        queue: [{ id: "q", text: "queued", createdAt: 1 }],
        permissions: [{ id: "p", sessionID: "s", title: "Read", protocol: "current", pattern: ["file"], truncated: true }],
        questions: [{ id: "q1", sessionID: "s", protocol: "v2", questions: [{ header: "Choice", question: "Choose", options: [{ label: "Yes", description: "Proceed" }] }] }],
        todos: [{ content: "Task", status: "pending", priority: "high" }],
        changes: [{ file: "src/main.ts", patch: "@@ -1 +1 @@", additions: 1, deletions: 1, status: "modified" }],
        context: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, cost: 0 },
        goal: { objective: "Goal", status: "active", sourceTool: "get_goal", tokensUsed: 42, tokenBudget: 100 },
        delegations: [{ partID: "task-part", sessionID: "child", title: "Inspect child", status: { type: "busy" }, messages: [], revision: 1 }],
      },
    },
  }
  assert(parseHostMessage(valid)?.type === "snapshot", "valid snapshot rejected")
  assert(parseHostMessage({
    type: "messagePatches",
    patches: [{
      sessionID: "s",
      messageID: "m",
      message: { info: { id: "m", sessionID: "s", role: "assistant" }, parts: [{ id: "p", sessionID: "s", messageID: "m", type: "text", text: "stream" }] },
      revision: 2,
      active: true,
      append: true,
      afterMessageID: undefined,
    }],
  })?.type === "messagePatches", "valid message patch rejected")
  assert(parseHostMessage({ type: "insertText", sessionID: "s", text: "@<src/main.ts#1-3>" })?.type === "insertText", "composer insertion rejected")
  assert(parseHostMessage({ type: "fileSuggestions", sessionID: "s", requestID: 1, files: ["src/main.ts"] })?.type === "fileSuggestions", "file suggestions rejected")
  assert(parseHostMessage({ type: "editorContextChanged", context: { name: "Untitled-1", detail: "Unsaved changes", dirty: true } })?.type === "editorContextChanged", "editor context update rejected")
  assert(parseHostMessage({ type: "contextAttachmentsChanged", sessionID: "s", attachments: [{ id: "context-1", name: "main.ts", detail: "Lines 1-3", kind: "selection" }] })?.type === "contextAttachmentsChanged", "context attachments rejected")
  assert(parseHostMessage({ type: "draftChanged", sessionID: "s", draft: "updated", revision: 2 })?.type === "draftChanged", "draft synchronization rejected")
  assert(parseHostMessage({ type: "sessionRemoved", sessionID: "s" })?.type === "sessionRemoved", "session removal rejected")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: { ...valid.snapshot.session, permissions: [{ id: "p", sessionID: "s", title: "Read", protocol: "current", truncated: "yes" }] } } }) === undefined, "invalid permission truncation marker accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: { ...valid.snapshot.session, changes: [{ file: "x", additions: -1, deletions: 0 }] } } }) === undefined, "negative diff count accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: { ...valid.snapshot.session, questions: [{ id: "q", sessionID: "s", protocol: "v2", questions: [] }] } } }) === undefined, "empty question request accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, connected: "yes" } }) === undefined, "invalid snapshot accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, agents: [{ name: 42 }] } }) === undefined, "invalid catalog accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, agents: [{ name: "build", model: { providerID: "", modelID: "m" } }] } }) === undefined, "invalid agent model accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, sessions: [{ id: "s", title: "Session", status: { type: "idle" }, unread: -1 }] } }) === undefined, "invalid session option accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, models: [{ id: "m", name: "Model", providerID: "p", contextLimit: -1 }] } }) === undefined, "invalid context limit accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: { ...valid.snapshot.session, queue: [{ id: "q", text: "x".repeat(200_001), createdAt: 1 }] } } }) === undefined, "oversized queued prompt accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: { ...valid.snapshot.session, permissions: [{ id: "p", sessionID: "s", title: "Read", protocol: "current", metadata: { value: "x".repeat(100_001) } }] } } }) === undefined, "oversized permission metadata accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: { ...valid.snapshot.session, messages: [{ info: { id: "m", sessionID: "s", role: "assistant" }, parts: [{ id: "p", sessionID: "s", messageID: "m", type: "tool", tool: "read", state: { input: { path: "x".repeat(100_001) } } }] }] } } }) === undefined, "oversized tool input accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, runtime: { lsp: Array.from({ length: 501 }, (_, index) => ({ id: String(index) })), formatters: [], mcp: [], updatedAt: 1 } } }) === undefined, "oversized runtime status accepted")
  assert(parseHostMessage({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      session: {
        ...valid.snapshot.session,
        messages: [{
          info: { id: "m", sessionID: "s", role: "assistant" },
          parts: [{ id: "p", sessionID: "s", messageID: "m", type: "tool", state: { title: { unsafe: true } } }],
        }],
      },
    },
  }) === undefined, "non-string tool state accepted")
  assert(parseHostMessage({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      session: { ...valid.snapshot.session, messages: [{ info: { id: "m", sessionID: "s", role: "assistant" }, parts: [{ type: "text" }] }] },
    },
  }) === undefined, "invalid transcript accepted")
})
