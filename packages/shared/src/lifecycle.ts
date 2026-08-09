export type PromptDelivery = "steer" | "follow-up";
export type ExperienceMode = "workbench" | "native";
export type OpenCodeTransportMode = "http-sse" | "acp";

export interface SessionLocator {
  sessionID: string;
  directory: string;
  worktreeID?: string;
  experience: ExperienceMode;
  transport: OpenCodeTransportMode;
  runtimeEpoch: string;
}
export type PromptAdmissionState =
  | "queued"
  | "admitted"
  | "consumed"
  | "restored"
  | "rejected";
export type TurnState =
  | "starting"
  | "streaming"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export type TurnTerminalState = Extract<
  TurnState,
  "completed" | "failed" | "cancelled"
>;
export type LifecycleItemKind = "stream" | "tool";
export type LifecycleItemState =
  | "active"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export type ContinuationKind = "retry" | "compaction" | "goal";

export interface LifecycleAuthority {
  epoch: string;
  generation: number;
}

export interface PromptAdmission {
  id: string;
  delivery: PromptDelivery;
  state: PromptAdmissionState;
  admittedTurnID?: string;
  rejectionCode?: string;
}

export interface TurnLifecycle {
  id: string;
  promptID: string;
  state: TurnState;
  visibleTerminal?: TurnTerminalState;
}

export interface LifecycleItem {
  id: string;
  turnID: string;
  kind: LifecycleItemKind;
  state: LifecycleItemState;
}

export interface SettlementState {
  status: "unsettled" | "settled";
  epoch: string;
  generation: number;
  revision: number;
  reasons: SettlementReason[];
}

export type SettlementReason =
  | "RUNTIME_EPOCH_MISMATCH"
  | "ACTIVE_TURN"
  | "ACTIVE_ITEM"
  | "UNRESOLVED_PERMISSION"
  | "UNRESOLVED_QUESTION"
  | "QUEUED_PROMPT"
  | "RETRY_PENDING"
  | "COMPACTION_PENDING"
  | "GOAL_CONTINUATION_PENDING"
  | "OPERATION_COMMITTING";

export interface SessionLifecycleState {
  authority: LifecycleAuthority;
  runtime: LifecycleAuthority;
  revision: number;
  prompts: Record<string, PromptAdmission>;
  queue: string[];
  turns: Record<string, TurnLifecycle>;
  activeTurnID?: string;
  items: Record<string, LifecycleItem>;
  unresolvedPermissionIDs: string[];
  unresolvedQuestionIDs: string[];
  pendingContinuations: ContinuationKind[];
  committingOperationIDs: string[];
  settlement: SettlementState;
}

interface VersionedAction extends LifecycleAuthority {}

export type LifecycleAction =
  | { type: "runtimeObserved"; runtime: LifecycleAuthority }
  | (VersionedAction & {
    type: "promptQueued";
    promptID: string;
    delivery: PromptDelivery;
  })
  | (VersionedAction & {
    type: "promptAdmitted";
    promptID: string;
    turnID: string;
  })
  | (VersionedAction & {
    type: "promptRejected";
    promptID: string;
    code: string;
  })
  | (VersionedAction & {
    type: "turnStarted";
    turnID: string;
    promptID: string;
  })
  | (VersionedAction & {
    type: "turnState";
    turnID: string;
    state: Exclude<TurnState, TurnTerminalState>;
  })
  | (VersionedAction & {
    type: "turnTerminal";
    turnID: string;
    state: TurnTerminalState;
  })
  | (VersionedAction & {
    type: "itemState";
    itemID: string;
    turnID: string;
    kind: LifecycleItemKind;
    state: LifecycleItemState;
  })
  | (VersionedAction & {
    type: "permissionPending" | "permissionResolved";
    requestID: string;
  })
  | (VersionedAction & {
    type: "questionPending" | "questionResolved";
    requestID: string;
  })
  | (VersionedAction & {
    type: "continuationScheduled" | "continuationCleared";
    continuation: ContinuationKind;
  })
  | (VersionedAction & {
    type: "operationStarted" | "operationCommitted";
    operationID: string;
  })
  | (VersionedAction & {
    type: "turnAborted";
    turnID: string;
    promptDisposition: "restore" | "reject";
  });

export interface LifecycleProjection {
  authority: LifecycleAuthority;
  runtime: LifecycleAuthority;
  revision?: number;
  prompts?: PromptAdmission[];
  queue?: string[];
  turns?: TurnLifecycle[];
  activeTurnID?: string;
  items?: LifecycleItem[];
  unresolvedPermissionIDs?: string[];
  unresolvedQuestionIDs?: string[];
  pendingContinuations?: ContinuationKind[];
  committingOperationIDs?: string[];
}

function validAuthority(authority: LifecycleAuthority): void {
  if (
    !authority.epoch || !Number.isSafeInteger(authority.generation) ||
    authority.generation < 0
  ) {
    throw new Error(
      "Lifecycle authority requires a non-empty epoch and non-negative generation",
    );
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function add(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.slice() : [...values, value];
}

function remove(values: readonly string[], value: string): string[] {
  return values.filter((candidate) => candidate !== value);
}

function recordByID<T extends { id: string }>(
  values: readonly T[],
): Record<string, T> {
  const result = Object.create(null) as Record<string, T>;
  for (const value of values) {
    if (!value.id) throw new Error("Lifecycle projection contains an empty ID");
    if (Object.hasOwn(result, value.id)) {
      throw new Error(`Lifecycle projection contains duplicate ID ${value.id}`);
    }
    result[value.id] = { ...value };
  }
  return result;
}

export function settlementReasons(
  state: Omit<SessionLifecycleState, "settlement">,
): SettlementReason[] {
  const reasons: SettlementReason[] = [];
  if (
    state.authority.epoch !== state.runtime.epoch ||
    state.authority.generation !== state.runtime.generation
  ) reasons.push("RUNTIME_EPOCH_MISMATCH");
  if (state.activeTurnID) reasons.push("ACTIVE_TURN");
  if (
    Object.values(state.items).some((item) =>
      item.state === "active" || item.state === "waiting"
    )
  ) reasons.push("ACTIVE_ITEM");
  if (state.unresolvedPermissionIDs.length) {
    reasons.push("UNRESOLVED_PERMISSION");
  }
  if (state.unresolvedQuestionIDs.length) reasons.push("UNRESOLVED_QUESTION");
  if (
    state.queue.some((id) =>
      state.prompts[id]?.state === "queued" ||
      state.prompts[id]?.state === "restored"
    )
  ) reasons.push("QUEUED_PROMPT");
  if (state.pendingContinuations.includes("retry")) {
    reasons.push("RETRY_PENDING");
  }
  if (state.pendingContinuations.includes("compaction")) {
    reasons.push("COMPACTION_PENDING");
  }
  if (state.pendingContinuations.includes("goal")) {
    reasons.push("GOAL_CONTINUATION_PENDING");
  }
  if (state.committingOperationIDs.length) reasons.push("OPERATION_COMMITTING");
  return reasons;
}

function withSettlement(
  state: Omit<SessionLifecycleState, "settlement">,
  revision = state.revision,
): SessionLifecycleState {
  const next = { ...state, revision };
  const reasons = settlementReasons(next);
  return {
    ...next,
    settlement: {
      status: reasons.length ? "unsettled" : "settled",
      epoch: next.authority.epoch,
      generation: next.authority.generation,
      revision,
      reasons,
    },
  };
}

export function createSessionLifecycle(
  authority: LifecycleAuthority,
): SessionLifecycleState {
  validAuthority(authority);
  return withSettlement({
    authority: { ...authority },
    runtime: { ...authority },
    revision: 0,
    prompts: Object.create(null) as Record<string, PromptAdmission>,
    queue: [],
    turns: Object.create(null) as Record<string, TurnLifecycle>,
    items: Object.create(null) as Record<string, LifecycleItem>,
    unresolvedPermissionIDs: [],
    unresolvedQuestionIDs: [],
    pendingContinuations: [],
    committingOperationIDs: [],
  });
}

export function reconstructSessionLifecycle(
  projection: LifecycleProjection,
): SessionLifecycleState {
  validAuthority(projection.authority);
  validAuthority(projection.runtime);
  const prompts = recordByID(projection.prompts ?? []);
  const turns = recordByID(projection.turns ?? []);
  const items = recordByID(projection.items ?? []);
  const queue = unique(projection.queue ?? []);
  for (const promptID of queue) {
    const prompt = prompts[promptID];
    if (!prompt || (prompt.state !== "queued" && prompt.state !== "restored")) {
      throw new Error(
        `Lifecycle queue references non-runnable prompt ${promptID}`,
      );
    }
  }
  if (projection.activeTurnID && !turns[projection.activeTurnID]) {
    throw new Error(
      `Lifecycle active turn ${projection.activeTurnID} is missing`,
    );
  }
  return withSettlement({
    authority: { ...projection.authority },
    runtime: { ...projection.runtime },
    revision: projection.revision ?? 0,
    prompts,
    queue,
    turns,
    activeTurnID: projection.activeTurnID,
    items,
    unresolvedPermissionIDs: unique(projection.unresolvedPermissionIDs ?? []),
    unresolvedQuestionIDs: unique(projection.unresolvedQuestionIDs ?? []),
    pendingContinuations: [...new Set(projection.pendingContinuations ?? [])],
    committingOperationIDs: unique(projection.committingOperationIDs ?? []),
  });
}

function versionMatches(
  state: SessionLifecycleState,
  action: VersionedAction,
): boolean {
  return action.epoch === state.authority.epoch &&
    action.generation === state.authority.generation;
}

function updatePrompt(
  prompts: Record<string, PromptAdmission>,
  promptID: string,
  update: (prompt: PromptAdmission) => PromptAdmission,
): Record<string, PromptAdmission> {
  const current = prompts[promptID];
  if (!current) return prompts;
  return { ...prompts, [promptID]: update(current) };
}

export function lifecycleReducer(
  state: SessionLifecycleState,
  action: LifecycleAction,
): SessionLifecycleState {
  if (action.type === "runtimeObserved") {
    validAuthority(action.runtime);
    if (
      state.runtime.epoch === action.runtime.epoch &&
      state.runtime.generation === action.runtime.generation
    ) return state;
    return withSettlement(
      { ...state, runtime: { ...action.runtime } },
      state.revision + 1,
    );
  }
  if (!versionMatches(state, action)) return state;

  let next: Omit<SessionLifecycleState, "settlement"> = state;
  if (action.type === "promptQueued") {
    if (!action.promptID || state.prompts[action.promptID]) return state;
    next = {
      ...state,
      prompts: {
        ...state.prompts,
        [action.promptID]: {
          id: action.promptID,
          delivery: action.delivery,
          state: "queued",
        },
      },
      queue: [...state.queue, action.promptID],
    };
  } else if (action.type === "promptAdmitted") {
    const prompt = state.prompts[action.promptID];
    if (!prompt || !["queued", "restored"].includes(prompt.state)) return state;
    next = {
      ...state,
      prompts: updatePrompt(state.prompts, action.promptID, (current) => ({
        ...current,
        state: "admitted",
        admittedTurnID: action.turnID,
        rejectionCode: undefined,
      })),
      queue: remove(state.queue, action.promptID),
    };
  } else if (action.type === "promptRejected") {
    if (!state.prompts[action.promptID]) return state;
    next = {
      ...state,
      prompts: updatePrompt(state.prompts, action.promptID, (current) => ({
        ...current,
        state: "rejected",
        rejectionCode: action.code,
      })),
      queue: remove(state.queue, action.promptID),
    };
  } else if (action.type === "turnStarted") {
    const prompt = state.prompts[action.promptID];
    if (
      !prompt || prompt.state !== "admitted" ||
      prompt.admittedTurnID !== action.turnID || state.activeTurnID ||
      state.turns[action.turnID]
    ) return state;
    next = {
      ...state,
      turns: {
        ...state.turns,
        [action.turnID]: {
          id: action.turnID,
          promptID: action.promptID,
          state: "starting",
        },
      },
      activeTurnID: action.turnID,
      prompts: updatePrompt(
        state.prompts,
        action.promptID,
        (current) => ({ ...current, state: "consumed" }),
      ),
    };
  } else if (action.type === "turnState") {
    const turn = state.turns[action.turnID];
    if (!turn || turn.visibleTerminal) return state;
    next = {
      ...state,
      turns: {
        ...state.turns,
        [action.turnID]: { ...turn, state: action.state },
      },
    };
  } else if (action.type === "turnTerminal") {
    const turn = state.turns[action.turnID];
    if (!turn || turn.visibleTerminal) return state;
    next = {
      ...state,
      turns: {
        ...state.turns,
        [action.turnID]: {
          ...turn,
          state: action.state,
          visibleTerminal: action.state,
        },
      },
      activeTurnID: state.activeTurnID === action.turnID
        ? undefined
        : state.activeTurnID,
    };
  } else if (action.type === "itemState") {
    const turn = state.turns[action.turnID];
    if (!turn) return state;
    const existing = state.items[action.itemID];
    if (
      existing &&
      (existing.turnID !== action.turnID || existing.kind !== action.kind)
    ) return state;
    next = {
      ...state,
      items: {
        ...state.items,
        [action.itemID]: {
          id: action.itemID,
          turnID: action.turnID,
          kind: action.kind,
          state: action.state,
        },
      },
    };
  } else if (action.type === "permissionPending") {
    next = {
      ...state,
      unresolvedPermissionIDs: add(
        state.unresolvedPermissionIDs,
        action.requestID,
      ),
    };
  } else if (action.type === "permissionResolved") {
    next = {
      ...state,
      unresolvedPermissionIDs: remove(
        state.unresolvedPermissionIDs,
        action.requestID,
      ),
    };
  } else if (action.type === "questionPending") {
    next = {
      ...state,
      unresolvedQuestionIDs: add(state.unresolvedQuestionIDs, action.requestID),
    };
  } else if (action.type === "questionResolved") {
    next = {
      ...state,
      unresolvedQuestionIDs: remove(
        state.unresolvedQuestionIDs,
        action.requestID,
      ),
    };
  } else if (action.type === "continuationScheduled") {
    next = {
      ...state,
      pendingContinuations: add(
        state.pendingContinuations,
        action.continuation,
      ) as ContinuationKind[],
    };
  } else if (action.type === "continuationCleared") {
    next = {
      ...state,
      pendingContinuations: remove(
        state.pendingContinuations,
        action.continuation,
      ) as ContinuationKind[],
    };
  } else if (action.type === "operationStarted") {
    next = {
      ...state,
      committingOperationIDs: add(
        state.committingOperationIDs,
        action.operationID,
      ),
    };
  } else if (action.type === "operationCommitted") {
    next = {
      ...state,
      committingOperationIDs: remove(
        state.committingOperationIDs,
        action.operationID,
      ),
    };
  } else if (action.type === "turnAborted") {
    const turn = state.turns[action.turnID];
    if (!turn || turn.visibleTerminal) return state;
    const prompt = state.prompts[turn.promptID];
    const restore = action.promptDisposition === "restore" && prompt;
    next = {
      ...state,
      turns: {
        ...state.turns,
        [turn.id]: {
          ...turn,
          state: "cancelled",
          visibleTerminal: "cancelled",
        },
      },
      activeTurnID: state.activeTurnID === turn.id
        ? undefined
        : state.activeTurnID,
      prompts: prompt
        ? updatePrompt(
          state.prompts,
          prompt.id,
          (current) =>
            restore
              ? { ...current, state: "restored", rejectionCode: undefined }
              : { ...current, state: "rejected", rejectionCode: "CANCELLED" },
        )
        : state.prompts,
      queue: restore ? add(state.queue, prompt.id) : state.queue,
      items: Object.fromEntries(
        Object.entries(state.items).map(([id, item]) => [
          id,
          item.turnID === turn.id &&
            (item.state === "active" || item.state === "waiting")
            ? { ...item, state: "cancelled" as const }
            : item,
        ]),
      ),
    };
  }

  if (next === state) return state;
  return withSettlement(next, state.revision + 1);
}
