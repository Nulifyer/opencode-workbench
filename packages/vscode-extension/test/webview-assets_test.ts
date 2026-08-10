const css = await Deno.readTextFile(new URL("../media/chat.css", import.meta.url))
const webview = await Deno.readTextFile(new URL("../src/webview/main.ts", import.meta.url))
const focusController = await Deno.readTextFile(new URL("../src/webview/controllers/focus-controller.ts", import.meta.url))
const conversationView = await Deno.readTextFile(new URL("../src/webview/views/conversation.ts", import.meta.url))
const sessionList = await Deno.readTextFile(new URL("../src/webview/views/session-list.ts", import.meta.url))
const inspectorPresentation = await Deno.readTextFile(new URL("../src/webview/views/inspector/presentation.ts", import.meta.url))
const historyView = await Deno.readTextFile(new URL("../src/webview/views/history.ts", import.meta.url))
const turnNavigationView = await Deno.readTextFile(new URL("../src/webview/views/turn-navigation.ts", import.meta.url))
const chatView = await Deno.readTextFile(new URL("../src/views/chat-view.ts", import.meta.url))
const extensionHost = await Deno.readTextFile(new URL("../src/extension.ts", import.meta.url))
const manifest = JSON.parse(await Deno.readTextFile(new URL("../package.json", import.meta.url))) as {
  activationEvents?: string[]
  contributes?: {
    commands?: Array<{ command: string; enablement?: string }>
    keybindings?: Array<{ command: string; key?: string; mac?: string; when?: string }>
    walkthroughs?: Array<{
      id: string
      title: string
      description: string
      steps: Array<{ id: string; title: string; description: string; completionEvents?: string[] }>
    }>
  }
}

Deno.test("reduced motion replaces operational animation with legible static progress", () => {
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
  for (const marker of [
    ".header-active-indicator::before",
    ".session-loading-indicator::before",
    ".session-row-icon.state-working::before",
    ".todo-working .todo-state::before",
    ".active-throbber i",
    ".stopping-icon",
  ]) if (!reducedMotion.includes(marker)) throw new Error(`Reduced-motion static progress omits ${marker}`)
  if (!reducedMotion.includes('content: "●"') || !reducedMotion.includes("body.vscode-reduce-motion")) {
    throw new Error("System and VS Code reduced-motion modes do not expose equivalent static progress")
  }
})

Deno.test("webview exposes the screen-reader and keyboard interaction contract", () => {
  for (const marker of [
    'role="log" aria-label="OpenCode conversation"',
    'role="status" aria-live="polite"',
    'id="announcer" class="visually-hidden" aria-live="polite"',
    'role="dialog" aria-modal="true"',
    'role="tablist" aria-label="Inspector sections"',
    'role="tabpanel" aria-labelledby="inspector-tab-activity" tabindex="0"',
  ]) if (!chatView.includes(marker)) throw new Error(`Missing accessibility marker: ${marker}`)
  for (const behavior of [
    'tab.tabIndex = selected ? 0 : -1',
    'if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return',
    'announce("OpenCode response complete")',
    'focusController.trapTab',
  ]) if (!webview.includes(behavior)) throw new Error(`Missing keyboard or announcement behavior: ${behavior}`)
  if (!sessionList.includes('role="list"') || !sessionList.includes('role="listitem"')) throw new Error("Session hierarchy lacks semantic list roles")
  if (!webview.includes("Current checkout") || !webview.includes("Model worktree sessions")) throw new Error("Run groups lack the progressive stable-mode worktree hierarchy")
  if (!css.includes("@media (forced-colors: active)") || !css.includes(".message:focus-within .message-actions")) {
    throw new Error("High-contrast support or keyboard-visible message actions are missing")
  }
})

Deno.test("recovery dialog separates coupled recovery from native redo and restores focus", () => {
  for (const marker of [
    "Revert is one coupled OpenCode operation.",
    "files-only and transcript-only recovery are unavailable",
    "Fork does not revert.",
    "leaves the current files unchanged",
    "Fork OpenCode session here (files unchanged)",
    "const redoOnly = preview.canRedo && !preview.canRevert && !preview.canFork",
    "This is OpenCode's native redo.",
    "It does not create a new revert or fork.",
    "Native revert boundary",
    "Current OpenCode change summary",
    "let recoveryReturnFocus: HTMLElement | undefined",
    "recoveryReturnFocus = active instanceof HTMLElement",
    "if (!unavailable && returnFocus) returnFocus.focus()",
    'button.dataset.sessionAction === "redo" ? !snapshot.session?.revertMessageID',
  ]) if (!webview.includes(marker)) throw new Error(`Recovery dialog omits truthful action semantics: ${marker}`)
  if (!webview.includes('messageID: preview.messageID')) throw new Error("Recovery apply does not bind every action to the displayed preview boundary")
  for (const marker of [
    "new RecoveryPreviewGuard<vscode.Webview>()",
    "this.recoveryPreviews.remember(source, { input, preview })",
    "this.recoveryPreviews.consume(source",
    "this.recoveryPreviews.clear()",
    "delivered.messageID",
    'intent: "recover"',
    'intent: "redo"',
    'const intent = message.mode === "redo" ? "redo" : "recover"',
  ]) if (!chatView.includes(marker)) throw new Error(`Recovery host omits exact per-surface confirmation handling: ${marker}`)
})

Deno.test("model and session pickers expose roving keyboard focus", () => {
  if (!chatView.includes('id="model-options" class="picker-options model-options" role="listbox" aria-label="Models"') ||
    !webview.includes('role="option" data-model-value=') || !webview.includes('aria-selected="${model.value === value}" tabindex="${modelPickerActiveValue === value ? 0 : -1}"')) {
    throw new Error("Model selection does not expose listbox options with one roving tab stop")
  }
  if (!webview.includes("focusController.trapTab(event, modelPicker") || !webview.includes("modelPickerReturnFocus") ||
    !webview.includes('if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))')) {
    throw new Error("Model picker does not trap focus, restore its trigger, and support directional navigation")
  }
  if (!sessionList.includes('aria-current="true"') || !sessionList.includes('tabindex="${value.id === tabStop ? 0 : -1}"') ||
    !webview.includes('if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return')) {
    throw new Error("Session lists do not preserve current-session semantics and roving navigation")
  }
})

Deno.test("attention and inspector routing preserve focus and actionable context", () => {
  for (const surface of ['pending.surface === "goal"', 'pending.surface === "runs"', 'pending.surface === "health"']) {
    if (!webview.includes(surface)) throw new Error(`Attention routing omits ${surface}`)
  }
  if (!webview.includes('attentionToggle.setAttribute("aria-label", count ?') || !webview.includes("lastAttentionCount") ||
    !webview.includes("focusAttentionElement")) throw new Error("Attention count or focus feedback is missing")
  if (!webview.includes('attentionOverlay.querySelector<HTMLElement>(".attention-panel [data-close-attention]")') ||
    !focusController.includes("if (!root.contains(active)") || !focusController.includes(":not(.overlay-backdrop)")) {
    throw new Error("Empty attention dialogs do not move and contain keyboard focus within the dialog")
  }
  if (!chatView.includes('aria-controls="inspector-panel"') || !webview.includes('inspectorPanel.setAttribute("aria-labelledby"') ||
    !webview.includes("const scrollTop = previousTab === inspectorTab") || !webview.includes("focusedKey") ||
    !inspectorPresentation.includes("stop.explanation")) throw new Error("Inspector tabs, scroll/focus retention, or walkthrough explanations are missing")
  if (!inspectorPresentation.includes('class="run-pending-status" role="status"') || !inspectorPresentation.includes("Worktree unavailable; refresh this run group to recover.") || !webview.includes('class="rail-run-pending"')) {
    throw new Error("Pending runs still expose an unusable Open action")
  }
})

Deno.test("new editor commands carry one bounded bootstrap control into the first HTML", () => {
  for (const marker of [
    'this.openInEditor(undefined, "composer-focus")',
    'this.openInEditor(undefined, "sessions-show")',
    'this.openInEditor(undefined, "attention-show")',
    "this.pendingEditorControl = initialControl",
    "this.configure(panel.webview, \"editor\", surfaceID, this.pendingEditorTab, this.pendingEditorControl)",
    'data-initial-control="${initialControl}"',
  ]) if (!chatView.includes(marker)) throw new Error(`First-open host control is not persisted: ${marker}`)
  for (const marker of [
    'new Set(["composer-focus", "sessions-toggle", "sessions-show", "attention-show"])',
    "document.body.dataset.initialControl",
    "if (initialWorkbenchControl) requestAnimationFrame",
    'initialWorkbenchControl === "sessions-show"',
    'document.body.removeAttribute("data-initial-control")',
  ]) if (!webview.includes(marker)) throw new Error(`First-open bootstrap control is not bounded or applied: ${marker}`)
})

Deno.test("structured browser context stays bound to the selected OpenCode session", () => {
  const hostCase = chatView.slice(chatView.indexOf('case "browserContextAction":'), chatView.indexOf('case "runAction":'))
  if (!hostCase.includes("this.requireSelected(message.sessionID)") || !hostCase.includes("captureBrowserContext?.(message)")) {
    throw new Error("Browser context capture is not revalidated against the selected session")
  }
  if (!webview.includes('post({ type: "browserContextAction", sessionID: snapshot.session.id, action: "capture" })') ||
    !webview.includes('post({ type: "browserContextAction", sessionID: snapshot.session.id, action: "capture", task, sources')) {
    throw new Error("Browser context controls omit their originating OpenCode session")
  }
})

Deno.test("objective comparison controls are exact, sortable, and narrow-card compatible", () => {
  for (const marker of [
    'aria-sort="${ariaSort}"',
    "data-comparison-sort-select",
    'data-run-action="export-comparison"',
    'data-comparison-revision="${comparison.revision}"',
    "No winner or score is inferred.",
  ]) if (!inspectorPresentation.includes(marker)) throw new Error(`Comparison presentation omits ${marker}`)
  for (const marker of [
    "const comparisonSortKeys = new Set<RunComparisonSortKey>",
    "setComparisonSort(artifactID, key, direction)",
    'action: "export-comparison", comparisonArtifactID: run.dataset.comparisonArtifactId, comparisonRevision: revision',
    "comparisonSorts = Object.fromEntries",
  ]) if (!webview.includes(marker)) throw new Error(`Comparison interaction omits ${marker}`)
  if (!css.includes(".run-comparison thead { display: none; }") || !css.includes(".run-comparison td::before")) {
    throw new Error("Comparison matrix does not preserve labeled narrow cards")
  }
  const runCase = chatView.slice(chatView.indexOf('case "runAction":'), chatView.indexOf('case "walkthroughAction":'))
  for (const marker of [
    "exactRunComparisonMarkdown(group, this.workbench.artifacts.list()",
    "artifactID: message.comparisonArtifactID",
    "revision: message.comparisonRevision",
    'executeCommand("opencodeWorkbench.reviewChanges", run.session.directory, group.baseRef, run.session.sessionID)',
    'run.session.sessionID === "pending" || run.discarded',
    'run.retained) throw new Error("This run is already retained")',
  ]) if (!runCase.includes(marker)) throw new Error(`Run host does not bind an exact eligible source: ${marker}`)
})

Deno.test("saved plan handoff remains repeatable only for the approved exact revision", () => {
  if (!extensionHost.includes('["approved", "handed-off"].includes(planArtifactRecord.payload.phase)')) {
    throw new Error("A handed-off plan cannot be handed off again")
  }
  if (!extensionHost.includes("planArtifactRecord.payload.uri !== reference.uri || planArtifactRecord.payload.revision !== reference.revision")) {
    throw new Error("Plan handoff no longer checks the saved approved revision hash")
  }
})

Deno.test("direct run commands reject stale identities instead of retargeting a picker", () => {
  for (const marker of [
    'if (directRequested && !direct) throw new Error("The requested run is no longer available to open")',
    'if (directRequested && !direct) throw new Error("The requested run is no longer available for diff")',
    'if (directRequested && !direct) throw new Error("The requested run is no longer safely discardable")',
  ]) if (!extensionHost.includes(marker)) throw new Error(`Exact run command can fall through to a global picker: ${marker}`)
})

Deno.test("native Archive discloses that this pinned OpenCode version cannot unarchive", () => {
  if (!chatView.includes("This pinned OpenCode version has no proven unarchive API, so the Workbench cannot currently undo this action.")) {
    throw new Error("Archive confirmation implies a recovery path that OpenCode does not provide")
  }
})

Deno.test("failed run and worktree launches become stable attention items", () => {
  for (const marker of [
    'run.phase !== "failed" || run.discarded',
    'group.isolation === "worktree" && !run.worktreeID',
    'id: `run-failure:${createHash("sha256")',
    'kind: worktreeFailure ? "worktree-failure" : "run-failure"',
    'target: { surface: "runs", itemID: run.id }',
    '.slice(0, 500)',
  ]) if (!chatView.includes(marker)) throw new Error(`Run attention derivation is missing: ${marker}`)
})

Deno.test("turn markers provide a usable pointer target", () => {
  if (!/\.turn-navigation button\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/.test(css) ||
    !css.includes(".turn-navigation button::before")) throw new Error("Session markers still use an 8px hit target")
  if (!turnNavigationView.includes("Forked or delegated session boundary") || !turnNavigationView.includes("Goal checkpoint recorded") ||
    !turnNavigationView.includes('part.tool === "update_goal_checkpoint"')) throw new Error("Fork or goal-checkpoint navigation markers are missing")
})

Deno.test("older transcript paging is explicit and preserves the visual prepend anchor", () => {
  if (!chatView.includes('id="history-boundary"') || !chatView.includes('id="history-load-older"') ||
    !chatView.includes('role="status" aria-live="polite"')) throw new Error("Bounded-history status and action are missing")
  for (const marker of [
    'post({ type: "loadOlderHistory"',
    "pendingHistoryAnchor = conversationView.capturePrependAnchor()",
    "renderTranscript(merged, active, anchor)",
  ]) if (!webview.includes(marker)) throw new Error(`Older-history scroll anchoring is missing: ${marker}`)
  if (!conversationView.includes("this.scroll.restorePrependAnchor(prependAnchor)")) throw new Error("Conversation view does not restore the visual prepend anchor")
  if (!chatView.includes('case "loadOlderHistory":') || !chatView.includes('type: "historyPage"')) {
    throw new Error("Older-history request is not routed through the validated host path")
  }
  if (!historyView.includes("messages currently loaded from OpenCode") || !historyView.includes("older server history may exist") ||
    historyView.includes("all messages from OpenCode")) throw new Error("History status overstates the bounded transcript")
})

Deno.test("plan-first entry point uses the validated host command route", () => {
  if (!chatView.includes('id="plan-task"') || !webview.includes('post({ type: "planTask" })') ||
    !chatView.includes('case "planTask":') || !chatView.includes('executeCommand("opencodeWorkbench.planTask")')) {
    throw new Error("The empty state does not expose the validated Plan Task workflow")
  }
})

Deno.test("workspace commands and shortcut have contextual enablement", () => {
  const commands = new Map((manifest.contributes?.commands ?? []).map((entry) => [entry.command, entry.enablement]))
  for (const command of ["opencodeWorkbench.newSession", "opencodeWorkbench.planTask", "opencodeWorkbench.compareModels"]) {
    if (commands.get(command) !== "workspaceFolderCount > 0") throw new Error(`${command} is not scoped to a workspace`)
  }
  if (commands.get("opencodeWorkbench.handoffPlan") !== "workspaceFolderCount > 0 && editorLangId == markdown") {
    throw new Error("Plan handoff is enabled without a Markdown plan")
  }
  if (commands.get("opencodeWorkbench.abortSession") !== "workspaceFolderCount > 0 && opencodeWorkbench.sessionBusy") {
    throw new Error("Abort Session is enabled without active work")
  }
  const shortcut = manifest.contributes?.keybindings?.find((entry) => entry.command === "opencodeWorkbench.newSession")
  if (!shortcut?.when?.includes("focusedView == opencodeWorkbench.chat") || !shortcut.when.includes("activeWebviewPanelId == opencodeWorkbench.chatEditor")) {
    throw new Error("New Session shortcut is not scoped to Workbench chat surfaces")
  }
})

Deno.test("onboarding walkthrough is bounded and invokes registered OpenCode commands", () => {
  const walkthrough = manifest.contributes?.walkthroughs?.find((entry) => entry.id === "opencodeWorkbench.gettingStarted")
  if (!walkthrough || walkthrough.steps.length !== 5) throw new Error("Getting Started must contain exactly five focused steps")
  if (!walkthrough.description.includes("OpenCode installation")) throw new Error("Onboarding does not identify OpenCode as the execution backend")
  const commandContributions = new Set((manifest.contributes?.commands ?? []).map((entry) => entry.command))
  const registeredCommands = new Set([...extensionHost.matchAll(/registerCommand\("([^"]+)"/g)].map((match) => match[1]))
  const ids = new Set<string>()
  for (const step of walkthrough.steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate walkthrough step: ${step.id}`)
    ids.add(step.id)
    const command = /\(command:([^)]+)\)/.exec(step.description)?.[1]
    if (!command || !commandContributions.has(command)) throw new Error(`${step.id} does not target a contributed command`)
    if (!registeredCommands.has(command)) throw new Error(`${step.id} targets an unhandled host command: ${command}`)
    if (!step.completionEvents?.includes(`onCommand:${command}`)) throw new Error(`${step.id} does not complete from its command`)
  }
})

Deno.test("Workbench command surface has host handlers and safely scoped keybindings", () => {
  const expected = [
    "opencodeWorkbench.openChatInEditor",
    "opencodeWorkbench.focusComposer",
    "opencodeWorkbench.toggleTaskWorkbench",
    "opencodeWorkbench.toggleSessions",
    "opencodeWorkbench.toggleJobs",
    "opencodeWorkbench.showAttention",
    "opencodeWorkbench.nextAttention",
    "opencodeWorkbench.abortSession",
    "opencodeWorkbench.openHelp",
  ]
  const commands = new Set((manifest.contributes?.commands ?? []).map((entry) => entry.command))
  const registeredCommands = new Set([...extensionHost.matchAll(/registerCommand\("([^"]+)"/g)].map((match) => match[1]))
  for (const command of expected) {
    if (!commands.has(command)) throw new Error(`Missing Workbench command contribution: ${command}`)
    if (!manifest.activationEvents?.includes(`onCommand:${command}`)) throw new Error(`Missing activation event: ${command}`)
    if (!registeredCommands.has(command)) throw new Error(`Workbench command still needs a host handler: ${command}`)
  }
  for (const route of ["chatProvider.toggleSessions()", "chatProvider.toggleJobs()", "chatProvider.showAttention()", "chatProvider.openNextAttention()"]) {
    if (!extensionHost.includes(route)) throw new Error(`Workbench command is still misrouted: ${route}`)
  }

  const keybindings = new Map((manifest.contributes?.keybindings ?? []).map((entry) => [entry.command, entry]))
  const focus = keybindings.get("opencodeWorkbench.focusComposer")
  if (focus?.key !== "ctrl+l" || focus.mac !== "cmd+l" || !focus.when?.includes("focusedView == opencodeWorkbench.chat") ||
    !focus.when.includes("activeWebviewPanelId == opencodeWorkbench.chatEditor")) throw new Error("Focus Composer can escape the Workbench focus scope")
  const editor = keybindings.get("opencodeWorkbench.openChatInEditor")
  if (editor?.key !== "ctrl+shift+o" || editor.mac !== "cmd+shift+o" || editor.when !== "workspaceFolderCount > 0 && focusedView == opencodeWorkbench.chat") {
    throw new Error("Open-in-editor shortcut can override the editor's Go to Symbol shortcut")
  }
  const stop = keybindings.get("opencodeWorkbench.abortSession")
  if (stop?.key !== "escape" || !stop.when?.includes("opencodeWorkbench.sessionBusy") ||
    !stop.when.includes("focusedView == opencodeWorkbench.chat") || !stop.when.includes("activeWebviewPanelId == opencodeWorkbench.chatEditor")) {
    throw new Error("Escape can stop work outside an active Workbench session")
  }
})

Deno.test("empty-workspace onboarding keeps navigation, Help, and the native chat participant registered", () => {
  const start = extensionHost.indexOf("if (!workspacePath)")
  const end = extensionHost.indexOf("const canonicalWorkspace", start)
  const branch = extensionHost.slice(start, end)
  if (start < 0 || end < 0 || !branch.includes('createChatParticipant("opencodeWorkbench.opencode"')) {
    throw new Error("Empty-workspace activation does not register the contributed chat participant")
  }
  for (const command of [
    "opencodeWorkbench.openChat",
    "opencodeWorkbench.openChatInEditor",
    "opencodeWorkbench.focusComposer",
    "opencodeWorkbench.toggleTaskWorkbench",
    "opencodeWorkbench.toggleSessions",
    "opencodeWorkbench.toggleJobs",
    "opencodeWorkbench.showAttention",
    "opencodeWorkbench.nextAttention",
    "opencodeWorkbench.openHelp",
  ]) {
    if (!branch.includes(`registerCommand("${command}"`)) throw new Error(`Empty-workspace activation omits ${command}`)
  }
  if (!branch.includes("No model request was run in VS Code Chat")) throw new Error("Empty-workspace chat participant does not disclose that no model ran")
})

Deno.test("responsive and forced-color hardening covers the Task Workbench controls", () => {
  const forcedColors = css.slice(css.lastIndexOf("@media (forced-colors: active)"))
  for (const marker of [".pane-splitter", ".attention-toggle > small", ".goal-form-errors", ".message-actions"]) {
    if (!forcedColors.includes(marker)) throw new Error(`Forced-colors hardening omits ${marker}`)
  }
  const compact = css.slice(css.lastIndexOf("@media (max-width: 520px)"))
  for (const marker of [".header-actions", ".goal-limit-controls", ".history-panel", ".recovery-panel"]) {
    if (!compact.includes(marker)) throw new Error(`Compact responsive layout omits ${marker}`)
  }
  for (const marker of ["function narrowWorkbench()", "conversationColumn.inert = true", "focusController.trapTab(event, rightRail)", 'message.type === "workbenchControl"', "window.innerWidth > 900"]) {
    if (!webview.includes(marker)) throw new Error(`One-pane Workbench behavior omits ${marker}`)
  }
  if (!css.includes('@media (max-width: 900px)') || !css.includes('body[data-mode="editor"].rail-open .right-rail')) {
    throw new Error("Sessions drawer is not collapsed below the editor breakpoint")
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

Deno.test("bounded snapshot projection is visible and names preserved durable state", () => {
  if (!webview.includes('showNotice("projection", "Some Workbench history is hidden"') ||
    !webview.includes("projection.omitted") || !webview.includes("dismissedProjectionSignature")) {
    throw new Error("Transport projection omissions are not exposed as a dismissible webview warning")
  }
  const rule = /\.notice\.projection\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
  if (!rule.includes("warningBorder") || !rule.includes("color-mix")) {
    throw new Error("Transport projection warning does not use the theme-safe warning surface")
  }
  if (!inspectorPresentation.includes("stored records were not deleted") || !inspectorPresentation.includes("contextReceipts") ||
    !inspectorPresentation.includes("runGroups") || !inspectorPresentation.includes("walkthroughStops")) {
    throw new Error("Inspector does not disclose bounded durable receipt, run, or walkthrough history")
  }
})

Deno.test("context receipt source actions stay bound to exact projected identities", () => {
  for (const marker of [
    '[data-context-receipt-id][data-context-receipt-item-id]',
    'type: "contextReceiptAction"',
    "sessionID: snapshot.session.id",
    "receiptID: receiptSource.dataset.contextReceiptId",
    "itemID: receiptSource.dataset.contextReceiptItemId",
    'action: "open-source"',
  ]) if (!webview.includes(marker)) throw new Error(`Context receipt source action is missing: ${marker}`)
  if (!inspectorPresentation.includes('data-context-receipt-id="${escapeHtml(receipt.id)}"') ||
    !inspectorPresentation.includes('data-context-receipt-item-id="${escapeHtml(item.id)}"') ||
    !inspectorPresentation.includes("Source unavailable after reload")) {
    throw new Error("Context receipts do not distinguish exact navigable source metadata from unavailable sources")
  }
})

Deno.test("Review and Jobs filters are ephemeral DOM-only controls", () => {
  for (const marker of [
    "const localInspectorFilters",
    "function applyReviewFilters",
    "function applyJobFilters",
    'querySelectorAll<HTMLElement>("[data-review-finding]")',
    'querySelectorAll<HTMLElement>("[data-job-row]")',
    "finding.hidden = !matches",
    "row.hidden = !matches",
  ]) if (!webview.includes(marker)) throw new Error(`Local inspector filtering is missing: ${marker}`)
  for (const marker of [
    'data-review-filter="severity"',
    'data-review-filter="category"',
    'data-review-filter="disposition"',
    'data-job-filter="text"',
    'data-job-filter="kind"',
    'data-job-filter="session"',
    'data-job-filter="run"',
  ]) if (!inspectorPresentation.includes(marker)) throw new Error(`Inspector filter control is missing: ${marker}`)
  if (webview.includes("vscode.setState({ ...localInspectorFilters") || webview.includes('type: "reviewFilter"') || webview.includes('type: "jobFilter"')) {
    throw new Error("Inspector filters leak ephemeral presentation state into persistence or host protocol messages")
  }
})

Deno.test("review generation preserves the exact originating OpenCode owner", () => {
  const reviewCommand = extensionHost.indexOf('registerCommand("opencodeWorkbench.reviewChanges"')
  const captureOwner = extensionHost.indexOf("const originatingSession = controller.chatSnapshot().session", reviewCommand)
  const openSurface = extensionHost.indexOf('chatProvider.openInEditor("review")', reviewCommand)
  const captureDiff = extensionHost.indexOf("const capture = await diffs.capture", reviewCommand)
  if (reviewCommand < 0 || captureOwner < reviewCommand || openSurface < captureOwner || captureDiff < openSurface) {
    throw new Error("Review generation does not capture its OpenCode owner before opening UI and capturing the diff")
  }
  if (!extensionHost.includes('executeCommand("opencodeWorkbench.reviewChanges", artifact.payload.repository, artifact.payload.baseRef, artifact.sessionID)')) {
    throw new Error("Review regeneration does not preserve the exact artifact owner session")
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
  if (!webview.includes("renderTiming: timingHtml") || !conversationView.includes("this.options.renderTiming(projected.entries, projected.working)")) {
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
