import { createOpenCodeMessageID, isOpenCodeMessageID } from "../src/opencode.ts"
import { parseHostMessage, parseWebviewMessage } from "../src/protocol.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test("validates webview messages", () => {
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", promptID: "msg_018bcfe568001234567890abcd", text: "hello", model: "provider/model" })?.type === "send", "valid send rejected")
  const immediate = parseWebviewMessage({ type: "send", sessionID: "session-1", promptID: "msg_018bcfe568001234567890abcd", delivery: "replace", text: "send now" })
  assert(immediate?.type === "send" && immediate.delivery === "replace", "immediate send delivery was rejected or discarded")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", delivery: "restart", text: "hello" }) === undefined, "unknown send delivery accepted")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", promptID: "invalid", text: "hello" }) === undefined, "invalid prompt ID accepted")
  assert(parseWebviewMessage({ type: "send", text: "hello" }) === undefined, "sessionless send accepted")
  assert(parseWebviewMessage({ type: "selectSession", sessionID: "session-1" })?.type === "selectSession", "valid selection rejected")
  assert(parseWebviewMessage({ type: "selectSession", sessionID: "" }) === undefined, "empty selection accepted")
  assert(parseWebviewMessage({ type: "createSession", draft: "Review this workspace" })?.type === "createSession", "valid starter rejected")
  assert(parseWebviewMessage({ type: "createSession", draft: "Review this workspace", submit: true })?.type === "createSession", "session-creating submit rejected")
  assert(parseWebviewMessage({ type: "createSession", draft: "", submit: true }) === undefined, "empty session-creating submit accepted")
  assert(parseWebviewMessage({ type: "planTask" })?.type === "planTask", "plan-first command rejected")
  assert(parseWebviewMessage({ type: "planTask", command: "workbench.action.closeWindow" }) === undefined, "plan-first command injection accepted")
  assert(parseWebviewMessage({ type: "loadOlderHistory", sessionID: "session-1", beforeMessageID: "message-200" })?.type === "loadOlderHistory", "older-history request rejected")
  assert(parseWebviewMessage({ type: "loadOlderHistory", sessionID: "session-1", beforeMessageID: "" }) === undefined, "empty older-history cursor accepted")
  assert(parseWebviewMessage({ type: "reorderQueue", sessionID: "session-1", promptIDs: ["one", "two"] })?.type === "reorderQueue", "valid queue order rejected")
  assert(parseWebviewMessage({ type: "editQueued", sessionID: "session-1", promptID: "msg_018bcfe568001234567890abcd" })?.type === "editQueued", "queued prompt edit rejected")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "once" })?.type === "respondPermission", "valid permission response rejected")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "exact" })?.type === "respondPermission", "exact permission response rejected")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "scope", scope: "deno test *" })?.type === "respondPermission", "session scope permission response rejected")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "v2", response: "reject", feedback: "Use the sandbox instead" })?.type === "respondPermission", "permission rejection feedback rejected")
  assert(parseWebviewMessage({ type: "respondQuestion", sessionID: "session-1", requestID: "question", answers: [["Yes"]] })?.type === "respondQuestion", "valid question response rejected")
  assert(parseWebviewMessage({ type: "openPatch", sessionID: "session-1", file: "src/main.ts" })?.type === "openPatch", "valid patch request rejected")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "src/main.ts", line: 42, column: 3 })?.type === "openFile", "located file request rejected")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "src/main.ts", line: 42, column: 3, endLine: 48, endColumn: 9 })?.type === "openFile", "file range request rejected")
  assert(parseWebviewMessage({ type: "setAutoApproval", sessionID: "session", enabled: true })?.type === "setAutoApproval", "valid auto approval rejected")
  assert(parseWebviewMessage({ type: "goalAction", sessionID: "session", action: "pause" })?.type === "goalAction", "valid goal action rejected")
  assert(parseWebviewMessage({ type: "goalAction", sessionID: "session", action: "configure" })?.type === "goalAction", "goal configuration action rejected")
  assert(parseWebviewMessage({ type: "goalAction", sessionID: "session", action: "verify" })?.type === "goalAction", "goal verification action rejected")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", action: "compare" })?.type === "runAction", "group comparison action rejected")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", runID: "run", action: "diff" })?.type === "runAction", "run native diff action rejected")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", action: "discard" }) === undefined, "run action without run ID accepted")
  assert(parseWebviewMessage({ type: "walkthroughAction", documentID: "walkthrough", stopID: "stop" })?.type === "walkthroughAction", "walkthrough navigation action rejected")
  assert(parseWebviewMessage({ type: "sessionAction", sessionID: "session", action: "fork", messageID: "message" })?.type === "sessionAction", "message fork rejected")
  assert(parseWebviewMessage({ type: "sessionAction", sessionID: "session", action: "retry" })?.type === "sessionAction", "retry action rejected")
  assert(parseWebviewMessage({ type: "sessionAction", sessionID: "session", action: "retry", messageID: "message" })?.type === "sessionAction", "message retry rejected")
  assert(parseWebviewMessage({ type: "sessionAction", sessionID: "session", action: "delete", messageID: "message" }) === undefined, "message ID accepted for an unrelated action")
  assert(parseWebviewMessage({ type: "openInEditor" })?.type === "openInEditor", "valid editor request rejected")
  assert(parseWebviewMessage({ type: "openInSidebar" })?.type === "openInSidebar", "valid sidebar request rejected")
  assert(parseWebviewMessage({ type: "navigateBack" })?.type === "navigateBack", "valid back-navigation request rejected")
  assert(parseWebviewMessage({ type: "navigateBack", command: "workbench.action.closeWindow" }) === undefined, "back-navigation command injection accepted")
  assert(parseWebviewMessage({ type: "refresh" })?.type === "refresh", "valid refresh request rejected")
  assert(parseWebviewMessage({ type: "openLogs" })?.type === "openLogs", "open logs request rejected")
  assert(parseWebviewMessage({ type: "openFolder" })?.type === "openFolder", "open folder request rejected")
  assert(parseWebviewMessage({ type: "reloadWindow" })?.type === "reloadWindow", "reload window request rejected")
  assert(parseWebviewMessage({ type: "copyText", text: "const ready = true" })?.type === "copyText", "valid block copy rejected")
  const image = { id: "image-1", label: "[Image 1]", name: "image.png", mime: "image/png", data: "eA==", size: 1 }
  const paste = { id: "paste-1", label: "[Pasted text 1 · ~3 lines]", text: "one\ntwo\nthree", lineCount: 3 }
  const longLinePaste = { id: "paste-line", label: "[Pasted text 1 · ~1 lines]", text: "x".repeat(1_000), lineCount: 1 }
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: "", attachments: [image] })?.type === "send", "attachment-only send rejected")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: paste.label, pastedText: [paste] })?.type === "send", "pasted-text send rejected")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: longLinePaste.label, pastedText: [longLinePaste] })?.type === "send", "single-line collapsed paste rejected")
  assert(parseWebviewMessage({ type: "setComposerPayload", sessionID: "session-1", revision: 0, mutationID: "cmp_0123456789abcdef0123456789abcdef", attachments: [image], pastedText: [paste] })?.type === "setComposerPayload", "composer payload rejected")
  const images = Array.from({ length: 10 }, (_, index) => ({ ...image, id: `image-${index}`, label: `[Image ${index + 1}]` }))
  const pastes = Array.from({ length: 11 }, (_, index) => ({ ...paste, id: `paste-${index}`, label: `[Pasted text ${index + 1} · ~3 lines]` }))
  assert(parseWebviewMessage({ type: "setComposerPayload", sessionID: "session-1", revision: 1, mutationID: "cmp_0123456789abcdef0123456789abcdef", attachments: images, pastedText: pastes.slice(0, 10) })?.type === "setComposerPayload", "combined composer attachment limit rejected")
  assert(parseWebviewMessage({ type: "setComposerPayload", sessionID: "session-1", revision: 1, mutationID: "cmp_0123456789abcdef0123456789abcdef", attachments: images, pastedText: pastes }) === undefined, "combined composer attachment limit exceeded")
  assert(parseWebviewMessage({ type: "attachCurrentEditor", sessionID: "session-1" })?.type === "attachCurrentEditor", "current-editor attachment rejected")
  assert(parseWebviewMessage({ type: "resolveDroppedUris", sessionID: "session-1", uris: ["file:///work/main.ts"] })?.type === "resolveDroppedUris", "dropped workspace URI rejected")
  assert(parseWebviewMessage({ type: "searchFiles", sessionID: "session-1", requestID: 1, query: "src/main" })?.type === "searchFiles", "workspace file search rejected")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: "", contextIDs: ["context-1"] })?.type === "send", "context-only send rejected")
  assert(parseWebviewMessage({ type: "removeContextAttachment", sessionID: "session-1", attachmentID: "context-1" })?.type === "removeContextAttachment", "context removal rejected")
  assert(parseWebviewMessage({ type: "openContextAttachment", sessionID: "session-1", attachmentID: "context-1" })?.type === "openContextAttachment", "context opening rejected")
  assert(parseWebviewMessage({ type: "attachWorkspacePath", sessionID: "session-1", path: "src/main.ts" })?.type === "attachWorkspacePath", "workspace path attachment rejected")
  assert(parseWebviewMessage({ type: "attachResource", sessionID: "session-1", uri: "mcp://docs" })?.type === "attachResource", "MCP resource attachment rejected")
  assert(parseWebviewMessage({ type: "openPlan", sessionID: "session-1" })?.type === "openPlan", "plan request rejected")
  assert(parseWebviewMessage({ type: "mcpAction", sessionID: "session-1", name: "docs", action: "authenticate" })?.type === "mcpAction", "MCP action rejected")
  assert(parseWebviewMessage({ type: "send", text: "" }) === undefined, "empty send accepted")
  assert(parseWebviewMessage({ type: "send", sessionID: "session-1", text: "", attachments: [{ ...image, data: "not-base64" }] }) === undefined, "invalid attachment data accepted")
  assert(parseWebviewMessage({ type: "reorderQueue", sessionID: "session-1", promptIDs: ["same", "same"] }) === undefined, "duplicate queue order accepted")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "yes" }) === undefined, "unknown permission response accepted")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "always" }) === undefined, "broad always permission response accepted")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "scope" }) === undefined, "missing reusable permission scope accepted")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "once", scope: "deno *" }) === undefined, "scope accepted for one-time permission")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "unknown", response: "once" }) === undefined, "unknown permission protocol accepted")
  assert(parseWebviewMessage({ type: "respondPermission", sessionID: "session-1", requestID: "request", protocol: "current", response: "once", feedback: "unexpected" }) === undefined, "feedback on permission approval accepted")
  assert(parseWebviewMessage({ type: "respondQuestion", sessionID: "session-1", requestID: "question", answers: [[]] })?.type === "respondQuestion", "structurally valid empty answer rejected before controller validation")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "x".repeat(8_193) }) === undefined, "oversized file path accepted")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "src/main.ts", line: 0 }) === undefined, "invalid file line accepted")
  assert(parseWebviewMessage({ type: "openFile", sessionID: "session-1", file: "src/main.ts", line: 48, endLine: 42 }) === undefined, "backward file range accepted")
  assert(parseWebviewMessage({ type: "setAutoApproval", sessionID: "session", enabled: true, extra: true }) === undefined, "extra auto approval fields accepted")
  assert(parseWebviewMessage({ type: "setAutoApproval", enabled: true }) === undefined, "sessionless auto approval accepted")
  assert(parseWebviewMessage({ type: "goalAction", sessionID: "session", action: "delete" }) === undefined, "invalid goal action accepted")
  assert(parseWebviewMessage({ type: "copyText", text: "x".repeat(500_001) }) === undefined, "oversized block copy accepted")
  assert(parseWebviewMessage({ type: "unknown", command: "workbench.action.closeWindow" }) === undefined, "unknown message accepted")
})

Deno.test("creates chronologically sortable OpenCode message IDs", () => {
  const first = createOpenCodeMessageID(1_700_000_000_000)
  const second = createOpenCodeMessageID(1_700_000_000_000)
  const third = createOpenCodeMessageID(1_700_000_000_001)
  assert(isOpenCodeMessageID(first) && isOpenCodeMessageID(second) && isOpenCodeMessageID(third), "generated an incompatible OpenCode message ID")
  assert(first < second && second < third, "message IDs do not preserve chronological order")
  assert(!isOpenCodeMessageID("msg_0123456789abcdef0123456789abcdef"), "UUID-style message ID was accepted")
})

Deno.test("validates host snapshots", () => {
  const valid = {
    type: "snapshot",
    snapshot: {
      connected: true,
      connectionState: "connected",
      sessions: [{ id: "s", title: "Session", status: { type: "idle" }, unread: 0, directory: "/work", updatedAt: 1, attention: 1, questionCount: 1, permissionCount: 0, queued: 1, todo: { completed: 0, total: 1 }, changeCount: 0 }],
      agents: [{ name: "build", model: { providerID: "p", modelID: "m" } }],
      providers: [{ id: "p", name: "Provider", source: "api" }],
      mentionAgents: [{ name: "research", mode: "subagent" }],
      resources: [{ name: "Docs", uri: "mcp://docs", client: "docs" }],
      catalog: { status: "ready", updatedAt: 1 },
      models: [{ id: "m", name: "Model", providerID: "p", contextLimit: 10_000, inputLimit: 8_000, outputLimit: 2_000, capabilities: { reasoning: true, input: { text: true, image: true } }, variants: ["low", "high"] }],
      autoApproval: false,
      runtime: { lsp: [], formatters: [], mcp: [], updatedAt: 1 },
      walkthroughs: [{ id: "walkthrough", diffHash: "abc", model: "p/m", promptVersion: "v1", language: "en", generatedAt: 1, coverage: "complete", stops: [{ id: "stop", title: "Change", explanation: "Inspect this change", importance: "key-change", anchors: [{ file: "src/main.ts", side: "modified", startLine: 1, endLine: 2 }] }] }],
      session: {
        id: "s",
        directory: "/work",
        title: "Session",
        draft: "",
        status: { type: "idle" },
        loaded: true,
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
  const projected = {
    ...valid,
    snapshot: {
      ...valid.snapshot,
      projection: {
        truncated: true,
        limitBytes: 24 * 1024 * 1024,
        encodedBytes: 1024,
        omitted: { contextReceipts: 2, runGroups: 1, worktrees: 4, walkthroughStops: 8 },
        message: "Some older records are hidden; stored records were not deleted.",
      },
    },
  }
  assert(parseHostMessage(projected)?.type === "snapshot", "bounded snapshot projection metadata was rejected")
  assert(parseHostMessage({ ...projected, snapshot: { ...projected.snapshot, projection: { ...projected.snapshot.projection, encodedBytes: projected.snapshot.projection.limitBytes + 1 } } }) === undefined, "snapshot projection above its declared byte limit was accepted")
  assert(parseHostMessage({ ...projected, snapshot: { ...projected.snapshot, projection: { ...projected.snapshot.projection, omitted: { contextReceipts: 0 } } } }) === undefined, "empty snapshot omission count was accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: { ...valid.snapshot.session, history: { totalMessages: 6_000, visibleMessages: 0, hasOlder: true, limitedBy: "messages" } } } })?.type === "snapshot", "bounded transcript metadata was rejected")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: { ...valid.snapshot.session, history: { totalMessages: 6_000, visibleMessages: 1, hasOlder: true } } } }) === undefined, "history metadata disagreed with the projected transcript")
  const goalMarker: unknown = structuredClone(valid)
  const markerSession = (goalMarker as { snapshot: { session: { messages: unknown[]; messageRevisions: Record<string, number> } } }).snapshot.session
  markerSession.messages = [{
    info: { id: "goal-message", sessionID: "s", role: "user" },
    parts: [{
      id: "goal-part",
      sessionID: "s",
      messageID: "goal-message",
      type: "text",
      text: "Continue working autonomously toward the active goal.",
      synthetic: true,
      metadata: { "opencode-workbench": { kind: "goal-continuation", version: 1 } },
    }],
  }]
  markerSession.messageRevisions = { "goal-message": 1 }
  assert(parseHostMessage(goalMarker)?.type === "snapshot", "goal continuation metadata was rejected from the host snapshot")
  const inconsistentConnection = structuredClone(valid)
  inconsistentConnection.snapshot.connectionState = "failed"
  assert(!parseHostMessage(inconsistentConnection), "contradictory connection state was accepted")
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
  const historyPage = {
    type: "historyPage",
    page: {
      sessionID: "s",
      messages: [{ info: { id: "older", sessionID: "s", role: "user" }, parts: [{ id: "older-part", sessionID: "s", messageID: "older", type: "text", text: "Earlier" }] }],
      messageRevisions: { older: 1 },
      hasOlder: true,
      totalMessages: 6_000,
      sourceMayBeTruncated: false,
    },
  }
  assert(parseHostMessage(historyPage)?.type === "historyPage", "valid older-history page rejected")
  assert(parseHostMessage({ ...historyPage, page: { ...historyPage.page, sessionID: "other" } }) === undefined, "cross-session older-history page accepted")
  assert(parseHostMessage({ type: "insertText", sessionID: "s", text: "@<src/main.ts#1-3>" })?.type === "insertText", "composer insertion rejected")
  assert(parseHostMessage({ type: "fileSuggestions", sessionID: "s", requestID: 1, files: ["src/main.ts"] })?.type === "fileSuggestions", "file suggestions rejected")
  assert(parseHostMessage({ type: "editorContextChanged", context: { name: "Untitled-1", detail: "Unsaved changes", dirty: true, attached: false } })?.type === "editorContextChanged", "editor context update rejected")
  assert(parseHostMessage({ type: "contextAttachmentsChanged", sessionID: "s", attachments: [{ id: "context-1", name: "main.ts", detail: "Lines 1-3", kind: "selection" }] })?.type === "contextAttachmentsChanged", "context attachments rejected")
  assert(parseHostMessage({ type: "composerPayloadChanged", sessionID: "s", revision: 1, attachments: [{ id: "image-1", label: "[Image 1]", name: "image.png", mime: "image/png", data: "eA==", size: 1 }], pastedText: [{ id: "paste-1", label: "[Pasted text 1 · ~3 lines]", text: "one\ntwo\nthree", lineCount: 3 }] })?.type === "composerPayloadChanged", "composer payload update rejected")
  assert(parseHostMessage({ type: "composerPayloadChanged", sessionID: "s", revision: 2, attachments: [], pastedText: [], conflict: true })?.type === "composerPayloadChanged", "composer conflict update rejected")
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
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, walkthroughs: [{ ...valid.snapshot.walkthroughs[0], stops: [{ ...valid.snapshot.walkthroughs[0].stops[0], anchors: [] }] }] } }) === undefined, "walkthrough without anchors accepted")
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
