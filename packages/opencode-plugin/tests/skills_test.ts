import { evidenceFromEvent } from "../src/events.ts"
import { emptyState, type Evidence, type Scope } from "../src/model.ts"
import { appendEvidence, decideCandidate, proposeCandidate } from "../src/skills.ts"
import { assert, equal } from "./assert.ts"

const project: Scope = { kind: "project", project: "/project" }
const provenance = { sessionID: "session", messageID: "message", source: "explicit_tool" as const }

Deno.test("event evidence is bounded and excludes tool error content", () => {
  const state = emptyState()
  for (let index = 0; index < 201; index++) {
    appendEvidence(state, {
      id: String(index),
      scope: project,
      kind: "session_status",
      subject: "busy",
      sessionID: String(index),
      createdAt: index,
    })
  }
  equal(state.evidence.length, 200)
  equal(state.evidence[0].id, "1")

  const evidence = evidenceFromEvent(
    {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "read",
          sessionID: "s",
          messageID: "m",
          callID: "c",
          state: { status: "error", error: "repository and tool output must not be persisted" },
        },
      },
    },
    project,
    300,
    "failure",
  )
  assert(evidence)
  equal(evidence.subject, "read")
  equal(Object.keys(evidence).includes("error"), false)
})

Deno.test("skill approval only stages candidate metadata", () => {
  const state = emptyState()
  const evidence: Evidence = {
    id: "evidence",
    scope: project,
    kind: "skill_load",
    subject: "test-strategy",
    sessionID: "session",
    createdAt: 1,
  }
  appendEvidence(state, evidence)
  proposeCandidate(
    state,
    {
      scope: project,
      name: "focused-testing",
      rationale: "Capture repeated focused test usage.",
      evidenceIDs: [evidence.id],
      provenance,
    },
    2,
    "candidate",
  )
  const staged = decideCandidate(state, "candidate", "approve", 3, "/project")
  equal(staged.status, "staged")
  equal(staged.evidenceIDs, ["evidence"])
})
