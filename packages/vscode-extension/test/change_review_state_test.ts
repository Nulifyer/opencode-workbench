import { assertEquals } from "jsr:@std/assert"
import type { FileChange } from "@opencode-workbench/shared"
import { ChangeReviewState, type ReviewedChangeRecord } from "../src/application/change-review-state.ts"

const change = (patch: string, file = "src/main.ts"): FileChange => ({
  file,
  patch,
  additions: 1,
  deletions: 1,
  status: "modified",
})

Deno.test("review acknowledgement is scoped to the exact session patch", () => {
  let stored: ReviewedChangeRecord[] = []
  const state = new ChangeReviewState([], (records) => stored = records)
  state.markReviewed("session-one", [change("@@\n-old\n+new")])

  assertEquals(state.decorate("session-one", [change("@@\n-old\n+new")])[0]?.reviewed, true)
  assertEquals(state.decorate("session-two", [change("@@\n-old\n+new")])[0]?.reviewed, undefined)
  assertEquals(state.decorate("session-one", [change("@@\n-old\n+newer")])[0]?.reviewed, undefined)
  assertEquals(new ChangeReviewState(stored).decorate("session-one", [change("@@\n-old\n+new")])[0]?.reviewed, true)
  assertEquals(state.invalidate("session-one", "src/main.ts"), true)
  assertEquals(state.decorate("session-one", [change("@@\n-old\n+new")])[0]?.reviewed, undefined)
})

Deno.test("refreshing a review acknowledgement protects it from oldest-first pruning", () => {
  const records = Array.from({ length: 1_000 }, (_, index): ReviewedChangeRecord => ({
    sessionID: "session",
    file: `src/${index}.ts`,
    signature: "a".repeat(64),
    reviewedAt: index,
  }))
  const state = new ChangeReviewState(records)
  state.markReviewed("session", [change("@@\n-old\n+new", "src/0.ts")])
  state.markReviewed("session", [change("@@\n-old\n+new", "src/new.ts")])

  assertEquals(state.decorate("session", [change("@@\n-old\n+new", "src/0.ts")])[0]?.reviewed, true)
  assertEquals(state.decorate("session", [change("@@\n-old\n+new", "src/1.ts")])[0]?.reviewed, undefined)
})
