import { decidePreference, effectivePreferences, forgetPreference, proposePreference, renderPreferenceData } from "../src/memory.ts"
import { emptyState, type PreferenceCategory, type Scope } from "../src/model.ts"
import { assert, equal, rejects } from "./assert.ts"

const provenance = { sessionID: "session", messageID: "message", source: "explicit_tool" as const }
const global: Scope = { kind: "global" }
const project: Scope = { kind: "project", project: "/project" }

function propose(scope: Scope, category: PreferenceCategory, key: string, value: string, at: number, id: string, approve = true) {
  return { scope, category, key, value, provenance, approve, at, id }
}

Deno.test("project preference deterministically overrides global preference", () => {
  const state = emptyState()
  const first = propose(global, "coding_style", "indent", "Use two spaces", 1, "global")
  const second = propose(project, "coding_style", "indent", "Use tabs", 2, "project")
  proposePreference(state, first, first.at, first.id)
  proposePreference(state, second, second.at, second.id)
  equal(effectivePreferences(state, "/project").map((item) => item.id), ["project"])
  equal(effectivePreferences(state, "/other").map((item) => item.id), ["global"])
})

Deno.test("approval supersedes same-scope conflict and forget is immediate", () => {
  const state = emptyState()
  const old = propose(global, "communication", "verbosity", "Be concise", 1, "old")
  proposePreference(state, old, old.at, old.id)
  const pending = propose(global, "communication", "verbosity", "Be detailed", 2, "new", false)
  proposePreference(state, pending, pending.at, pending.id)
  decidePreference(state, "new", "approve", 3, "/project")
  equal(state.preferences.map((item) => [item.id, item.status]), [["old", "superseded"], ["new", "approved"]])
  assert(renderPreferenceData(state, "/project")?.includes("Be detailed"))
  forgetPreference(state, "new", 4, "/project")
  equal(renderPreferenceData(state, "/project"), undefined)
  equal(state.preferences[1]?.value, "[forgotten]")
})

Deno.test("another project cannot mutate project-scoped memory", async () => {
  const state = emptyState()
  const pending = propose(project, "workflow", "tests", "Run focused tests", 1, "private", false)
  proposePreference(state, pending, pending.at, pending.id)
  await rejects(() => decidePreference(state, "private", "approve", 2, "/other"), /Unknown preference/)
  await rejects(() => forgetPreference(state, "private", 2, "/other"), /Unknown preference/)
})
