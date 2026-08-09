import {
  createSessionLifecycle,
  type LifecycleAction,
  lifecycleReducer,
  reconstructSessionLifecycle,
  type SessionLifecycleState,
} from "../src/lifecycle.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const authority = { epoch: "epoch-a", generation: 1 } as const;

type VersionedLifecycleAction = Exclude<
  LifecycleAction,
  { type: "runtimeObserved" }
>;
type VersionlessLifecycleAction = VersionedLifecycleAction extends infer Action
  ? Action extends VersionedLifecycleAction
    ? Omit<Action, "epoch" | "generation">
  : never
  : never;

function apply(
  state: SessionLifecycleState,
  action: VersionlessLifecycleAction,
): SessionLifecycleState {
  return lifecycleReducer(
    state,
    { ...authority, ...action } as LifecycleAction,
  );
}

Deno.test("visible turn completion remains unsettled when a follow-up can immediately start", () => {
  let state = createSessionLifecycle(authority);
  state = apply(state, {
    type: "promptQueued",
    promptID: "prompt-1",
    delivery: "steer",
  });
  state = apply(state, {
    type: "promptQueued",
    promptID: "prompt-2",
    delivery: "follow-up",
  });
  state = apply(state, {
    type: "promptAdmitted",
    promptID: "prompt-1",
    turnID: "turn-1",
  });
  state = apply(state, {
    type: "turnStarted",
    promptID: "prompt-1",
    turnID: "turn-1",
  });
  state = apply(state, {
    type: "turnTerminal",
    turnID: "turn-1",
    state: "completed",
  });
  assert(
    state.turns["turn-1"]?.visibleTerminal === "completed",
    "Turn did not become visibly complete",
  );
  assert(
    state.settlement.status === "unsettled",
    "Visible completion incorrectly settled the session",
  );
  assert(
    state.settlement.reasons.includes("QUEUED_PROMPT"),
    "Immediate continuation was not a settlement blocker",
  );
  assert(
    state.prompts["prompt-2"]?.delivery === "follow-up",
    "Follow-up delivery was collapsed into steering",
  );
});

Deno.test("permissions, questions, items, and continuations are explicit settlement blockers", () => {
  let state = createSessionLifecycle(authority);
  state = apply(state, {
    type: "promptQueued",
    promptID: "prompt",
    delivery: "steer",
  });
  state = apply(state, {
    type: "promptAdmitted",
    promptID: "prompt",
    turnID: "turn",
  });
  state = apply(state, {
    type: "turnStarted",
    promptID: "prompt",
    turnID: "turn",
  });
  state = apply(state, {
    type: "itemState",
    itemID: "tool",
    turnID: "turn",
    kind: "tool",
    state: "waiting",
  });
  state = apply(state, { type: "permissionPending", requestID: "permission" });
  state = apply(state, { type: "questionPending", requestID: "question" });
  state = apply(state, { type: "continuationScheduled", continuation: "goal" });
  state = apply(state, { type: "operationStarted", operationID: "commit" });
  state = apply(state, {
    type: "turnTerminal",
    turnID: "turn",
    state: "completed",
  });
  for (
    const reason of [
      "ACTIVE_ITEM",
      "UNRESOLVED_PERMISSION",
      "UNRESOLVED_QUESTION",
      "GOAL_CONTINUATION_PENDING",
      "OPERATION_COMMITTING",
    ] as const
  ) {
    assert(
      state.settlement.reasons.includes(reason),
      `Missing settlement blocker ${reason}`,
    );
  }
  state = apply(state, {
    type: "itemState",
    itemID: "tool",
    turnID: "turn",
    kind: "tool",
    state: "completed",
  });
  state = apply(state, { type: "permissionResolved", requestID: "permission" });
  state = apply(state, { type: "questionResolved", requestID: "question" });
  state = apply(state, { type: "continuationCleared", continuation: "goal" });
  state = apply(state, { type: "operationCommitted", operationID: "commit" });
  assert(
    state.settlement.status === "settled",
    `Session remained unsettled: ${state.settlement.reasons.join(", ")}`,
  );
});

Deno.test("abort deterministically restores or rejects admitted input", () => {
  let restored = createSessionLifecycle(authority);
  restored = apply(restored, {
    type: "promptQueued",
    promptID: "restore-me",
    delivery: "steer",
  });
  restored = apply(restored, {
    type: "promptAdmitted",
    promptID: "restore-me",
    turnID: "turn-r",
  });
  restored = apply(restored, {
    type: "turnStarted",
    promptID: "restore-me",
    turnID: "turn-r",
  });
  restored = apply(restored, {
    type: "turnAborted",
    turnID: "turn-r",
    promptDisposition: "restore",
  });
  assert(
    restored.prompts["restore-me"]?.state === "restored",
    "Abort did not restore admitted input",
  );
  assert(
    JSON.stringify(restored.queue) === JSON.stringify(["restore-me"]),
    "Restored input was not returned to the queue exactly once",
  );
  assert(
    restored.settlement.reasons.includes("QUEUED_PROMPT"),
    "Restored prompt did not prevent settlement",
  );

  let rejected = createSessionLifecycle(authority);
  rejected = apply(rejected, {
    type: "promptQueued",
    promptID: "reject-me",
    delivery: "follow-up",
  });
  rejected = apply(rejected, {
    type: "promptAdmitted",
    promptID: "reject-me",
    turnID: "turn-x",
  });
  rejected = apply(rejected, {
    type: "turnStarted",
    promptID: "reject-me",
    turnID: "turn-x",
  });
  rejected = apply(rejected, {
    type: "turnAborted",
    turnID: "turn-x",
    promptDisposition: "reject",
  });
  assert(
    rejected.prompts["reject-me"]?.state === "rejected" &&
      rejected.prompts["reject-me"]?.rejectionCode === "CANCELLED",
    "Abort rejection was not explicit",
  );
  assert(
    rejected.queue.length === 0 && rejected.settlement.status === "settled",
    "Rejected input remained runnable",
  );
});

Deno.test("stale generations cannot mutate state or emit settlement", () => {
  let state = createSessionLifecycle(authority);
  state = apply(state, {
    type: "promptQueued",
    promptID: "prompt",
    delivery: "steer",
  });
  const before = state;
  state = lifecycleReducer(state, {
    type: "promptRejected",
    epoch: "epoch-old",
    generation: 0,
    promptID: "prompt",
    code: "STALE",
  });
  assert(state === before, "Stale generation mutated lifecycle state");
  state = lifecycleReducer(state, {
    type: "runtimeObserved",
    runtime: { epoch: "epoch-b", generation: 2 },
  });
  assert(
    state.settlement.status === "unsettled" &&
      state.settlement.reasons[0] === "RUNTIME_EPOCH_MISMATCH",
    "Epoch mismatch did not prevent settlement",
  );
  const staleRevision = state.settlement.revision;
  state = lifecycleReducer(state, {
    type: "promptRejected",
    ...authority,
    promptID: "prompt",
    code: "STALE_RUNTIME",
  });
  assert(
    state.settlement.revision > staleRevision &&
      state.settlement.reasons.includes("RUNTIME_EPOCH_MISMATCH"),
    "A matching session action incorrectly settled a mismatched runtime",
  );
});

Deno.test("authoritative lifecycle projection reconstructs derived settlement", () => {
  const state = reconstructSessionLifecycle({
    authority,
    runtime: authority,
    revision: 42,
    prompts: [{ id: "prompt", delivery: "follow-up", state: "restored" }],
    queue: ["prompt"],
    unresolvedQuestionIDs: ["question", "question"],
    pendingContinuations: ["retry"],
  });
  assert(
    state.revision === 42 && state.settlement.revision === 42,
    "Projection revision drifted",
  );
  assert(
    JSON.stringify(state.unresolvedQuestionIDs) ===
      JSON.stringify(["question"]),
    "Projection did not normalize duplicate pending IDs",
  );
  assert(
    JSON.stringify(state.settlement.reasons) ===
      JSON.stringify(["UNRESOLVED_QUESTION", "QUEUED_PROMPT", "RETRY_PENDING"]),
    "Projection settlement was not derived from authoritative state",
  );
});
