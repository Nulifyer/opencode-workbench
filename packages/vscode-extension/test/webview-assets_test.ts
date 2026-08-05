const css = await Deno.readTextFile(new URL("../media/chat.css", import.meta.url))
const webview = await Deno.readTextFile(new URL("../src/webview/main.ts", import.meta.url))
const chatView = await Deno.readTextFile(new URL("../src/views/chat-view.ts", import.meta.url))

Deno.test("reduced motion preserves operational progress animations", () => {
  const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
  if (/\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none/i.test(reducedMotion) ||
    /body\.vscode-reduce-motion\s+\*[^{}]*\{[^}]*animation:\s*none/i.test(reducedMotion)) {
    throw new Error("Reduced-motion styles globally disabled operational animations")
  }
  for (const animation of ["braille-spin", "throbber-scan", "stopping-pulse", "session-retry"]) {
    if (!css.includes(`animation: ${animation}`)) throw new Error(`Operational animation ${animation} is missing`)
  }
  if (!reducedMotion.includes(".turn.activity-expanding .assistant-process") || !reducedMotion.includes("animation: none !important")) {
    throw new Error("Reduced-motion styles did not suppress the decorative activity expansion")
  }
})

Deno.test("permission Allow menu uses a centered down-chevron icon", () => {
  if (!webview.includes("${CHEVRON_DOWN_ICON}</summary>") || webview.includes(">⌄</summary>")) {
    throw new Error("Permission Allow menu still uses a text arrow")
  }
  if (!css.includes(".permission-card .permission-allow-menu > summary svg") || !css.includes("place-items: center")) {
    throw new Error("Permission Allow menu does not size and center its chevron icon")
  }
})

Deno.test("workspace detail popovers escape the muted status stacking context", () => {
  const stripRule = /\.workspace-strip\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
  if (/\bopacity\s*:/.test(stripRule)) throw new Error("Workspace strip opacity traps detail popovers behind the composer stacking context")
  if (!css.includes(".workspace-left, .workspace-right > span, .workspace-detail > summary { opacity: .78; }") ||
    !/\.workspace-detail-popover\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*30;/.test(css)) {
    throw new Error("Workspace status text or detail popover stacking is not configured correctly")
  }
  for (const kind of ["lsp", "formatter", "mcp", "context"]) {
    if (!webview.includes(`workspaceDetail("${kind}"`)) throw new Error(`Workspace ${kind} detail popover is missing`)
  }
  if (!webview.includes('.workspace-detail[open]')) {
    throw new Error("Workspace detail popovers do not close on Escape, outside click, or sibling activation")
  }
})

Deno.test("non-final assistant text renders as distinct update activity", () => {
  if (!/else processBody \+= `<div class="assistant-update">/.test(webview)) {
    throw new Error("Non-final assistant text is not rendered as a labeled update")
  }
  if (webview.includes('<section class="assistant-update"') || webview.includes('class="assistant-update" aria-label=')) {
    throw new Error("Assistant updates create repetitive named landmarks")
  }
  if (!css.includes(".assistant-update {") || !css.includes(".assistant-update-label {")) {
    throw new Error("Assistant updates do not have distinct activity styling")
  }
})

Deno.test("synthetic goal continuations render as timeline markers instead of sent-message placeholders", () => {
  const marker = webview.indexOf("if (isGoalContinuationMessage(message))")
  const placeholder = webview.indexOf("Message failed before its content was saved")
  if (marker < 0 || placeholder < 0 || marker > placeholder || !webview.includes("Goal continued automatically")) {
    throw new Error("Goal continuation messages can still fall through to the empty user-message placeholder")
  }
})

Deno.test("empty messages and session failures expose actionable explanations", () => {
  if (!webview.includes("Saving message…") || !webview.includes("Message failed before its content was saved") ||
    !webview.includes("Error: ${escapeHtml(statusError)}") || !css.includes("#status.error") || !css.includes(".message-failure")) {
    throw new Error("Chat failures can still collapse into an unexplained placeholder or status")
  }
})

Deno.test("offline notice uses a theme-safe muted warning surface", () => {
  const rule = /\.notice\.offline\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
  if (!rule.includes("color: var(--vscode-foreground)") || !rule.includes("background: color-mix")) {
    throw new Error("Offline notice does not preserve readable foreground contrast")
  }
  if (rule.includes("var(--vscode-inputValidation-warningBackground")) {
    throw new Error("Offline notice still uses the high-intensity validation warning background")
  }
})

Deno.test("connection warnings are driven by settled connection state rather than a timer", () => {
  if (webview.includes("offlineNoticeTimer") || webview.includes("offlineNoticeVisible")) {
    throw new Error("Connection warning still relies on a startup timeout")
  }
  if (!webview.includes("connectionPresentation(snapshot.connectionState")) {
    throw new Error("Connection warning does not distinguish loading from failure")
  }
  if (!chatView.includes('update.type === "connected" && update.connected') || !chatView.includes("this.connectionError = undefined")) {
    throw new Error("Successful reconnection does not clear a stale startup error")
  }
})

Deno.test("active inter-step activity keeps working timing", () => {
  if (!webview.includes("timingHtml(entries, working)")) {
    throw new Error("Activity timing can fall back to Worked during an active inter-step gap")
  }
})

Deno.test("idle sessions stop stale tool, delegation, and todo activity", () => {
  if (!webview.includes('activityVisualState(String(part.state?.status || "pending"), active)') ||
    !webview.includes('activityVisualState("running", parentActive)') ||
    !webview.includes("activityVisualState(todo.status, active)") ||
    !webview.includes("renderSummaries(session, Boolean(active))")) {
    throw new Error("Incomplete activity can remain visually active after its session becomes idle")
  }
})

Deno.test("command activity includes the command and current execution state", () => {
  if (!webview.includes("commandActivityLabel(state)") || !webview.includes("`${label}: ${command}`") ||
    !webview.includes("toolLabel(part, state)") || !webview.includes("toolLabel(action.tool, visualState)")) {
    throw new Error("Command activity does not transition from Running Command to its terminal label")
  }
})

Deno.test("edited filenames open files without toggling patch details", () => {
  if (!webview.includes("Open ${fileName(entry.file)} in VS Code") ||
    !webview.includes('file.classList.contains("edit-file")') || !webview.includes("event.preventDefault()") ||
    !css.includes(".edit-file { min-width: 0; max-width: 100%; overflow: hidden; flex: 0 1 auto") ||
    !css.includes(".edit-entry .edit-stats { margin-left: auto; }")) {
    throw new Error("Edited-file rows do not separate the file link from the patch disclosure target")
  }
})

Deno.test("expanded edited files do not repeat filename and stats", () => {
  if (!webview.includes('class="code-block diff-block edit-patch-block"') ||
    !webview.includes("editPatchBlock(entry.patch)") ||
    !css.includes(".edit-patch-block > .copy-block { position: absolute") ||
    webview.includes("diffBlock(entry.file, entry.patch, entry.additions, entry.deletions)")) {
    throw new Error("Expanded patch details still repeat the edited-file row header")
  }
})

Deno.test("activity wording follows actual state", () => {
  if (!webview.includes('stateful("Loading skill", "Loaded skill"') ||
    !webview.includes('stateful("Exploring item", "Explored item"') ||
    !webview.includes('stateful("Updating todos", "Updated todos"') ||
    !webview.includes('(kind === "edit" || kind === "patch") && completed(part)') ||
    !webview.includes('if (!live && typeof end !== "number") return ""') ||
    !webview.includes("const trailing = live && !message.parts.slice(index + 1).some")) {
    throw new Error("Activity labels can claim completion or continued work in the wrong state")
  }
})

Deno.test("shell and structured tool details use labeled sections", () => {
  if (!webview.includes('class="code-block shell-block shell-${kind}"') ||
    !webview.includes("stripTerminalSequences(content)") ||
    !webview.includes('codeBlock(stringify(item), fieldLabel(key), "tool-field-block")') ||
    !css.includes('.shell-command code::before') || !css.includes('.tool-field-block pre')) {
    throw new Error("Tool details still expose raw terminal escapes or two-column input fields")
  }
  if (webview.includes('class="tool-detail-fields"') || css.includes(".tool-detail-fields > div")) {
    throw new Error("Legacy two-column tool detail layout is still present")
  }
})
