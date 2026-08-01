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
  assert(parseWebviewMessage({ type: "send", text: "" }) === undefined, "empty send accepted")
  assert(parseWebviewMessage({ type: "unknown", command: "workbench.action.closeWindow" }) === undefined, "unknown message accepted")
})

Deno.test("validates host snapshots", () => {
  const valid = {
    type: "snapshot",
    snapshot: {
      connected: true,
      sessions: [{ id: "s", title: "Session", status: { type: "idle" }, unread: 0 }],
      agents: [],
      models: [],
      session: { id: "s", title: "Session", draft: "", status: { type: "idle" }, messages: [], messageRevisions: {} },
    },
  }
  assert(parseHostMessage(valid)?.type === "snapshot", "valid snapshot rejected")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, connected: "yes" } }) === undefined, "invalid snapshot accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, agents: [{ name: 42 }] } }) === undefined, "invalid catalog accepted")
  assert(parseHostMessage({ ...valid, snapshot: { ...valid.snapshot, sessions: [{ id: "s", title: "Session", status: { type: "idle" }, unread: -1 }] } }) === undefined, "invalid session option accepted")
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
