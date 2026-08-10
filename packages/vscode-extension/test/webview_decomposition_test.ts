import { assertEquals } from "jsr:@std/assert"
import { WorkbenchWebviewStore } from "../src/webview/state/store.ts"
import { InspectorShellController } from "../src/webview/views/inspector/shell.ts"
import { composerSubmitIntent } from "../src/webview/views/composer.ts"
import { deliveryLabel, queueProjection } from "../src/webview/views/queue.ts"
import { sessionListMarkup } from "../src/webview/views/session-list.ts"
import { historyPresentation, mergeHistoryPage } from "../src/webview/views/history.ts"
import { MAX_TURN_NAVIGATION_MARKERS, turnNavigationMarkers } from "../src/webview/views/turn-navigation.ts"
import { parseWithProtocolV1Adapter } from "../src/webview/transport/protocol-v1-adapter.ts"
import { FocusController } from "../src/webview/controllers/focus-controller.ts"

Deno.test("webview store and legacy adapter preserve one validated snapshot path", () => {
  const store = new WorkbenchWebviewStore()
  const next = { ...store.snapshot, connected: true as const, connectionState: "connected" as const }
  assertEquals(store.replace(next).connected, true)
  assertEquals(store.snapshotRevision, 1)
  const parse = (value: unknown): { type: "snapshot"; snapshot: unknown } | undefined => typeof value === "object" && value !== null && "type" in value && value.type === "snapshot" && "snapshot" in value ? value as { type: "snapshot"; snapshot: unknown } : undefined
  assertEquals(parseWithProtocolV1Adapter({ type: "state", state: next }, parse), { type: "snapshot", snapshot: next })
})

Deno.test("webview domain helpers own queue, composer, session ordering, and inspector state", () => {
  const session = { id: "s", directory: "/work", title: "S", draft: "", status: { type: "busy" as const }, loaded: true, loadState: "ready" as const, messages: [], messageRevisions: {}, queue: [{ id: "one", text: "A", createdAt: 1, delivery: "steer" as const }], permissions: [], questions: [], todos: [], changes: [], inFlightPromptID: "one" }
  assertEquals(queueProjection(session).running?.id, "one")
  assertEquals(deliveryLabel("replace"), "Replace queued instruction")
  assertEquals(composerSubmitIntent({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: true, isComposing: false }, "send", true), "steer")
  const sessionMarkup = sessionListMarkup([{ id: "b", title: "B", status: { type: "busy" }, unread: 0 }, { id: "a", title: "A", status: { type: "busy" }, unread: 0 }], { empty: "None", now: 1 })
  assertEquals(sessionMarkup.indexOf("data-session-id=\"a\"") < sessionMarkup.indexOf("data-session-id=\"b\""), true)
  const inspector = new InspectorShellController({ inspectorOpen: true, inspectorTab: "runs" }); inspector.close(); inspector.select("goal")
  assertEquals(inspector.persisted(), { inspectorOpen: false, inspectorTab: "goal" })
  const defaultInspector = new InspectorShellController()
  assertEquals(defaultInspector.persisted(), { inspectorOpen: false, inspectorTab: "activity" })
  const restoredInspector = new InspectorShellController(defaultInspector.persisted())
  assertEquals(restoredInspector.persisted(), { inspectorOpen: false, inspectorTab: "activity" })
})

Deno.test("older history merges ahead of the visible transcript without duplicating its anchor", () => {
  const message = (id: string, role: "user" | "assistant") => ({ info: { id, sessionID: "s", role }, parts: [] })
  const session = {
    id: "s", title: "S", draft: "", status: { type: "idle" as const }, loaded: true, loadState: "ready" as const,
    messages: [message("current", "user")], messageRevisions: { current: 2 },
    history: { totalMessages: 3, visibleMessages: 1, hasOlder: true, limitedBy: "messages" as const },
  }
  const merged = mergeHistoryPage(session, {
    sessionID: "s",
    messages: [message("oldest", "user"), message("current", "user")],
    messageRevisions: { oldest: 1, current: 1 },
    hasOlder: false,
    totalMessages: 3,
  })
  assertEquals(merged.messages.map((entry) => entry.info.id), ["oldest", "current"])
  assertEquals(merged.messageRevisions, { oldest: 1, current: 2 })
  assertEquals(merged.history?.visibleMessages, 2)
  assertEquals(historyPresentation(merged.history).visible, false)
  const bounded = historyPresentation({ totalMessages: 10_000, visibleMessages: 10_000, hasOlder: false, sourceMayBeTruncated: true })
  assertEquals(bounded.visible, true)
  assertEquals(bounded.text.includes("older server history may exist"), true)
  assertEquals(bounded.actionLabel, undefined)
})

Deno.test("turn navigation derives truthful fork and completed goal-checkpoint markers", () => {
  const session = {
    id: "fork", parentID: "parent", title: "Fork", draft: "", status: { type: "idle" as const }, loaded: true, loadState: "ready" as const,
    messages: [
      { info: { id: "prompt", sessionID: "fork", role: "user" as const }, parts: [{ id: "prompt-text", sessionID: "fork", messageID: "prompt", type: "text", text: "Continue" }] },
      { info: { id: "answer", sessionID: "fork", role: "assistant" as const }, parts: [{ id: "checkpoint", sessionID: "fork", messageID: "answer", type: "tool", tool: "update_goal_checkpoint", state: { status: "completed" } }] },
    ],
    messageRevisions: { prompt: 1, answer: 1 },
  }
  const markers = turnNavigationMarkers(session)
  assertEquals(markers.map((marker) => marker.id), ["fork:fork", "message:prompt", "checkpoint:checkpoint"])
  assertEquals(markers[0]?.target, "message:prompt")
  assertEquals(markers[1]?.current, true)
  assertEquals(markers[2]?.label, "Goal checkpoint recorded")
})

Deno.test("turn navigation bounds long histories while retaining the current turn", () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({
    info: { id: `prompt-${index}`, sessionID: "long", role: "user" as const },
    parts: [{ id: `text-${index}`, sessionID: "long", messageID: `prompt-${index}`, type: "text", text: `Prompt ${index}` }],
  }))
  const session = { id: "long", title: "Long", draft: "", status: { type: "idle" as const }, loaded: true, loadState: "ready" as const, messages, messageRevisions: {} }
  const markers = turnNavigationMarkers(session)
  assertEquals(markers.length, MAX_TURN_NAVIGATION_MARKERS)
  assertEquals(markers.at(-1)?.id, "message:prompt-199")
  assertEquals(markers.at(-1)?.current, true)
})

Deno.test("modal focus trapping recovers when focus starts outside the overlay", () => {
  const focused: string[] = []
  const first = { focus: () => focused.push("first") }
  const last = { focus: () => focused.push("last") }
  const outside = {}
  const root = {
    hidden: false,
    querySelectorAll: () => [first, last],
    contains: (value: unknown) => value === first || value === last,
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: outside } })
    let prevented = false
    const trapped = new FocusController().trapTab({ key: "Tab", shiftKey: false, preventDefault: () => { prevented = true } } as KeyboardEvent, root as unknown as HTMLElement)
    assertEquals({ trapped, prevented, focused }, { trapped: true, prevented: true, focused: ["first"] })
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor)
    else delete (globalThis as { document?: unknown }).document
  }
})
