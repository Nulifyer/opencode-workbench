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
  const multi = parseWebviewMessage({ type: "sendMultiModel", sessionID: "session-1", text: "implement it", models: ["provider/a", "provider/b", "provider/c"], concurrency: 2 })
  assert(multi?.type === "sendMultiModel" && multi.models.length === 3 && multi.concurrency === 2, "valid multi-model send rejected")
  assert(parseWebviewMessage({ type: "sendMultiModel", sessionID: "session-1", text: "implement it", models: ["provider/a"], concurrency: 1 }) === undefined, "single-model multi-run accepted")
  assert(parseWebviewMessage({ type: "sendMultiModel", sessionID: "session-1", text: "implement it", models: ["provider/a", "provider/a"], concurrency: 1 }) === undefined, "duplicate multi-run model accepted")
  assert(parseWebviewMessage({ type: "sendMultiModel", sessionID: "session-1", text: "implement it", models: ["provider/a", "provider/b"], concurrency: 3 }) === undefined, "multi-run concurrency above candidate count accepted")
  assert(parseWebviewMessage({ type: "sendMultiModel", sessionID: "session-1", text: "", models: ["provider/a", "provider/b"], concurrency: 2 }) === undefined, "taskless multi-run accepted")
  assert(parseWebviewMessage({ type: "selectSession", sessionID: "session-1" })?.type === "selectSession", "valid selection rejected")
  assert(parseWebviewMessage({ type: "selectSession", sessionID: "" }) === undefined, "empty selection accepted")
  assert(parseWebviewMessage({ type: "createSession", draft: "Review this workspace" })?.type === "createSession", "valid starter rejected")
  assert(parseWebviewMessage({ type: "createSession", draft: "Review this workspace", submit: true })?.type === "createSession", "session-creating submit rejected")
  assert(parseWebviewMessage({ type: "createSession", draft: "", submit: true }) === undefined, "empty session-creating submit accepted")
  assert(parseWebviewMessage({ type: "planTask" })?.type === "planTask", "plan-first command rejected")
  assert(parseWebviewMessage({ type: "markAttentionRead" })?.type === "markAttentionRead", "attention acknowledgement rejected")
  assert(parseWebviewMessage({ type: "markAttentionRead", sessionID: "injected" }) === undefined, "attention acknowledgement accepted extra authority")
  assert(parseWebviewMessage({ type: "planTask", command: "workbench.action.closeWindow" }) === undefined, "plan-first command injection accepted")
  assert(parseWebviewMessage({ type: "workbenchAction", sessionID: "session-1", action: "review" })?.type === "workbenchAction", "bounded Workbench action rejected")
  assert(parseWebviewMessage({ type: "workbenchAction", sessionID: "session-1", action: "unknown" }) === undefined, "unknown Workbench action accepted")
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
  const comparisonExport = parseWebviewMessage({ type: "runAction", groupID: "group", action: "export-comparison", comparisonArtifactID: "artifact", comparisonRevision: 3 })
  assert(comparisonExport?.type === "runAction" && comparisonExport.action === "export-comparison" && comparisonExport.comparisonArtifactID === "artifact" && comparisonExport.comparisonRevision === 3, "exact comparison export action rejected")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", action: "export-comparison", comparisonArtifactID: "artifact" }) === undefined, "comparison export without a revision accepted")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", action: "export-comparison", comparisonArtifactID: "artifact", comparisonRevision: 0 }) === undefined, "comparison export with an invalid revision accepted")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", runID: "run", action: "export-comparison", comparisonArtifactID: "artifact", comparisonRevision: 3 }) === undefined, "comparison export accepted unrelated run identity")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", action: "compare", comparisonArtifactID: "artifact", comparisonRevision: 3 }) === undefined, "comparison refresh accepted export authority fields")
  const ptyCancel = parseWebviewMessage({ type: "ptyAction", id: "pty-one", action: "cancel" })
  assert(ptyCancel?.type === "ptyAction" && ptyCancel.id === "pty-one", "PTY cancellation rejected")
  assert(parseWebviewMessage({ type: "ptyAction", id: "pty-one", action: "kill" }) === undefined, "unknown PTY action accepted")
  assert(parseWebviewMessage({ type: "ptyAction", id: "pty-one", action: "cancel", extra: true }) === undefined, "extra PTY action fields accepted")
  assert(parseWebviewMessage({ type: "ptyAction", id: "bad\npty", action: "cancel" }) === undefined, "unsafe PTY ID accepted")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", runID: "run", action: "diff" })?.type === "runAction", "run native diff action rejected")
  assert(parseWebviewMessage({ type: "runAction", groupID: "group", action: "discard" }) === undefined, "run action without run ID accepted")
  assert(parseWebviewMessage({ type: "walkthroughAction", documentID: "walkthrough", stopID: "stop" })?.type === "walkthroughAction", "walkthrough navigation action rejected")
  assert(parseWebviewMessage({ type: "sessionAction", sessionID: "session", action: "fork", messageID: "message" })?.type === "sessionAction", "message fork rejected")
  assert(parseWebviewMessage({ type: "sessionAction", sessionID: "session", action: "retry" })?.type === "sessionAction", "retry action rejected")
  assert(parseWebviewMessage({ type: "sessionAction", sessionID: "session", action: "retry", messageID: "message" })?.type === "sessionAction", "message retry rejected")
  assert(parseWebviewMessage({ type: "sessionAction", sessionID: "session", action: "delete", messageID: "message" }) === undefined, "message ID accepted for an unrelated action")
  assert(parseWebviewMessage({ type: "openInEditor" })?.type === "openInEditor", "valid editor request rejected")
  assert(parseWebviewMessage({ type: "openInEditor", tab: "lineage" })?.type === "openInEditor", "lineage inspector request rejected")
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
  const receiptSource = parseWebviewMessage({ type: "contextReceiptAction", sessionID: "session-1", receiptID: "context:message-1", itemID: "source-1", action: "open-source" })
  assert(receiptSource?.type === "contextReceiptAction" && receiptSource.receiptID === "context:message-1" && receiptSource.itemID === "source-1", "context receipt source opening rejected")
  assert(parseWebviewMessage({ type: "contextReceiptAction", sessionID: "session-1", receiptID: "context:message-1", itemID: "source-1", action: "delete" }) === undefined, "unknown context receipt action accepted")
  assert(parseWebviewMessage({ type: "contextReceiptAction", sessionID: "bad\nsession", receiptID: "context:message-1", itemID: "source-1", action: "open-source" }) === undefined, "unsafe context receipt action identity accepted")
  assert(parseWebviewMessage({ type: "contextReceiptAction", sessionID: "session-1", receiptID: "context:message-1", itemID: "source-1", action: "open-source", uri: "file:///outside" }) === undefined, "context receipt action accepted caller-supplied URI authority")
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

Deno.test("validates help, evidence, and native job actions as exact protocol messages", () => {
  assert(parseWebviewMessage({ type: "openHelp" })?.type === "openHelp", "help request rejected")
  assert(parseWebviewMessage({ type: "openHelp", command: "workbench.action.closeWindow" }) === undefined, "help request accepted an injected command")
  assert(parseWebviewMessage({ type: "evidenceAction", action: "capture" })?.type === "evidenceAction", "evidence capture rejected")
  assert(parseWebviewMessage({ type: "evidenceAction", action: "export" }) === undefined, "unknown evidence action accepted")
  assert(parseWebviewMessage({ type: "evidenceAction", action: "capture", output: "private output" }) === undefined, "evidence action accepted raw output")
  for (const action of ["open", "background"] as const) {
    const parsed = parseWebviewMessage({ type: "jobAction", sessionID: "session-child", action })
    assert(parsed?.type === "jobAction" && parsed.sessionID === "session-child" && parsed.action === action, `${action} job action rejected`)
  }
  assert(parseWebviewMessage({ type: "jobAction", sessionID: "", action: "open" }) === undefined, "sessionless job action accepted")
  assert(parseWebviewMessage({ type: "jobAction", sessionID: "session-child", action: "cancel" }) === undefined, "unknown job action accepted")
  assert(parseWebviewMessage({ type: "jobAction", sessionID: "session-child", action: "open", command: "workbench.action.closeWindow" }) === undefined, "job action accepted an injected command")
})

Deno.test("validates exact Task Workbench pane controls", () => {
  assert(parseHostMessage({ type: "workbenchControl", target: "sessions", action: "toggle" })?.type === "workbenchControl", "sessions toggle rejected")
  assert(parseHostMessage({ type: "workbenchControl", target: "jobs", action: "show" })?.type === "workbenchControl", "jobs show rejected")
  assert(parseHostMessage({ type: "workbenchControl", target: "attention", action: "show" })?.type === "workbenchControl", "attention show rejected")
  assert(parseHostMessage({ type: "workbenchControl", target: "terminal", action: "show" }) === undefined, "unknown Workbench target accepted")
  assert(parseHostMessage({ type: "workbenchControl", target: "sessions", action: "hide", command: "workbench.action.closeWindow" }) === undefined, "unsafe Workbench control accepted")
})

Deno.test("validates native redo as a zero-removal recovery preview", () => {
  const redo = {
    type: "recoveryPreview",
    preview: {
      sessionID: "session-1",
      messageID: "message-1",
      userText: "Original request",
      removedMessageIDs: [],
      removedTurns: 0,
      changedFiles: [],
      limitations: ["OpenCode controls native redo."],
      canRevert: false,
      canFork: false,
      canRedo: true,
    },
  }
  assert(parseHostMessage(redo)?.type === "recoveryPreview", "native redo preview was rejected")
  assert(parseHostMessage({ ...redo, preview: { ...redo.preview, canRedo: false } }) === undefined, "zero-removal non-redo preview was accepted")
  assert(parseHostMessage({ ...redo, preview: { ...redo.preview, canRevert: true } }) === undefined, "zero-removal redo preview also claiming revert was accepted")
  assert(parseHostMessage({ ...redo, preview: { ...redo.preview, removedMessageIDs: ["message-1"] } }) === undefined, "zero-removal redo preview with removed messages was accepted")
})

Deno.test("validates bounded explicit browser-context requests", () => {
  const sources = ["selection", "console", "diagnostics", "debug", "url", "screenshot"] as const
  const parsed = parseWebviewMessage({ type: "browserContextAction", sessionID: "session", action: "capture", task: "Diagnose the selected browser failure", sources: [...sources], approvedUrl: "https://example.test/reproduction" })
  assert(parsed?.type === "browserContextAction" && parsed.sessionID === "session" && parsed.task === "Diagnose the selected browser failure", "structured browser-context request rejected")
  assert(parsed.sources?.join(",") === sources.join(",") && parsed.approvedUrl === "https://example.test/reproduction", "structured browser-context fields were discarded")
  assert(parseWebviewMessage({ type: "browserContextAction", sessionID: "session", action: "capture" })?.type === "browserContextAction", "session-bound host-prompted browser-context fallback rejected")
  assert(parseWebviewMessage({ type: "browserContextAction", action: "capture" }) === undefined, "sessionless browser-context request accepted")
  assert(parseWebviewMessage({ type: "browserContextAction", sessionID: "bad\nsession", action: "capture" }) === undefined, "malformed browser-context session accepted")
  const base = { type: "browserContextAction", sessionID: "session", action: "capture", task: "Diagnose", sources: ["selection"] }
  assert(parseWebviewMessage({ ...base, task: " " }) === undefined, "blank browser-context task accepted")
  assert(parseWebviewMessage({ ...base, task: "x".repeat(20_001) }) === undefined, "oversized browser-context task accepted")
  assert(parseWebviewMessage({ ...base, sources: [] }) === undefined, "browser-context request without a source accepted")
  assert(parseWebviewMessage({ ...base, sources: ["selection", "selection"] }) === undefined, "duplicate browser-context sources accepted")
  assert(parseWebviewMessage({ ...base, sources: ["console", "element"] }) === undefined, "multiple clipboard browser-context sources accepted")
  assert(parseWebviewMessage({ ...base, sources: ["console", "terminal-task"] }) === undefined, "multiple clipboard and terminal sources accepted")
  assert(parseWebviewMessage({ ...base, sources: ["network"] }) === undefined, "unknown browser-context source accepted")
  assert(parseWebviewMessage({ ...base, sources: ["selection", "console", "element", "terminal-task", "diagnostics", "debug", "url", "screenshot", "extra"], approvedUrl: "https://example.test" }) === undefined, "browser-context source limit exceeded")
  assert(parseWebviewMessage({ ...base, sources: ["url"] }) === undefined, "URL source without an approved URL accepted")
  assert(parseWebviewMessage({ ...base, sources: ["url"], approvedUrl: "" }) === undefined, "URL source with an empty approved URL accepted")
  assert(parseWebviewMessage({ ...base, sources: ["url"], approvedUrl: "   " }) === undefined, "URL source with a blank approved URL accepted")
  assert(parseWebviewMessage({ ...base, sources: ["url"], approvedUrl: "x".repeat(8_193) }) === undefined, "oversized approved URL accepted")
  assert(parseWebviewMessage({ ...base, approvedUrl: "https://example.test" }) === undefined, "approved URL accepted without the URL source")
  assert(parseWebviewMessage({ ...base, privateClipboard: "secret" }) === undefined, "browser-context request accepted unrecognized private data")
})

function minimalHostSnapshot(extra: Record<string, unknown> = {}): unknown {
  return {
    type: "snapshot",
    snapshot: {
      connected: true,
      connectionState: "connected",
      sessions: [{ id: "session", title: "Session", status: { type: "idle" }, unread: 0 }],
      agents: [],
      models: [],
      ...extra,
    },
  }
}

Deno.test("validates session rail branch, worktree, and token metadata", () => {
  const row = { id: "session", title: "Session", status: { type: "idle" }, unread: 0, branch: "feature/chat-workbench", worktree: "/worktrees/chat-workbench", tokens: 42 }
  assert(parseHostMessage(minimalHostSnapshot({ sessions: [row] }))?.type === "snapshot", "valid session rail metadata rejected")
  assert(parseHostMessage(minimalHostSnapshot({ sessions: [{ ...row, branch: "b".repeat(2_000), worktree: "w".repeat(8_192), tokens: Number.MAX_SAFE_INTEGER }] }))?.type === "snapshot", "session rail boundary metadata rejected")
  assert(parseHostMessage(minimalHostSnapshot({ sessions: [{ ...row, branch: "b".repeat(2_001) }] })) === undefined, "oversized session branch accepted")
  assert(parseHostMessage(minimalHostSnapshot({ sessions: [{ ...row, worktree: "w".repeat(8_193) }] })) === undefined, "oversized session worktree accepted")
  for (const tokens of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert(parseHostMessage(minimalHostSnapshot({ sessions: [{ ...row, tokens }] })) === undefined, `invalid session token count accepted: ${tokens}`)
  }
})

Deno.test("validates native OpenCode PTY metadata without terminal output", () => {
  const running = { id: "pty-running", title: "Focused tests", command: "deno", args: ["test", "--filter", "protocol"], cwd: "/work", status: "running", pid: 42 }
  const exited = { ...running, id: "pty-exited", status: "exited", pid: 43, exitCode: -2_147_483_648 }
  assert(parseHostMessage(minimalHostSnapshot({ ptys: [running, exited] }))?.type === "snapshot", "valid native PTY metadata rejected")
  assert(parseHostMessage(minimalHostSnapshot({ ptys: [{ ...exited, exitCode: 2_147_483_647 }] }))?.type === "snapshot", "maximum native PTY exit code rejected")
  const invalid = [
    { ...running, id: "bad\npty" },
    { ...running, title: "bad\0title" },
    { ...running, command: "" },
    { ...running, command: "bad\0command" },
    { ...running, cwd: "" },
    { ...running, cwd: "bad\0cwd" },
    { ...running, args: ["bad\0argument"] },
    { ...running, args: Array.from({ length: 257 }, () => "arg") },
    { ...running, args: Array.from({ length: 6 }, () => "a".repeat(20_000)) },
    { ...running, status: "waiting" },
    { ...running, pid: -1 },
    { ...running, pid: 2_147_483_648 },
    { ...exited, exitCode: 1.5 },
    { ...exited, exitCode: 2_147_483_648 },
    { ...running, output: "private terminal output" },
  ]
  for (const [index, pty] of invalid.entries()) {
    assert(parseHostMessage(minimalHostSnapshot({ ptys: [pty] })) === undefined, `invalid native PTY metadata accepted at case ${index}`)
  }
  assert(parseHostMessage(minimalHostSnapshot({ ptys: [running, running] })) === undefined, "duplicate native PTY ID accepted")
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
      lineage: [
        { sessionID: "s", rootID: "s", depth: 0, relation: "root", title: "Session", status: { type: "idle" }, updatedAt: 1, directory: "/work" },
        { sessionID: "child", parentID: "s", rootID: "s", depth: 1, relation: "child", title: "Child", status: { type: "busy" }, updatedAt: 2, model: "p/m", agent: "build", tokens: 20, cost: 0.01 },
      ],
      agents: [{ name: "build", model: { providerID: "p", modelID: "m" } }],
      providers: [{ id: "p", name: "Provider", source: "api" }],
      mentionAgents: [{ name: "research", mode: "subagent" }],
      resources: [{ name: "Docs", uri: "mcp://docs", client: "docs" }],
      catalog: { status: "ready", updatedAt: 1 },
      models: [{ id: "m", name: "Model", providerID: "p", contextLimit: 10_000, inputLimit: 8_000, outputLimit: 2_000, capabilities: { reasoning: true, input: { text: true, image: true } }, variants: ["low", "high"] }],
      autoApproval: false,
      runtime: { lsp: [], formatters: [], mcp: [], updatedAt: 1 },
      ptys: [
        { id: "pty-running", title: "Tests", command: "deno", args: ["test"], cwd: "/work", status: "running", pid: 42 },
        { id: "pty-exited", title: "Build", command: "deno", args: ["task", "build"], cwd: "/work", status: "exited", pid: 43, exitCode: 0 },
      ],
      walkthroughs: [{ id: "walkthrough", diffHash: "abc", model: "p/m", promptVersion: "v1", language: "en", generatedAt: 1, coverage: "complete", stops: [{ id: "stop", title: "Change", explanation: "Inspect this change", importance: "key-change", anchors: [{ file: "src/main.ts", side: "modified", startLine: 1, endLine: 2 }] }] }],
      artifacts: [{ schemaVersion: 1, id: "artifact-1", kind: "review", sessionID: "s", lifecycle: "active", revision: 1, createdAt: 1, updatedAt: 2, state: "ready", itemCount: 1, stale: false }],
      reviewFindings: [{ sessionID: "s", artifactID: "artifact-1", artifactRevision: 1, artifactUpdatedAt: 2, stale: false, diffHash: `sha256:${"a".repeat(64)}`, findingID: "finding-1", title: "Missing guard", detail: "Validate the input.", category: "correctness", severity: "high", anchors: [{ file: "src/main.ts", side: "modified", startLine: 4, endLine: 5 }], disposition: "open" }],
      evidence: [{ id: "evidence-1", kind: "test", label: "Focused tests", status: "passed", observedAt: 2, sessionID: "s", repository: "/work", summary: "All focused tests passed" }],
      runComparisons: [{ artifactID: "comparison-1", revision: 1, groupID: "group-1", updatedAt: 2, rows: [{ runID: "run-1", status: "completed", model: "p/m", changedFiles: 2, additions: 4, deletions: 1, taskOutcomes: "passed", diagnostics: "clean", complete: true }] }],
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
        context: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, usageReported: true, cost: 0 },
        metrics: { tokensUsed: 200, timeUsedSeconds: 90_000, turnsUsed: 9, sampledAt: 100 },
        goal: { id: "goal-2", sequence: 2, objective: "Goal", status: "active", sourceTool: "get_goal", tokensUsed: 42, tokenBudget: 100, timeUsedSeconds: 86_500, turnsUsed: 4, createdAt: 10, sampledAt: 100, archivedGoals: [{ id: "goal-1", sequence: 1, objective: "First goal", status: "complete", tokensUsed: 100, timeUsedSeconds: 3_600, turnsUsed: 5, autoTurns: 2, createdAt: 1, closedAt: 9 }] },
        goalHistory: [{ id: "goal-1", sequence: 1, objective: "First goal", status: "complete", tokensUsed: 100, timeUsedSeconds: 3_600, turnsUsed: 5, autoTurns: 2, createdAt: 1, closedAt: 9 }],
        delegations: [{ partID: "task-part", sessionID: "child", title: "Inspect child", status: { type: "busy" }, messages: [], revision: 1 }],
      },
    },
  }
  assert(parseHostMessage(valid)?.type === "snapshot", "valid snapshot rejected")
  const unreportedUsage = structuredClone(valid)
  unreportedUsage.snapshot.session.context = { ...unreportedUsage.snapshot.session.context, inputTokens: 0, outputTokens: 0, totalTokens: 0, usageReported: false }
  assert(parseHostMessage(unreportedUsage)?.type === "snapshot", "unreported context usage rejected")
  ;(unreportedUsage.snapshot.session.context as Record<string, unknown>).usagePercent = 0
  assert(parseHostMessage(unreportedUsage) === undefined, "unreported context accepted a measured percentage")
  const legacy = structuredClone(valid)
  delete (legacy.snapshot as { artifacts?: unknown }).artifacts
  delete (legacy.snapshot as { reviewFindings?: unknown }).reviewFindings
  delete (legacy.snapshot as { evidence?: unknown }).evidence
  delete (legacy.snapshot as { runComparisons?: unknown }).runComparisons
  delete (legacy.snapshot as { ptys?: unknown }).ptys
  delete (legacy.snapshot as { lineage?: unknown }).lineage
  assert(parseHostMessage(legacy)?.type === "snapshot", "legacy snapshot without durable surfaces rejected")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, lineage: [valid.snapshot.lineage[0], valid.snapshot.lineage[0]] } }) === undefined, "duplicate lineage session accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, lineage: [{ ...valid.snapshot.lineage[0], depth: 101 }] } }) === undefined, "unbounded lineage depth accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, lineage: [{ ...valid.snapshot.lineage[0], transcript: "private" }] } }) === undefined, "transcript escaped through lineage metadata")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, ptys: [{ ...valid.snapshot.ptys[0], output: "private terminal output" }] } }) === undefined, "PTY terminal output escaped metadata validation")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, ptys: [valid.snapshot.ptys[0], valid.snapshot.ptys[0]] } }) === undefined, "duplicate PTY ID accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, ptys: [{ ...valid.snapshot.ptys[0], pid: 1.5 }] } }) === undefined, "invalid PTY pid accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, ptys: Array.from({ length: 501 }, (_, index) => ({ ...valid.snapshot.ptys[0], id: `pty-${index}` })) } }) === undefined, "oversized PTY collection accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, artifacts: [{ ...valid.snapshot.artifacts[0], payload: { objective: "private plan" } }] } }) === undefined, "artifact payload escaped through summary validation")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, reviewFindings: [{ ...valid.snapshot.reviewFindings[0], sessionID: "other" }] } }) === undefined, "cross-session review finding accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, reviewFindings: [{ ...valid.snapshot.reviewFindings[0], rawDiff: "+private" }] } }) === undefined, "raw diff escaped through review finding validation")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, reviewFindings: [valid.snapshot.reviewFindings[0], valid.snapshot.reviewFindings[0]] } }) === undefined, "duplicate review finding accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, reviewFindings: Array.from({ length: 201 }, (_, index) => ({ ...valid.snapshot.reviewFindings[0], findingID: `finding-${index}` })) } }) === undefined, "oversized review finding collection accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, evidence: [{ ...valid.snapshot.evidence[0], rawOutput: "private command output" }] } }) === undefined, "raw evidence output escaped through reference validation")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, runComparisons: [{ ...valid.snapshot.runComparisons[0], rawDiff: "+private change" }] } }) === undefined, "raw diff escaped through run-comparison projection validation")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, artifacts: [{ ...valid.snapshot.artifacts[0], sessionID: "other" }] } }) === undefined, "cross-session artifact summary accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, evidence: [{ ...valid.snapshot.evidence[0], sessionID: "other" }] } }) === undefined, "cross-session evidence reference accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, artifacts: [valid.snapshot.artifacts[0], valid.snapshot.artifacts[0]] } }) === undefined, "duplicate artifact summary accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, evidence: [valid.snapshot.evidence[0], valid.snapshot.evidence[0]] } }) === undefined, "duplicate evidence reference accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, artifacts: [{ ...valid.snapshot.artifacts[0], state: "stale", stale: false }] } }) === undefined, "inconsistent artifact stale state accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, artifacts: Array.from({ length: 501 }, (_, index) => ({ ...valid.snapshot.artifacts[0], id: `artifact-${index}` })) } }) === undefined, "oversized artifact summary collection accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, evidence: Array.from({ length: 2_001 }, (_, index) => ({ ...valid.snapshot.evidence[0], id: `evidence-${index}` })) } }) === undefined, "oversized evidence collection accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, runComparisons: Array.from({ length: 21 }, (_, index) => ({ ...valid.snapshot.runComparisons[0], artifactID: `comparison-${index}` })) } }) === undefined, "oversized run-comparison collection accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, runComparisons: [{ ...valid.snapshot.runComparisons[0], rows: Array.from({ length: 101 }, (_, index) => ({ ...valid.snapshot.runComparisons[0].rows[0], runID: `run-${index}` })) }] } }) === undefined, "run comparison above the multi-run safety limit accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, evidence: [{ ...valid.snapshot.evidence[0], summary: "authorization: Bearer private-token" }] } }) === undefined, "credential-shaped evidence summary accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, session: undefined, artifacts: [] } }) === undefined, "unscoped selected-session artifacts accepted")
  const projected = {
    ...valid,
    snapshot: {
      ...valid.snapshot,
      projection: {
        truncated: true,
        limitBytes: 24 * 1024 * 1024,
        encodedBytes: 1024,
        omitted: { contextReceipts: 2, lineage: 3, runGroups: 1, worktrees: 4, walkthroughStops: 8, taskArtifacts: 3, reviewFindings: 2, evidence: 5, runComparisons: 2, ptys: 2 },
        message: "Some older records are hidden; stored records were not deleted.",
      },
    },
  }
  assert(parseHostMessage(projected)?.type === "snapshot", "bounded snapshot projection metadata was rejected")
  assert(parseHostMessage({ ...projected, snapshot: { ...projected.snapshot, projection: { ...projected.snapshot.projection, encodedBytes: projected.snapshot.projection.limitBytes + 1 } } }) === undefined, "snapshot projection above its declared byte limit was accepted")
  assert(parseHostMessage({ ...projected, snapshot: { ...projected.snapshot, projection: { ...projected.snapshot.projection, omitted: { contextReceipts: 0 } } } }) === undefined, "empty snapshot omission count was accepted")
  assert(parseHostMessage({ ...projected, snapshot: { ...projected.snapshot, projection: { ...projected.snapshot.projection, omitted: { artifacts: 1 } } } }) === undefined, "unknown snapshot omission key was accepted")
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
  const largeHistoryMessages = Array.from({ length: 1_000 }, (_, index) => ({
    info: { id: `older-${index}`, sessionID: "s", role: "user" },
    parts: [{ id: `older-part-${index}`, sessionID: "s", messageID: `older-${index}`, type: "text", text: `Earlier ${index}` }],
  }))
  const largeHistoryPage = {
    type: "historyPage",
    page: {
      ...historyPage.page,
      messages: largeHistoryMessages,
      messageRevisions: Object.fromEntries(largeHistoryMessages.map((message) => [message.info.id, 1])),
    },
  }
  assert(parseHostMessage(largeHistoryPage)?.type === "historyPage", "1,000-message older-history page rejected")
  assert(parseHostMessage({ ...largeHistoryPage, page: { ...largeHistoryPage.page, messages: [...largeHistoryMessages, largeHistoryMessages[0]] } }) === undefined, "oversized older-history page accepted")
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
