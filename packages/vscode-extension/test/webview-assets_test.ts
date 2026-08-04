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
