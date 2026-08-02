import { initialWorkbenchState, sessionReducer } from "../src/session-state.ts"
import type { SessionInfo } from "../src/opencode.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const one: SessionInfo = {
  id: "one",
  title: "One",
  directory: "/work",
  time: { created: 1, updated: 1 },
}
const two: SessionInfo = {
  id: "two",
  title: "Two",
  directory: "/work",
  time: { created: 2, updated: 2 },
}

Deno.test("reconcile preserves per-session local state", () => {
  let state = sessionReducer(initialWorkbenchState, { type: "reconcile", sessions: [one, two] })
  state = sessionReducer(state, { type: "draft", sessionID: "one", draft: "unfinished" })
  state = sessionReducer(state, { type: "preference", sessionID: "one", agent: "build", model: "acme/model" })
  state = sessionReducer(state, { type: "reconcile", sessions: [{ ...one, title: "Renamed" }, two] })
  assert(state.sessions.one.draft === "unfinished", "draft was lost")
  assert(state.sessions.one.agent === "build", "agent was lost")
  assert(state.sessions.one.info.title === "Renamed", "server metadata was not refreshed")
})

Deno.test("reconcile treats status omissions as idle", () => {
  let state = sessionReducer(initialWorkbenchState, { type: "reconcile", sessions: [one] })
  state = sessionReducer(state, {
    type: "event",
    event: { type: "session.status", properties: { sessionID: "one", status: { type: "busy" } } },
  })
  state = sessionReducer(state, { type: "reconcile", sessions: [{ ...one, time: { ...one.time, updated: 2 } }], statuses: {} })
  assert(state.sessions.one?.status.type === "idle", "missing status was not treated as idle")
})

Deno.test("initial selection prefers a root session over newer subagents", () => {
  const child = { ...two, id: "child", parentID: "one", time: { created: 3, updated: 3 } }
  const state = sessionReducer(initialWorkbenchState, { type: "reconcile", sessions: [child, one] })
  assert(state.selectedID === "one", "newest subagent replaced the root session selection")
})

Deno.test("background completion marks unread without changing selection", () => {
  let state = sessionReducer(initialWorkbenchState, { type: "reconcile", sessions: [one, two] })
  state = sessionReducer(state, { type: "select", sessionID: "one" })
  state = sessionReducer(state, { type: "event", event: { type: "session.status", properties: { sessionID: "two", status: { type: "busy" } } } })
  state = sessionReducer(state, { type: "event", event: { type: "session.idle", properties: { sessionID: "two" } } })
  assert(state.selectedID === "one", "selection changed")
  assert(state.sessions.two.unread === 1, "background completion was not marked unread")
  state = sessionReducer(state, { type: "select", sessionID: "two" })
  assert(state.sessions.two.unread === 0, "selecting did not clear unread")
})

Deno.test("streamed parts update only their owning session", () => {
  let state = sessionReducer(initialWorkbenchState, { type: "reconcile", sessions: [one, two] })
  state = sessionReducer(state, {
    type: "transcript",
    sessionID: "one",
    messages: [{ info: { id: "m1", sessionID: "one", role: "assistant" }, parts: [] }],
  })
  state = sessionReducer(state, {
    type: "event",
    event: {
      type: "message.part.updated",
      properties: { part: { id: "p1", messageID: "m1", sessionID: "one", type: "text", text: "hello" } },
    },
  })
  assert(state.sessions.one.messages[0].parts[0].text === "hello", "part was not added")
  assert(state.sessions.two.messages.length === 0, "unrelated session changed")
})

Deno.test("prototype-like session IDs remain ordinary data", () => {
  const prototypeSession: SessionInfo = {
    ...one,
    id: "constructor",
    title: "Constructor",
  }
  let state = sessionReducer(initialWorkbenchState, { type: "reconcile", sessions: [prototypeSession] })
  state = sessionReducer(state, { type: "draft", sessionID: "constructor", draft: "safe" })
  assert(Object.getPrototypeOf(state.sessions) === null, "session record regained an object prototype")
  assert(state.sessions["constructor"]?.draft === "safe", "prototype-like session ID was not stored safely")
  const unchanged = sessionReducer(state, { type: "select", sessionID: "toString" })
  assert(unchanged === state, "inherited unknown session ID was accepted")
})

Deno.test("changes and questions remain separate session state", () => {
  let state = sessionReducer(initialWorkbenchState, { type: "reconcile", sessions: [one] })
  state = sessionReducer(state, {
    type: "changes",
    sessionID: "one",
    changes: [{ file: "src/main.ts", additions: 2, deletions: 1, status: "modified" }],
  })
  state = sessionReducer(state, {
    type: "questions",
    sessionID: "one",
    questions: [{ id: "question", sessionID: "one", protocol: "v2", questions: [{ header: "Choice", question: "Continue?", options: [] }] }],
  })
  assert(state.sessions.one.changes[0]?.file === "src/main.ts", "session changes were not stored")
  assert(state.sessions.one.questions[0]?.id === "question", "session questions were not stored")
})
