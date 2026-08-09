# OpenCode Workbench Evolution — Harness-Aware Implementation Plan v2

> A handoff-ready plan for evolving OpenCode Workbench into the OpenCode-native harness and control plane for VS Code while preserving OpenCode authority, supporting the current stable Workbench UI, and experimentally integrating with VS Code Agent Host/AHP where contracts are complete enough.

- **Plan version:** 2.0
- **Review date:** 2026-08-07
- **Repository baseline:** `Nulifyer/opencode-workbench` `main`
- **Observed extension version:** `0.4.6`
- **Observed VS Code minimum:** `^1.106.0`
- **Current VS Code platform reviewed:** 1.130–1.131
- **References reviewed:** OpenCode, OpenChamber, Codex, Claude Code, Pi, VS Code Chat, VS Code Agent Host, ACP, and AHP

This document supersedes `OPENCODE_WORKBENCH_IMPLEMENTATION_PLAN.md`. The earlier plan remains useful background, but this version controls sequencing and architecture.

---

# 0. How to use this plan

This plan is written for an engineer or coding model working directly in the repository.

1. Inspect current `HEAD` before editing. Paths and line counts in this plan are a reviewed baseline, not immutable contracts.
2. Read `OPENCODE_WORKBENCH_HARNESS_REVIEW.md` before implementing any native VS Code integration.
3. Work one numbered issue at a time.
4. Keep discovery, mechanical refactors, protocol changes, and user-visible behavior in separate commits.
5. Keep every commit buildable and testable.
6. Do not invent OpenCode, ACP, AHP, or VS Code extension capabilities.
7. Prove uncertain external behavior with provider-free contract tests or a documented executable spike.
8. Do not implement a dependent feature after a spike reports a blocking incompatibility.
9. Update ADRs, design documentation, capability matrices, and tests whenever reality differs from this plan.
10. Do not raise the extension’s VS Code minimum merely to simplify an experimental native path.

The first implementation session must complete **DISC-001** and begin **ACP-001**. It must not jump directly into worktrees, Multi-run, AHP, or a webview rewrite.

---

# 1. Product mandate

## 1.1 Target product

OpenCode Workbench should become:

> **The OpenCode-native harness and control plane for VS Code.**

It should provide:

- a stable OpenCode-native chat and session experience for supported VS Code versions;
- an experimental path into native VS Code Chat and Agents surfaces when AHP/ACP contracts are sufficient;
- deep and visible editor-context integration;
- exact permission and question handling;
- isolated worktree-backed sessions;
- parallel model runs and objective comparison;
- plan-first workflows and goal automation;
- independent goal verification using OpenCode;
- native VS Code diff and SCM navigation;
- Changes Walkthrough;
- trustworthy recovery, diagnostics, conformance tests, and state reconciliation.

## 1.2 Experience modes

### Stable Workbench mode

The existing extension-host + webview architecture remains the stable experience:

```text
Workbench webview
      │ validated protocol
      ▼
Workbench extension host
      │ HTTP/SSE + authenticated bridge
      ▼
OpenCode server + companion plugin
```

Characteristics:

- supported on the current minimum VS Code version;
- direct OpenCode HTTP/SSE integration;
- complete Workbench-specific permission, context, goal, preference, and skill-candidate behavior;
- custom session/conversation UI;
- no dependency on proposed VS Code AI APIs.

### Experimental native mode

Native mode may be added only after ADR approval:

```text
VS Code Chat / Agents window
            │ AHP
            ▼
OpenCode AHP bridge/host
            │ ACP
            ▼
       opencode acp
            │
            ▼
 companion plugin and OpenCode runtime
```

Characteristics:

- current-generation VS Code only;
- capability- and version-gated;
- native VS Code generic session, worktree, changeset, and multi-client surfaces;
- supplemental Workbench UI for OpenCode-specific state;
- automatic fallback when exact semantics cannot be represented.

### Single-authority rule

A given OpenCode session must have exactly one active orchestration authority:

```text
Workbench custom controller
OR
AHP host
```

Never both.

## 1.3 Non-negotiable architecture rules

1. **OpenCode remains authoritative** for models, providers, agents, tools, sessions, messages, transcripts, permissions, questions, and native runtime status.
2. **The Workbench companion OpenCode plugin remains authoritative** for persistent goals, goal continuation, approved preferences, and staged skill candidates.
3. **Do not add a competing model loop.**
4. **Do not add a provider SDK or duplicate provider/account configuration.**
5. **The stable webview has no direct network access.**
6. **The extension host remains the only backend for the stable webview.**
7. **No arbitrary shell strings cross a webview or AHP control boundary.**
8. **Use native VS Code editors, diffs, SCM, terminals, tasks, diagnostics, and workspace trust where possible.**
9. **Do not persist prompt attachment bytes, unsaved-buffer contents, secrets, or complete prompt payloads in Workbench metadata.**
10. **Every external capability is negotiated and capability-gated.**
11. **Exact permission semantics must not be silently weakened or broadened.**
12. **Dirty worktrees are never deleted automatically.**
13. **Exactly one component owns each worktree lifecycle.**
14. **No feature silently truncates a diff, context payload, permission detail, or verifier input and presents it as complete.**
15. **Prompt admission and run completion are separate states.**
16. **Turn completion and session settlement are separate states.**
17. **Do not use proposed VS Code APIs as a requirement for stable Marketplace behavior.**
18. **Do not turn Workbench into a universal frontend for Codex, Claude, Pi, or other harnesses.**
19. **Do not migrate the webview to React or another framework as part of this program.**
20. **Do not duplicate VS Code’s generic session/worktree/changes UI in native mode.**

## 1.4 Explicit non-goals

Do not add:

- a desktop application;
- a mobile application;
- remote relay or tunnel infrastructure;
- a custom terminal emulator;
- a custom browser/proxy stack;
- duplicated GitHub authentication;
- a generic shell-hook platform;
- a transcript database;
- a generic filesystem or HTTP proxy exposed to the webview;
- automatic branch merging in the first Multi-run release;
- an AI-selected winner before objective comparison is mature;
- Codex, Claude, or Pi runtime adapters;
- a VS Code Language Model Provider wrapper around OpenCode;
- a Chat Participant implementation that replaces OpenCode’s loop.

---

# 2. Current baseline and constraints

## 2.1 Existing strengths to preserve

Verify these against current `HEAD`:

- Managed mode starts a private authenticated loopback OpenCode server per VS Code window.
- External mode supports separately managed OpenCode servers with bounded authentication handling.
- OpenCode remains responsible for agents, models, tools, permissions, sessions, and transcripts.
- The companion plugin provides goals, preferences, skill candidates, and authenticated editor bridge tools.
- Native OpenCode queue, steer, replace, abort, permission, question, fork, and session actions are projected into the UI.
- Reconnect logic reconciles metadata, status, catalog, runtime services, and selected/busy transcripts.
- The event path is ordered and stress-tested with 20,000-event bursts.
- The webview uses a nonce CSP and no network access.
- Webview messages are bounded and runtime-validated.
- Permission cards distinguish exact from incomplete/truncated detail.
- Pending attachment bytes stay private and in memory.
- Bridge requests are allowlisted, authenticated, size-bounded, and workspace-contained.
- Workbench supports sidebar and editor-area chat surfaces with synchronized composer payloads.

## 2.2 Current concentration points

At the reviewed baseline:

- `packages/vscode-extension/src/session-controller.ts` owns too many runtime and projection concerns.
- `packages/vscode-extension/src/webview/main.ts` owns too many state, rendering, focus, scroll, overlay, and interaction concerns.
- `packages/shared/src/protocol.ts` is a flat union without a general request/result envelope, initialization negotiation, cancellation, structured errors, or a settled-state contract.
- `OpenCodeConnection` couples transport and one `directory`.
- The bridge assumes one authorized root.
- `WorkbenchState` is session-centric rather than run-group/worktree aware.
- The extension minimum is VS Code 1.106; current Agent Host functionality is much newer and still evolving.

## 2.3 New external constraints

### OpenCode ACP

`opencode acp` exists and claims broad feature support, but Workbench-specific and advanced lifecycle behavior is not proven.

### VS Code Agent Host/AHP

The architecture is appropriate but still under active development. A stable third-party harness contribution path is not yet a documented Marketplace contract.

### Proposed session API

`chatSessionsProvider` is proposed and may change. Stable Workbench must not depend on it.

### Native UI authentication and availability

The project must prove whether an arbitrary AHP host can use native surfaces without requiring a specific GitHub Copilot plan or first-party harness integration.

---

# 3. Target architecture

## 3.1 Canonical runtime projection

Do not replace OpenCode’s native message schema. Introduce a derived, UI-oriented projection:

```text
OpenCode runtime
└── Session
    ├── one or more Chats/branches
    │   ├── Turn
    │   │   ├── user input
    │   │   ├── reasoning/activity items
    │   │   ├── tools
    │   │   ├── changes
    │   │   └── assistant result
    │   └── queued input
    ├── Directory/worktree locator
    ├── Goal reference
    └── Run-group reference
```

Suggested shared types:

```ts
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

export type PromptAdmissionResult =
  | { status: "started"; turnID: string }
  | {
      status: "queued";
      queueID: string;
      delivery: "steer" | "followUp";
    }
  | { status: "replaced"; queueID: string }
  | { status: "rejected"; error: StructuredError };

export type TurnStatus =
  | "accepted"
  | "running"
  | "awaiting-permission"
  | "awaiting-question"
  | "completed"
  | "interrupted"
  | "failed";

export type SettlementState =
  | "active"
  | "settling"
  | "settled"
  | "needs-input"
  | "disconnected";
```

## 3.2 Adapter boundaries

The project may contain two OpenCode transport adapters, not multiple harness adapters:

```text
OpenCodeHttpAdapter   — current HTTP/SSE mode
OpenCodeAcpAdapter    — experimental/native bridge mode
```

Both should map into a capability-aware application service where practical, but no abstraction may pretend unsupported behavior exists.

Suggested interface shape after discovery:

```ts
interface OpenCodeRuntimeAdapter {
  readonly capabilities: RuntimeCapabilities;

  initialize(signal: AbortSignal): Promise<RuntimeInitialization>;
  createSession(input: CreateSessionInput, signal: AbortSignal): Promise<SessionLocator>;
  resumeSession(locator: SessionLocator, signal: AbortSignal): Promise<void>;
  forkSession(input: ForkSessionInput, signal: AbortSignal): Promise<SessionLocator>;
  admitPrompt(input: PromptInput, signal: AbortSignal): Promise<PromptAdmissionResult>;
  cancelTurn(input: CancelTurnInput, signal: AbortSignal): Promise<void>;
  respondPermission(input: PermissionResponse, signal: AbortSignal): Promise<void>;
  respondQuestion(input: QuestionResponse, signal: AbortSignal): Promise<void>;
  subscribe(listener: RuntimeEventListener): Disposable;
}
```

Do not finalize this interface until ACP-001 and current HTTP behavior are compared.

## 3.3 Stable extension-host architecture

```text
packages/vscode-extension/src/application/
├── workbench-controller.ts
├── capability-service.ts
├── connection-coordinator.ts
├── session-repository.ts
├── transcript-reconciler.ts
├── prompt-dispatcher.ts
├── permission-coordinator.ts
├── question-coordinator.ts
├── settlement-coordinator.ts
├── context-service.ts
├── plan-service.ts
├── goal-service.ts
├── diff-service.ts
├── walkthrough-service.ts
├── run-group-service.ts
├── worktree-service.ts          # fallback owner only
├── health-service.ts
└── trace-service.ts

packages/vscode-extension/src/runtime/
├── http/
│   ├── open-code-http-adapter.ts
│   ├── event-stream.ts
│   └── sdk-mappers.ts
└── acp/                         # experimental after ADR
    ├── process-manager.ts
    ├── open-code-acp-adapter.ts
    └── event-mapper.ts
```

## 3.4 Webview architecture

Keep native DOM rendering but separate domains:

```text
packages/vscode-extension/src/webview/
├── bootstrap.ts
├── transport/
│   ├── client.ts
│   ├── protocol-v1-adapter.ts
│   └── request-registry.ts
├── state/
│   ├── store.ts
│   ├── reducer.ts
│   ├── selectors.ts
│   ├── sessions.ts
│   ├── turns.ts
│   ├── composer.ts
│   ├── attention.ts
│   ├── context.ts
│   ├── goals.ts
│   ├── runs.ts
│   └── layout.ts
├── views/
│   ├── conversation.ts
│   ├── turn.ts
│   ├── activity-item.ts
│   ├── composer.ts
│   ├── queue.ts
│   ├── permission-card.ts
│   ├── question-card.ts
│   ├── session-list.ts           # stable mode only
│   └── inspector/
│       ├── shell.ts
│       ├── activity.ts
│       ├── changes.ts
│       ├── context.ts
│       ├── goal.ts
│       ├── runs.ts
│       └── walkthrough.ts
├── controllers/
│   ├── focus-controller.ts
│   ├── scroll-controller.ts
│   ├── overlay-controller.ts
│   ├── autocomplete-controller.ts
│   └── drag-drop-controller.ts
└── rendering/
    ├── keyed-list.ts
    ├── scheduler.ts
    └── signatures.ts
```

## 3.5 Experimental AHP host architecture

Only after ADR approval:

```text
packages/opencode-ahp-host/
├── main.ts
├── server.ts
├── session-registry.ts
├── acp-process-pool.ts
├── acp-event-mapper.ts
├── permission-mapper.ts
├── elicitation-mapper.ts
├── changeset-mapper.ts
├── terminal-mapper.ts
├── capability-mapper.ts
├── reconciliation.ts
└── test/
```

Rules:

- Keep this process separable from the stable extension package.
- Use the official AHP package/schema version pinned and recorded in compatibility metadata.
- Launch `opencode acp` with typed arguments and controlled environment.
- Do not expose Workbench bridge credentials to arbitrary clients.
- Do not assume a single client.
- Keep the host as authoritative for AHP state but never as a replacement for OpenCode’s transcript authority.
- Persist only the minimum host/session mapping needed for reconnection.

## 3.6 Supplemental native-mode UI

Native mode should not recreate generic conversation/session UI. Add a thin OpenCode-specific contribution:

```text
OpenCode Details
├── Runtime health
├── Exact context ledger
├── Goal and verifier
├── Preferences
├── Skill candidates
├── Run groups / comparison
└── Walkthrough
```

Every native session link must be backed by a proven focus/deep-link API. If no stable navigation API exists, the native prototype must state that limitation rather than faking selection.

---

# 4. Delivery strategy

## 4.1 Release slices

### Release A — Contract and lifecycle foundations

- discovery ADRs;
- ACP contract harness;
- protocol v2 primitives;
- prompt admission and settlement semantics;
- controller/webview decomposition;
- Health Center and trace.

### Release B — Stable-mode UX improvements

- attention inbox;
- behavioral steer/follow-up UX;
- context ledger and receipts;
- inspector;
- plan-first workflow;
- accessibility and long-session navigation.

### Experimental track N — Native Agent Host prototype

- ACP adapter;
- AHP bridge;
- lossless permission/question mapping;
- native changes/worktree mapping;
- capability and version gates;
- conformance suite.

This track does not block Releases A or B.

### Release C — Isolation, Multi-run, and comparison

- single worktree owner;
- worktree-backed sessions in the selected mode;
- RunGroup metadata;
- Multi-run;
- objective comparison.

### Release D — Review and autonomy

- exact diff identity;
- Changes Walkthrough;
- deterministic evidence;
- goal verifier v2;
- optional Fusion after comparison is mature.

## 4.2 Pull-request rules

Each PR must:

- implement one numbered issue or one tightly coupled issue pair;
- keep mechanical refactors separate from behavior where possible;
- include tests for every changed boundary;
- update design/ADR docs;
- list capability and compatibility impact;
- include exact commands and results;
- avoid unrelated formatting churn;
- preserve managed and external server modes unless the issue explicitly changes them;
- preserve sidebar and editor surfaces in stable mode;
- avoid proposed VS Code APIs in stable production code.

---

# 5. Phase 0 — discovery and architecture decisions

## [x] DISC-001 — Freeze current invariants and create the harness capability matrix

### Purpose

Create a checked-in source of truth before changing architecture.

### Files

```text
docs/architecture/invariants.md
docs/architecture/harness-capabilities.md
docs/architecture/current-state.md
```

### Work

Document:

- current OpenCode version contract;
- current VS Code minimum;
- current HTTP/SSE methods and event types used;
- session/message/part identity rules;
- queue/steer/replace/abort behavior;
- permission protocols and decisions;
- question lifecycle;
- companion-plugin capabilities;
- bridge roots and affinity;
- reconnect/reconciliation behavior;
- persistence locations and sensitive data exclusions;
- custom webview state ownership;
- current tests proving each invariant.

Add a capability table with columns:

```text
Capability
HTTP/SSE stable mode
OpenCode ACP
AHP mapping
Native VS Code surface
Supplemental Workbench UI
Blocking gaps
Evidence/test
```

### Acceptance criteria

- Every current user-facing runtime behavior has an owner and source contract.
- Unknown behavior is marked unknown, not guessed.
- Existing tests are linked to the invariants they prove.
- No production behavior changes.

## [x] ACP-001 — Build a provider-free OpenCode ACP contract recorder

### Purpose

Prove actual ACP behavior against an installed compatible OpenCode executable.

### Proposed files

```text
packages/vscode-extension/test/acp_contract_test.ts
packages/vscode-extension/test/fixtures/acp/
scripts/record-opencode-acp-contract.ts
docs/adr/0001-opencode-acp-contract.md
```

### Required probes

- initialize handshake and capability response;
- session create/new;
- session resume/list/fork if available;
- agent/model selection;
- custom tools and slash commands discovery;
- MCP and companion plugin visibility;
- permission request and every supported response;
- question/user-input request;
- prompt streaming lifecycle;
- cancellation;
- reasoning/tool/message updates;
- diff/change metadata;
- token/cost/context metadata;
- queue/steer/follow-up/replace behavior;
- process termination and malformed message behavior;
- working-directory behavior;
- multiple simultaneous ACP subprocesses;
- `/undo` and `/redo` documented limitations;
- session persistence across process restart.

### Rules

- Do not send a provider/model request unless a separate opt-in real integration test is explicitly enabled.
- Use deterministic fixtures for default tests.
- Redact secrets and local paths from committed fixtures.
- Pin the OpenCode version used to record fixtures.

### Acceptance criteria

- Exact method and event names are documented.
- Every Workbench capability is classified as supported, mapped, missing, or unknown.
- Tests fail clearly when a newer OpenCode version changes the ACP contract.
- No production ACP adapter is implemented yet.

## [x] AHP-001 — Prove third-party Agent Host connectivity in VS Code

### Purpose

Determine whether Workbench can connect an arbitrary OpenCode-backed AHP host to current VS Code without private assumptions.

### Test matrix

- VS Code Stable current release;
- VS Code Insiders current release;
- local workspace;
- remote SSH workspace if feasible;
- trusted and untrusted workspace;
- GitHub signed in and signed out;
- Copilot enabled and disabled where permitted;
- Marketplace-installed extension versus development host.

### Questions

1. How is a custom AHP host configured or discovered?
2. Can a Marketplace extension register a harness?
3. Can the harness appear in the native harness picker?
4. Can a standalone host be selected without first-party code changes?
5. Are Chat view and Agents window both available?
6. Are native worktrees and changesets available?
7. Can extension-contributed tools reach the host?
8. Can sessions continue after all editor windows disconnect?
9. What authentication is required for the UI shell?
10. Which APIs are proposed, private, or allowlisted?
11. What navigation/deep-link APIs exist for a supplemental Workbench view?
12. What is the behavior on code-server and non-Microsoft VS Code distributions?

### Deliverable

```text
docs/adr/0002-vscode-agent-host-feasibility.md
```

Include a reproducible prototype or explicitly document why one cannot currently be built through public contracts.

### Acceptance criteria

- The result is evidence-based and reproducible.
- Stable versus proposed/private dependencies are clearly separated.
- No production dependency is added.
- A blocking result does not stop stable-mode work.

## [x] MAP-001 — Specify lossless OpenCode ↔ ACP ↔ AHP mapping

### Inputs

- DISC-001 matrix;
- ACP-001 results;
- AHP-001 results;
- current AHP schema;
- current ACP schema.

### Map at minimum

- session create/resume/fork/delete;
- chat/branch identity;
- turn start/end/failure/cancel;
- turn settlement;
- reasoning and text deltas;
- tool calls and results;
- permission choices;
- questions/elicitation;
- queue/steer/follow-up;
- model/agent/variant choice;
- todos;
- token/cost/context metadata;
- file changes/diff;
- terminals;
- worktree/root;
- reconnect/replay;
- custom tools;
- goals/preferences/skills;
- bridge/editor context;
- errors and overload.

### Classification

Every row receives one:

```text
native
lossless mapping
supplemental Workbench UI
safe degradation
blocking incompatibility
```

### Acceptance criteria

- No advanced permission choice is mapped ambiguously.
- No lifecycle state is collapsed in a way that can cause unsafe cleanup or duplicate prompts.
- Supplemental UI requirements are explicit.

## [x] ADR-001 — Select native integration strategy

### Decision options

- `native-first`
- `hybrid`
- `defer-native`

### Recorded outcome

ADR 0003 selected `defer-native` after the spikes reached the documented stop
conditions. Stable Workbench is the only shipped mode; the hybrid option remains
historical design input, not a current recommendation.

### Go criteria for experimental native mode

- public/reproducible VS Code connection path;
- session and turn lifecycle mapping;
- permission/question round trip;
- cancellation;
- worktree/change ownership;
- reconnect behavior;
- exact capability negotiation;
- no forced provider/account duplication;
- no dependence on a private API for basic use.

### Stop conditions

Select `defer-native` if:

- custom harness registration requires private/allowlisted APIs;
- exact permission handling cannot be represented or supplemented safely;
- the host cannot be connected without first-party modification;
- sessions cannot be reconciled to OpenCode authority;
- native UI requires a billing/authentication path incompatible with the product’s purpose.

## [x] VER-001 — Prove the independent verifier execution path

Test in order:

1. separate OpenCode session with tool access disabled;
2. custom OpenCode agent with a bounded structured-output prompt;
3. OpenCode structured-output capability if available;
4. companion-plugin-mediated evaluator only if it still uses OpenCode as the runtime.

Record:

- model selection;
- schema enforcement;
- timeout/cancellation;
- transcript visibility;
- filesystem/tool isolation;
- token accounting;
- retry behavior;
- provider-free test seam.

Do not add a provider SDK.

---

# 6. Phase 1 — lifecycle, protocol, and maintainability foundations

## [x] FND-001 — Add canonical prompt-admission, turn, item, and settlement types

### Files

```text
packages/shared/src/lifecycle.ts
packages/shared/test/lifecycle_test.ts
```

### Requirements

- Prompt admission is separate from run completion.
- Turn completion is separate from session settlement.
- Permission/question waiting is explicit.
- Queue delivery distinguishes steer and follow-up.
- Generation/epoch protects against stale settlement.
- Derived state can be reconstructed from authoritative session state and pending operations.

### Settlement definition

A session is `settled` only when:

- no active stream/tool execution exists;
- no permission or question is unresolved;
- no queued item can immediately start another turn;
- no retry/compaction continuation is pending;
- no goal continuation is admitted or scheduled;
- no operation transition is still committing;
- the runtime/session epoch matches.

### Acceptance criteria

- Unit tests cover immediate continuation after visible turn completion.
- Abort restores or reports queued input deterministically.
- Session transitions cannot emit stale settlement.

## [x] FND-002 — Add protocol v2 envelopes and capability negotiation

### Types

```ts
interface HelloMessage {
  protocolRange: { minimum: number; maximum: number };
  client: { surfaceID: string; extensionVersion: string };
}

interface ReadyMessage {
  protocol: number;
  epoch: string;
  capabilities: WorkbenchCapabilities;
  runtime: RuntimeDescriptor;
  limits: ProtocolLimits;
}

interface Request<TType extends string, TPayload> {
  protocol: 2;
  kind: "request";
  id: string;
  type: TType;
  sessionID?: string;
  expectedRevision?: number;
  mutationID?: string;
  payload: TPayload;
}

interface SuccessResponse<TResult> {
  protocol: 2;
  kind: "response";
  id: string;
  ok: true;
  result: TResult;
}

interface ErrorResponse {
  protocol: 2;
  kind: "response";
  id: string;
  ok: false;
  error: StructuredError;
}

interface Event<TType extends string, TPayload> {
  protocol: 2;
  kind: "event";
  epoch: string;
  sequence: number;
  type: TType;
  sessionID?: string;
  revision?: number;
  payload: TPayload;
}
```

### Structured errors

Minimum codes:

```text
VALIDATION_FAILED
CAPABILITY_UNAVAILABLE
STALE_REVISION
SESSION_BUSY
SESSION_NOT_FOUND
WORKSPACE_MISMATCH
UPSTREAM_DISCONNECTED
AUTH_REQUIRED
OPERATION_CONFLICT
OVERLOADED
CANCELLED
TIMEOUT
INTERNAL
```

Every error includes:

```text
code
message
retryable
details?      # bounded and non-secret
```

### Acceptance criteria

- Unknown protocol versions fail with a clear compatibility error.
- UI controls are derived from negotiated capabilities.
- External mode reports missing companion features truthfully.
- Protocol limits are enforced on both sides.

## [x] FND-003 — Establish one protocol schema source and generated verification

### Goal

Prevent types, validators, fixtures, and docs from drifting.

### Required output

- TypeScript types;
- runtime validators;
- JSON fixture corpus;
- compatibility manifest;
- protocol documentation table.

### Constraint

Prefer no new runtime dependency. A build-time schema/code-generation dependency is acceptable only after an ADR compares it with the current manual validator approach.

### Acceptance criteria

- CI proves every accepted fixture validates.
- CI proves every rejected fixture fails for the expected reason.
- Generated files are reproducible.
- Protocol changes require an explicit version/compatibility decision.

## [x] FND-004 — Add correlated host routing, cancellation, idempotency, and overload behavior

### Proposed files

```text
packages/vscode-extension/src/protocol/host-router.ts
packages/vscode-extension/src/protocol/request-registry.ts
packages/vscode-extension/src/protocol/cancellation-registry.ts
packages/vscode-extension/src/protocol/idempotency-store.ts
```

### Rules

- Every mutation has a request ID.
- Retryable mutations use a stable mutation ID.
- Lost responses do not duplicate session/worktree/run-group creation.
- Long-running requests accept cancellation.
- Pending requests are bounded.
- Overload is returned as a structured retryable error.
- Disposed surfaces cancel or detach requests deterministically.

### Acceptance criteria

- Tests cover duplicate retry, cancellation, timeout, disposal, and overload.
- User input is preserved until prompt admission or explicit rejection.

## [x] FND-005 — Add event epoch, ordered sequence, snapshot, replay, and gap recovery

### Work

- Create a new epoch per host/runtime generation.
- Sequence host events monotonically.
- Add snapshot revision.
- Add `baseRevision` and `nextRevision` to session patches.
- Detect gaps and request fresh state.
- Coalesce high-frequency token/status events without reordering semantic events.
- Bound hidden-surface queues.

### Acceptance criteria

- Reloaded webviews cannot apply stale events from the previous epoch.
- Sequence gaps cause deterministic resync.
- 20,000-event stress tests still pass.
- Hidden surfaces do not accumulate unbounded token deltas.

## [x] FND-006 — Decompose `SessionController` without behavior change

### Extraction order

1. connection coordinator;
2. catalog service;
3. session repository;
4. transcript reconciler;
5. prompt dispatcher;
6. permission coordinator;
7. question coordinator;
8. settlement coordinator;
9. snapshot projector.

### Rules

- No public behavior changes in this issue.
- Preserve generation guards and optimistic reconciliation.
- Preserve managed and external modes.
- Preserve all current tests before deleting old paths.

## [x] FND-007 — Decompose the webview without behavior change

### Extraction order

1. transport client/request registry;
2. store/reducer/selectors;
3. scroll controller;
4. focus/overlay controller;
5. composer and queue;
6. session list;
7. conversation/turn rendering;
8. inspector shell.

### Rules

- No framework migration.
- Preserve both sidebar and editor modes.
- Preserve focus restoration and synchronized composer payloads.
- Preserve near-bottom follow behavior and unread counts.

## [x] FND-008 — Add Health Center and sanitized session trace

### Health fields

- Workbench version;
- VS Code version;
- experience mode;
- OpenCode version;
- transport mode;
- server/process state;
- plugin state;
- capability set;
- event stream state;
- last event/reconciliation;
- reconnect count;
- request queue depth;
- protocol version/epoch;
- current authorized roots;
- native-mode AHP/ACP versions when applicable.

### Trace fields

- request/event type;
- IDs and revisions;
- timestamps and durations;
- admission and lifecycle transitions;
- permission/question state;
- reconnect/resync;
- diff hash;
- settlement transition;
- sanitized error.

Never include credentials, prompt text, attachment data, unsaved-buffer content, or tool result bodies by default.

---

# 7. Phase 2 — stable-mode UI and UX

## [x] UI-001 — Add a unified Needs Attention inbox

Derived sources:

- permission requests;
- questions;
- blocked goals;
- prompt-admission failure;
- disconnected active sessions;
- failed worktree/run creation;
- native supplemental actions when native mode exists.

Selecting an item must focus the exact session and card.

## [x] UI-002 — Replace protocol jargon with behavioral queue semantics

### Busy-session composer

Primary actions:

```text
Steer current work
Follow up after completion
Replace queued instruction
```

Display queued items with delivery mode, ordering, edit, remove, and send-now behavior.

### Race rule

The selected behavior at click time must be preserved even if the session becomes idle before host admission. The host returns the authoritative admission result.

## [x] UI-003 — Add outgoing Context ledger and per-message receipts

### Context categories

- current selection;
- unsaved buffer revision;
- explicit file/resource;
- diagnostics;
- terminal/task excerpt;
- notebook context;
- debug state;
- MCP resource;
- approved URL;
- image/PDF/paste attachment.

### Receipt fields

```ts
interface ContextReceipt {
  id: string;
  sessionID: string;
  promptID: string;
  admittedAt: number;
  items: ContextReceiptItem[];
  estimatedTokens?: number;
  truncation: "none" | "explicit" | "unknown";
}
```

Persist only bounded metadata, hashes/revisions, labels, ranges, and sizes. Do not persist sensitive payloads.

### UX

- Before send: exact ledger.
- After send: “Sent with N context items” receipt attached to the user turn.

## [x] UI-004 — Add a persistent OpenCode inspector

Tabs:

```text
Activity
Changes
Context
Goal
Runs
Walkthrough
```

In native mode, show only OpenCode-specific/supplemental content and link to native generic surfaces.

In stable mode, Changes and Activity may include generic content.

## [x] UI-005 — Add prompt/turn navigation for long sessions

Semantic markers only:

- user turn;
- goal continuation;
- permission/question;
- failure;
- checkpoint/fork;
- current turn.

Maintain visual scroll anchors while loading older history.

## [x] UI-006 — Add Plan-first workflow and handoff

### Entry points

```text
OpenCode: Plan Task
New Session → Plan first
Agent picker → Plan
```

### Workflow

1. Start/read-only OpenCode Plan agent session.
2. Generate a structured plan artifact.
3. Let the user edit/comment/revise.
4. Handoff to:
   - implementation session;
   - isolated worktree session;
   - Multi-run;
   - active goal.
5. Preserve a reference to the approved plan without duplicating the full transcript.

### Storage

Default to a virtual/untitled Markdown document. Save to the repository only through an explicit user action.

## [ ] UI-007 — Complete accessibility and interaction regression pass

Required:

- semantic tree/list roles;
- roving tabindex;
- focus-visible actions;
- no hover-only controls;
- dialog focus trap and restoration;
- non-disruptive live regions;
- explicit status announcements;
- configurable Enter behavior;
- reduced motion;
- high contrast;
- keyboard-only coverage;
- screen-reader smoke test.

Implementation and automated interaction coverage are complete. The required
platform screen-reader smoke remains a release-validation step because no
NVDA, VoiceOver, or Orca session is available in the headless test environment.

## [x] UI-008 — Decide whether a custom Work tree remains necessary

This issue occurs **after ADR-001**.

### If native integration is viable

- Do not build a competing generic Work tree.
- Use native session lists.
- Build only RunGroup and OpenCode-detail navigation.

### If native integration is deferred

Implement the progressive custom hierarchy from plan v1:

```text
Task/run group
├── current checkout session
├── worktree session
├── model-run sessions
└── review session
```

Keep simple sessions visually simple through progressive disclosure.

---

# 8. Phase N — experimental native Agent Host integration

This phase is skipped when ADR-001 selects `defer-native`.

Completion result: ADR 0003 selected `defer-native`, so NAT-001–010 reached
their plan-defined terminal state without shipping a second session authority or
depending on proposed VS Code APIs.

## [x] NAT-001 — Add an experimental ACP process manager

Responsibilities:

- resolve and validate OpenCode executable/version;
- launch `opencode acp` with `shell: false`;
- set cwd and controlled environment;
- frame JSON-RPC correctly;
- enforce message limits;
- correlate requests;
- cancel and terminate safely;
- redact logs;
- restart only according to explicit policy;
- expose process health.

Do not yet connect to AHP.

## [x] NAT-002 — Implement OpenCode ACP adapter and conformance fixtures

Map actual ACP behavior into canonical lifecycle types.

Acceptance:

- no invented capability;
- unknown messages are bounded and logged safely;
- prompt admission is distinct from run completion;
- cancellation is deterministic;
- settlement is computed safely;
- companion-plugin visibility is tested.

## [x] NAT-003 — Implement a minimal AHP host bridge

Initial scope:

- initialize/root state;
- create one session;
- create one chat;
- start/cancel one turn;
- stream text/activity;
- reconnect one client;
- connect a second client;
- no worktrees or advanced permissions yet.

Acceptance:

- server sequence ordering;
- snapshot/replay;
- write-ahead reconciliation behavior;
- no duplicate turn start;
- session survives client disconnect where host contract allows.

## [x] NAT-004 — Map permissions and durable user input losslessly

### Permission mapping

Advertise supported decisions explicitly:

```text
allow once
allow exact
allow scope
reject
reject with feedback
policy amendment
```

### User input

Map OpenCode questions to AHP elicitation/durable input state where possible.

### Stop condition

If exact OpenCode choices cannot be represented or supplemented without ambiguity, native mode remains disabled for permission-bearing sessions.

## [x] NAT-005 — Map client tools and editor context without double assembly

Determine:

- which VS Code tools can be contributed to Agent Host;
- how those tools reach ACP/OpenCode;
- whether the companion bridge remains necessary;
- how editor context is requested and accounted for;
- how context receipts are generated;
- how unsupported interactive tools degrade.

Never combine VS Code’s own model prompt assembly with OpenCode’s agent prompt.

## [x] NAT-006 — Map changesets, terminals, roots, and worktrees

Prove ownership for:

- file changes;
- diff snapshots;
- terminal executions;
- working directory;
- worktree creation/recovery/removal;
- branch identity;
- dirty-state protection.

Exactly one owner creates/removes worktrees.

## [x] NAT-007 — Map session resume, fork, queue, and settlement

Acceptance:

- OpenCode session IDs remain recoverable;
- fork parentage is preserved;
- steering and follow-up are not collapsed;
- visible turn completion does not imply settlement;
- reconnect does not duplicate queued input;
- stale process generations cannot mutate current state.

## [x] NAT-008 — Add supplemental OpenCode Details view and native navigation

Show:

- exact context ledger;
- goal/verifier;
- preferences;
- skill candidates;
- run group/comparison;
- walkthrough;
- runtime health.

Link to native sessions only through public/proven navigation APIs.

## [x] NAT-009 — Add version gates, fallback, and user-facing experimental controls

Suggested setting during preview:

```text
opencodeWorkbench.experimental.nativeAgentHost = false
```

Behavior:

- default off;
- no stable-mode regression;
- show exact unsupported reason;
- one-click return to stable mode;
- never attach one session to two authorities;
- no automatic VS Code minimum increase.

## [x] NAT-010 — Add AHP/ACP compatibility and soak tests

Test:

- version mismatch;
- malformed messages;
- two clients;
- reconnect and replay;
- permission race;
- cancellation race;
- process crash;
- session restore;
- long token streams;
- 20,000-event load;
- hidden/disconnected clients;
- worktree dirty state;
- extension tool disappearance when editor closes.

---

# 9. Phase 3 — worktrees, Multi-run, and comparison

## [x] WT-001 — Select and enforce the single worktree owner

Decision derived from ADR/NAT results:

```text
native Agent Host owner
OR
Workbench fallback owner
```

Record in session metadata. Reject conflicting operations.

## [x] WT-002A — Native worktree-backed session integration

Only when native owner is selected.

Completion result: skipped under ADR 0003 because Workbench fallback ownership
was selected; no native-owned worktree lifecycle exists to integrate.

Workbench responsibilities:

- request/select isolation through supported native contracts;
- store only references needed for run groups and OpenCode details;
- validate the directory reported to OpenCode;
- surface native cleanup state;
- never directly delete native-owned worktrees.

## [x] WT-002B — Fallback typed Git service and durable journal

Only when Workbench owner is selected.

Use the detailed plan-v1 design:

- typed `git` arguments with `shell: false`;
- canonical repository identity;
- worktree operation journal;
- phases from requested through prompt-admitted;
- recovery against filesystem and `git worktree list --porcelain`;
- safe cleanup;
- dirty worktree protection;
- separate session, worktree, and branch deletion actions.

## [x] WT-003 — Add worktree-backed session creation

User entry points:

```text
New isolated session
Compare models
Plan → implement in worktree
Issue/PR → isolated session
```

Prompt admission waits for:

```text
worktree ready
→ optional explicit setup task complete
→ OpenCode session ready
→ prompt admitted
```

## [x] MR-001 — Add transport-independent RunGroup metadata

```ts
interface RunGroup {
  id: string;
  title: string;
  repository: string;
  baseRef: string;
  promptReceiptID: string;
  isolation: "shared" | "worktree";
  createdAt: number;
  runs: RunReference[];
}

interface RunReference {
  id: string;
  model: string;
  agent?: string;
  variant?: string;
  session: SessionLocator;
  worktreeID?: string;
  phase:
    | "pending"
    | "preparing"
    | "admitting"
    | "working"
    | "needs-input"
    | "completed"
    | "failed"
    | "cancelled";
  error?: StructuredError;
}
```

Persist no prompt bytes or transcript copies.

## [x] MR-002 — Implement Multi-run orchestrator

Initial scope:

- same prompt/attachments/context receipt;
- two to five model/agent selections;
- separate session per run;
- separate worktree by default;
- partial failure isolation;
- stable mutation ID;
- explicit per-run retry;
- no automatic merge.

## [x] MR-003 — Integrate run groups into the selected UI mode

### Native mode

- individual runs appear as native sessions;
- Workbench Runs panel groups and links them;
- no duplicate generic session tree.

### Stable mode

- show progressive run-group hierarchy in the custom session/work tree.

## [x] MR-004 — Add objective run comparison

Display:

```text
Run
Status
Model/agent/variant
Elapsed time
Changed files
Diff stats
Task outcomes
Diagnostics
Goal/verifier state
Token/cost where reliable
Blocker/error
```

Actions:

```text
Open session
Open worktree
Open native diff
Compare against base
Keep result
Discard run safely
Start review
Create synthesis session
```

No AI winner in the initial release.

## [x] MR-005 — Complete cancellation, recovery, and cleanup semantics

Cover:

- one run fails while others continue;
- one run needs permission;
- group cancellation;
- individual cancellation;
- VS Code restart;
- OpenCode process restart;
- partially created worktree;
- duplicate launch retry;
- dirty result cleanup;
- stale run-group references.

---

# 10. Phase 4 — changes, review, and walkthrough

## [x] REV-001 — Add exact diff identity per turn and session

### Scopes

- turn;
- uncommitted session/worktree;
- staged;
- unstaged;
- branch delta;
- pull-request delta where native integration supplies it.

### Model

```ts
interface DiffSnapshot {
  id: string;
  scope: DiffScope;
  repository: string;
  baseRef?: string;
  headRef?: string;
  unifiedDiffHash: string;
  files: DiffFileSummary[];
  generatedAt: number;
  complete: boolean;
  truncationReason?: string;
}
```

Never mark an incomplete diff as complete.

## [x] REV-002 — Add aggregated per-turn change events

Inspired by Codex turn-level diff updates:

- emit latest complete turn diff snapshot after file changes;
- associate changed-file chips with the exact turn;
- keep session/worktree diff separate;
- recover by recomputing from Git when event history is incomplete.

## [x] REV-003 — Implement Changes Walkthrough generator

Use OpenCode through a normal bounded session/agent path.

Output:

```ts
interface WalkthroughDocument {
  id: string;
  diffHash: string;
  model: string;
  generatedAt: number;
  stops: WalkthroughStop[];
}

interface WalkthroughStop {
  id: string;
  title: string;
  explanation: string;
  importance: "key-change" | "normal" | "context";
  anchors: DiffAnchor[];
}
```

Validation:

- every anchor resolves to the exact diff;
- unknown files/hunks reject generation;
- oversized input fails clearly or uses an explicit chunk/coverage strategy;
- no silent truncation;
- cached by exact diff hash, model, prompt version, and language.

## [x] REV-004 — Add native VS Code walkthrough navigation

Selecting a stop opens the native diff editor at the relevant hunk/range.

Show:

- ordered stops;
- key changes;
- supporting context;
- stale/uncovered markers after the diff changes;
- regenerate action;
- separate “Review” action.

## [x] REV-005 — Add deterministic evidence summaries

Evidence sources:

- VS Code task exit code;
- terminal command result where attributable;
- test result where it is attributable and exposed by the stable API; otherwise
  the corresponding test-group task exit;
- workspace diagnostics delta;
- Git diff/file count;
- OpenCode todos;
- verifier criteria.

The model’s claim is never the authoritative evidence.

## [x] REV-006 — Add separate code-review workflow

Review differs from Walkthrough:

- correctness;
- security;
- performance;
- maintainability;
- tests;
- behavior regression.

Review findings link to exact diff anchors and remain clearly labeled as model findings rather than deterministic facts.

---

# 11. Phase 5 — goals and verifier

## [x] GOAL-001 — Migrate goal state to schema v2

Add:

- explicit acceptance criteria;
- verifier configuration;
- evidence references;
- latest verdict;
- repeated-block threshold;
- pending-continuation state;
- settlement generation;
- plan reference;
- run-group reference where relevant.

Provide atomic migration from schema v1.

## [x] GOAL-002 — Add independent verifier lifecycle

Verifier input:

- objective;
- acceptance criteria;
- latest assistant result;
- deterministic evidence;
- changed-file/diff summary;
- current diagnostics;
- recorded checkpoints/progress;
- remaining limits.

Output:

```ts
interface GoalVerdict {
  verdict: "continue" | "complete" | "blocked" | "needs-user";
  reason: string;
  missingCriteria: string[];
  confidence: "low" | "medium" | "high";
}
```

Rules:

- verifier runs through OpenCode;
- no mutation tools;
- no auto-approval;
- bounded input and output;
- no provider SDK;
- repeated blocked verdicts before final block;
- fallback to current self-verification when independent mode is unavailable;
- verifier completion does not imply session settlement until continuation decisions commit.

## [x] GOAL-003 — Integrate deterministic evidence

Criteria may reference:

- named tasks/tests;
- diagnostics threshold;
- expected files/API docs;
- diff conditions;
- explicit user approval.

Report unsupported criteria rather than pretending to verify them.

## [x] GOAL-004 — Add goal configuration and inspector UX

Composer target action and `/goal` remain available.

Configuration:

```text
Objective
Acceptance criteria
Auto-turn limit
Token limit
Duration limit
Verifier model/agent
Repeated-block threshold
```

Inspector:

- status;
- progress;
- criteria and evidence;
- latest verdict;
- limits;
- pause/resume/edit/cancel;
- needs-user reason.

---

# 12. Phase 6 — native integrations and optional features

## [x] INT-001 — Add native GitHub issue/PR handoff

Rules:

- use VS Code/GitHub extension surfaces;
- no duplicate OAuth/token store;
- feature-detect commands/extensions;
- pass issue/PR context explicitly;
- offer isolated session by default for implementation;
- open native diff and PR surfaces.

## [x] INT-002 — Add narrow Chat Participant handoff only if useful

Optional scope:

```text
@opencode continue this task
@opencode open current OpenCode session
```

It may hand off context into a real OpenCode session. It must not run a second model loop or impersonate a complete OpenCode transcript inside a participant.

## [x] INT-003 — Evaluate limited browser-context capture

Use existing VS Code browser/debug tooling only.

Possible actions:

- attach selected console output;
- attach inspected element metadata;
- attach screenshot through explicit user action.

Do not build a browser proxy or navigation stack.

## [x] FUS-001 — Add Fusion only after comparison is mature

Safe design:

1. create a new isolated worktree/session;
2. attach structured run summaries, diff manifests, evidence, and source-session links;
3. let the synthesis session inspect actual worktrees;
4. preserve provenance;
5. support modes:
   - synthesize implementation plan;
   - build combined implementation;
   - review and choose approach.

Do not automatically merge source branches.

---

# 13. Testing and evaluation plan

## 13.1 Existing gates to preserve

```sh
deno task check
deno task test:synthetic
deno task test:integration:synthetic
deno task test:stress
deno task package
```

Run the provider-free real OpenCode integration suite when runtime contracts change.

## 13.2 Protocol tests

- version negotiation;
- capability gating;
- malformed/oversized messages;
- correlation;
- cancellation;
- duplicate mutation ID;
- structured errors;
- overload;
- snapshot/replay/gap recovery;
- epoch replacement;
- validator/type/fixture parity.

## 13.3 Lifecycle tests

- accepted versus completed;
- steer versus follow-up;
- replace queued;
- abort with queued restoration;
- permission/question wait;
- goal immediate continuation;
- compaction/retry continuation;
- turn complete but not settled;
- stale generation settlement;
- session switch/dispose.

## 13.4 ACP conformance tests

- pinned fixture replay;
- current executable compatibility;
- capability matrix drift;
- process crash/malformed line;
- multi-process directories;
- plugin discovery;
- permission/question/cancel.

## 13.5 AHP tests

When enabled:

- initial snapshot;
- two clients;
- ordered action broadcast;
- write-ahead reconciliation;
- reconnect replay/fresh snapshot;
- turn ownership;
- first-confirmation-wins permission race;
- cancellation from another client;
- capability/version mismatch;
- client tool disappearance.

## 13.6 Bridge security tests

- token/affinity mismatch;
- unauthorized root;
- symlink/path traversal;
- stale registry entry;
- multiple roots;
- size bounds;
- malformed request;
- no arbitrary command IDs or shell strings.

## 13.7 Worktree tests

- path/branch validation;
- create/setup/session/prompt phase order;
- crash after every phase;
- duplicate mutation retry;
- dirty cleanup denial;
- branch/worktree/session deletion independence;
- native/custom owner conflict;
- no cross-worktree bridge access.

## 13.8 Multi-run tests

- partial launch failure;
- independent permissions;
- one failed run does not cancel others;
- group/individual cancel;
- restart recovery;
- exact context receipt reuse;
- objective comparison truthfulness;
- cleanup safety.

## 13.9 UI tests

- sidebar/editor synchronization;
- stream scroll anchoring;
- old-history prepend anchoring;
- focus restoration;
- queue race;
- attention navigation;
- context receipt privacy;
- inspector stale-request cancellation;
- keyboard-only interaction;
- screen-reader status announcements.

## 13.10 Review/goal tests

- exact diff hash;
- stale walkthrough;
- invalid anchor rejection;
- oversize behavior;
- task evidence accuracy;
- verifier schema validation;
- no verifier tools;
- repeated block;
- completion criteria traceability;
- goal continuation settlement.

## 13.11 Harness UX scenario suite

Create scripted scenarios independent of model quality:

1. User sends while idle; prompt is admitted exactly once.
2. User steers during tools; message is delivered at the correct boundary.
3. User queues follow-up; it waits until the agent would stop.
4. Permission appears before execution and offers exact valid choices.
5. Question response survives webview reload.
6. Session disconnects and reconciles without duplicate content.
7. Goal continues automatically but session is not marked settled early.
8. Worktree session cannot edit the root checkout through the bridge.
9. Multi-run produces independent results.
10. Diff/evidence matches actual repository and task state.

---

# 14. Security and privacy checklist

Every PR must answer applicable items:

- Is OpenCode still authoritative?
- Is a new persistent store being added?
- Does it contain prompt content, file content, secrets, or credentials?
- Are paths canonicalized and contained?
- Can symlinks escape the authorized root?
- Can arbitrary shell strings or command IDs cross the boundary?
- Are request/event sizes bounded?
- Are queues bounded?
- Are logs sanitized?
- Are capability claims proven?
- Are permission choices mapped exactly?
- Can an old epoch mutate current state?
- Can retry duplicate a mutation?
- Can two authorities control one session/worktree?
- Can cleanup remove dirty work?
- Does native mode require proposed/private APIs?
- Is stable mode unaffected when experimental code fails?
- Does any extension/plugin execute with broad user privileges?
- Is workspace trust enforced?

---

# 15. Risk register and stop conditions

| Risk | Mitigation / stop condition |
|---|---|
| AHP third-party registration is not public/stable | Select `defer-native`; continue stable-mode roadmap |
| ACP omits exact permission/queue/session behavior | Keep HTTP/SSE for those features; disable incompatible native mode |
| Dual session authority causes duplicate turns | Enforce one authority per session locator |
| Native and custom worktree managers conflict | Persist and enforce one worktree owner |
| Protocol refactor destabilizes current UI | Mechanical extraction first; v1 adapter; full regression gates |
| Event streams overwhelm webviews | Bounded queues, coalescing, overload, sequence gaps/resync |
| Context receipt leaks content | Metadata-only persistence and sanitization tests |
| Verifier becomes another agent loop | Run through OpenCode, no provider SDK, no tools |
| Walkthrough invents anchors | Exact diff hash and anchor validation |
| Checkpoint claims exceed coverage | Use Git/worktrees; label coverage honestly |
| Proposed VS Code APIs break Marketplace | Keep experimental code isolated and stable mode independent |
| Minimum VS Code rises too quickly | Feature/version gate; do not raise engine for prototype |
| Harness abstraction becomes universal-agent scope | Support only OpenCode adapters; reject Codex/Claude/Pi adapters |

---

# 16. Program-level definition of done

The program is complete when:

- protocol v2 and lifecycle semantics are deployed without regression;
- prompt admission, turn completion, and settlement are distinct and tested;
- controller and webview domains are maintainable;
- context admission is visible through exact receipts;
- attention, queue behavior, plan handoff, and inspector UX are coherent;
- worktree ownership is singular and crash-recoverable;
- Multi-run and objective comparison are reliable;
- Walkthrough is exact-diff anchored;
- goal verification is independent, bounded, and evidence-aware;
- native mode is either shipped behind proven gates or explicitly deferred by ADR;
- stable Workbench mode remains fully functional;
- no provider SDK, duplicate loop, transcript database, custom terminal/browser, or unsafe generic hook platform was introduced;
- all deterministic, integration, stress, packaging, security, and compatibility tests pass.

---

# 17. Ordered backlog

Execute in this order unless an ADR changes dependencies:

1. DISC-001 — current invariants and harness capability matrix
2. ACP-001 — OpenCode ACP contract recorder
3. AHP-001 — VS Code custom Agent Host feasibility
4. MAP-001 — lossless mapping specification
5. VER-001 — verifier execution path
6. ADR-001 — native strategy decision
7. FND-001 — lifecycle and settlement types
8. FND-002 — protocol v2 envelopes/capabilities
9. FND-003 — schema and generated verification
10. FND-004 — host router/cancellation/idempotency/overload
11. FND-005 — epoch/sequence/snapshot/resync
12. FND-006 — controller decomposition
13. FND-007 — webview decomposition
14. FND-008 — Health Center and trace
15. UI-001 — Needs Attention inbox
16. UI-002 — steer/follow-up UX
17. UI-003 — context ledger and receipts
18. UI-004 — inspector
19. UI-005 — long-session navigation
20. UI-006 — Plan-first and handoff
21. UI-007 — accessibility pass
22. UI-008 — custom Work tree decision/implementation
23. NAT-001 through NAT-010 — only if ADR permits; run as an experimental parallel track
24. WT-001 — single worktree owner
25. WT-002A or WT-002B — selected implementation
26. WT-003 — worktree-backed session creation
27. MR-001 — RunGroup metadata
28. MR-002 — Multi-run orchestrator
29. MR-003 — mode-specific UI integration
30. MR-004 — objective comparison
31. MR-005 — failure/cancel/recovery/cleanup
32. REV-001 — exact diff identity
33. REV-002 — per-turn change snapshots
34. REV-003 — walkthrough generator
35. REV-004 — native walkthrough UX
36. REV-005 — deterministic evidence
37. REV-006 — separate review workflow
38. GOAL-001 — goal schema v2
39. GOAL-002 — independent verifier
40. GOAL-003 — evidence integration
41. GOAL-004 — goal UX
42. INT-001 — GitHub handoff
43. INT-002 — optional narrow Chat Participant handoff
44. INT-003 — limited browser context
45. FUS-001 — optional Fusion

---

# 18. Issue completion report template

```text
Issue:
Status: complete | partial | blocked

Summary:

Files added:
Files modified:
Files removed:

Behavior before:
Behavior after:

External contracts proven:
Capabilities added/removed:
Compatibility impact:
Security impact:
Persistence/privacy impact:

Tests added:
Commands run:
Exact results:

Documentation/ADR updated:
Known verified limitations:
Blocking discoveries:
Next dependency-ready issue:
```
