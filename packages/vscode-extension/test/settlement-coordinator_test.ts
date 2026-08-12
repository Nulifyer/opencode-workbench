import type { SessionViewState } from "@opencode-workbench/shared"
import { SettlementCoordinator } from "../src/application/settlement-coordinator.ts"

function session(overrides: Partial<SessionViewState> = {}): SessionViewState {
  return {
    info: { id: "one", title: "one", directory: "/project", time: { created: 1, updated: 1 } },
    messages: [],
    loaded: true,
    loadState: "ready",
    draft: "",
    unread: 0,
    status: { type: "idle" },
    queue: [],
    permissions: [],
    todos: [],
    changes: [],
    questions: [],
    autoApproval: false,
    ...overrides,
  }
}

Deno.test("settlement projection exposes every controller-owned blocker", () => {
  const coordinator = new SettlementCoordinator()
  const state = coordinator.project("one", {
    connected: true,
    session: session({
      status: { type: "busy" },
      queue: [{ id: "prompt", text: "next", delivery: "follow-up", createdAt: 1 }],
      permissions: [{ id: "permission", sessionID: "one", title: "Run command", protocol: "current" }],
      questions: [{ id: "question", sessionID: "one", questions: [], protocol: "v2" }],
    }),
    retryPending: true,
    committingOperationIDs: ["commit"],
  })
  for (
    const reason of [
      "ACTIVE_TURN",
      "UNRESOLVED_PERMISSION",
      "UNRESOLVED_QUESTION",
      "QUEUED_PROMPT",
      "RETRY_PENDING",
      "OPERATION_COMMITTING",
    ] as const
  ) {
    if (!state.settlement.reasons.includes(reason)) throw new Error(`Missing projected blocker ${reason}`)
  }
})

Deno.test("settlement wait resolves after the authoritative projection becomes quiescent", async () => {
  const coordinator = new SettlementCoordinator()
  coordinator.project("one", { connected: true, session: session({ status: { type: "busy" } }) })
  const settled = coordinator.waitForSettlement("one")
  coordinator.project("one", { connected: true, session: session() })
  if ((await settled).settlement.status !== "settled") throw new Error("Settlement waiter resolved without quiescence")
})

Deno.test("settlement wait supports cancellation and an explicit ignored blocker policy", async () => {
  const coordinator = new SettlementCoordinator()
  coordinator.project("one", {
    connected: true,
    session: session({
      permissions: [{ id: "permission", sessionID: "one", title: "Run command", protocol: "current" }],
    }),
  })
  if (!coordinator.isSettled("one", ["UNRESOLVED_PERMISSION"])) {
    throw new Error("Ignored settlement blocker was not applied")
  }
  const cancellation = new AbortController()
  const pending = coordinator.waitForSettlement("one", cancellation.signal)
  cancellation.abort(new Error("cancelled"))
  let rejected = false
  await pending.catch((error) => rejected = /cancelled/.test(error instanceof Error ? error.message : String(error)))
  if (!rejected) throw new Error("Settlement cancellation was ignored")
})
