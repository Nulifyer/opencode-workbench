const css = await Deno.readTextFile(new URL("../media/chat.css", import.meta.url))
const webview = await Deno.readTextFile(new URL("../src/webview/main.ts", import.meta.url))

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
