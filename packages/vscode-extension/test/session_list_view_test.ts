import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert"
import type { ChatSnapshot } from "@opencode-workbench/shared"
import { sessionListMarkup } from "../src/webview/views/session-list.ts"

type SessionOption = ChatSnapshot["sessions"][number] & { tokens?: number; branch?: string; worktree?: string }

function session(id: string, title: string, updatedAt: number, extra: Partial<SessionOption> = {}): SessionOption {
  return { id, title, updatedAt, status: { type: "idle" }, unread: 0, ...extra }
}

Deno.test("session navigation owns status grouping, safe markup, details, and roving tab state", () => {
  const now = new Date(2026, 7, 9, 12).getTime()
  const day = 24 * 60 * 60 * 1_000
  const sessions = [
    session("older", "Archive", now - 8 * day),
    session("selected", "Build", now - 2 * 60_000, {
      status: { type: "busy" },
      directory: "/work/app/",
      changeCount: 2,
      todo: { completed: 1, total: 3 },
      queued: 2,
    }),
    session("error", "<Broken>", now, { status: { type: "error" } }),
    session("complete", "Finished", now, { unread: 1 }),
  ]

  const markup = sessionListMarkup(sessions, { empty: "None", selectedSessionID: "selected", now })
  const needsInput = markup.indexOf("Needs input")
  const working = markup.indexOf("Working")
  const completed = markup.indexOf("Completed")
  const older = markup.indexOf("Older")
  assert(needsInput >= 0 && needsInput < working && working < completed && completed < older)
  assertStringIncludes(markup, "&lt;Broken&gt;")
  assert(!markup.includes("<Broken>"))
  assertStringIncludes(markup, "state-error")
  assertStringIncludes(markup, "state-working")
  assertStringIncludes(markup, "state-completed")
  assertStringIncludes(markup, "app · 2 changed · 1/3 todos · 2 queued")
  assertStringIncludes(markup, "<time>2m</time>")
  assertStringIncludes(markup, 'data-session-id="selected" tabindex="0" aria-current="true"')
  assertEquals(markup.match(/tabindex="0"/g)?.length, 1)
})

Deno.test("session navigation search recognizes completion aliases and preserves result semantics", () => {
  const now = new Date(2026, 7, 9, 12).getTime()
  const markup = sessionListMarkup([
    session("active", "Active", now, { status: { type: "busy" } }),
    session("done", "Ready for review", now, { unread: 1 }),
  ], { query: "done", empty: "No matching sessions.", now })

  assertStringIncludes(markup, "<h2>Results</h2>")
  assertStringIncludes(markup, 'aria-label="Search results"')
  assertStringIncludes(markup, 'data-session-id="done"')
  assert(!markup.includes('data-session-id="active"'))
})

Deno.test("session navigation bounds rendering and keeps one reachable row when selection is outside the window", () => {
  const now = new Date(2026, 7, 9, 12).getTime()
  const markup = sessionListMarkup([
    session("e", "Echo", now),
    session("d", "Delta", now - 1),
    session("c", "Charlie", now - 2),
    session("b", "Bravo", now - 3),
    session("a", "Alpha", now - 4),
  ], { empty: "None", selectedSessionID: "a", renderLimit: 2, now })

  assert(markup.indexOf('data-session-id="e"') < markup.indexOf('data-session-id="d"'))
  assert(!markup.includes('data-session-id="a"'))
  assertStringIncludes(markup, 'data-session-id="e" tabindex="0"')
  assertStringIncludes(markup, "Show 3 more")
  assertEquals(markup.match(/data-session-id=/g)?.length, 2)
  assertEquals(markup.match(/tabindex="0"/g)?.length, 1)
})

Deno.test("session navigation puts pins first and renders discoverable metadata with row context", () => {
  const now = new Date(2026, 7, 9, 12).getTime()
  const markup = sessionListMarkup([
    session("working", "Working now", now, { status: { type: "busy" } }),
    session("pinned-attention", "Pinned question", now - 2_000, { pinned: true, questionCount: 1 }),
    session("pinned", "Pinned work", now - 1_000, {
      pinned: true,
      shared: true,
      directory: "/work/project",
      model: "anthropic/claude",
      agent: "build",
      tokens: 12_345,
      cost: 0.25,
      branch: "feature/pin",
      worktree: "wt-pin",
      summary: { additions: 2, deletions: 1, files: 3 },
    }),
  ], { empty: "None", now })

  assert(markup.indexOf("Pinned <span>2</span>") < markup.indexOf("Working <span>1</span>"))
  assert(markup.indexOf('data-session-id="pinned-attention"') < markup.indexOf('data-session-id="pinned"'))
  assertStringIncludes(markup, "Pinned work; Pinned; Shared; Idle; project · 3 changed")
  assertStringIncludes(markup, '<span class="session-badge" aria-hidden="true">Pinned</span>')
  assertStringIncludes(
    markup,
    "Model anthropic/claude · Agent build · 12,345 tokens · $0.2500 · Branch feature/pin · Worktree wt-pin",
  )
})

Deno.test("session navigation applies archive, shared, changed, and state filters", () => {
  const now = new Date(2026, 7, 9, 12).getTime()
  const values = [
    session("archived", "Archived", now, { archived: true, shared: true, changeCount: 1 }),
    session("shared", "Shared", now, { shared: true, changeCount: 1, questionCount: 1 }),
    session("plain", "Plain", now, { changeCount: 1, status: { type: "busy" } }),
    session("unchanged", "Unchanged", now, { shared: true }),
  ]

  const defaults = sessionListMarkup(values, { empty: "None", now })
  assert(!defaults.includes('data-session-id="archived"'))
  const filtered = sessionListMarkup(values, {
    empty: "None",
    now,
    filters: { includeArchived: true, sharedOnly: true, changedOnly: true, states: ["needs-input"] },
  })
  assertStringIncludes(filtered, 'data-session-id="shared"')
  assert(!filtered.includes('data-session-id="archived"'))
  assert(!filtered.includes('data-session-id="plain"'))
  assert(!filtered.includes('data-session-id="unchanged"'))
})
