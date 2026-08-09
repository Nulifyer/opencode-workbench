# OpenCode Workbench — Coding Harness and VS Code Platform Review

- **Review date:** 2026-08-07
- **Workbench baseline:** `Nulifyer/opencode-workbench` `main`, extension `0.4.6`
- **Compared systems:** OpenCode, OpenAI Codex, Claude Code, Pi, OpenChamber, and the built-in VS Code Chat/Agents platform

## 1. Executive conclusion

The earlier OpenChamber review remains directionally correct, but the broader harness review changes one major architectural recommendation:

> Do not assume that Workbench should permanently own a complete parallel session, worktree, chat, and changes shell inside VS Code.

VS Code 1.130–1.131 now has a dedicated **Agent Host**, a shared **Agent Host Protocol (AHP)**, a built-in sessions list, an Agents window, worktree-aware sessions, multi-chat sessions, changesets, native diff review, remote sessions, and adapters for multiple agent harnesses. OpenCode now exposes an official **ACP** endpoint through `opencode acp`.

Those two developments create a plausible future path:

```text
VS Code Chat / Agents window
            │
            │ AHP
            ▼
OpenCode AHP bridge or adapter
            │
            │ ACP
            ▼
      opencode acp
            │
            ▼
 OpenCode runtime, tools, agents,
 permissions, config, and sessions
```

That path is not yet safe to adopt as the only architecture:

- AHP and the Agent Host are still under active development.
- The stable third-party harness registration path is not clearly documented.
- The VS Code sessions-provider API remains proposed.
- It is not yet proven that every OpenCode behavior maps losslessly through ACP and AHP.
- Workbench still supports VS Code `1.106`, while the relevant native platform is current-generation VS Code.

The initial review recommendation was **hybrid and capability-gated**, subject
to the spikes below. ADR 0003 later recorded the proven outcome as
`defer-native`; stable Workbench is therefore the only shipped mode:

1. Keep the existing Workbench webview experience as the stable OpenCode-native client.
2. Add a discovery and prototype track for `OpenCode ACP → AHP → native VS Code Chat/Agents`.
3. If the native path proves complete enough, use VS Code for generic sessions, chat, worktrees, changes, and attention handling.
4. Keep Workbench-specific UI for capabilities VS Code does not provide precisely enough:
   - exact editor-context ledger and per-message receipts;
   - OpenCode goals and independent verification;
   - approved preferences and staged skill candidates;
   - Multi-run grouping and cross-run comparison;
   - Changes Walkthrough;
   - exact OpenCode permission scope;
   - runtime health and capability diagnostics.
5. Do not turn Workbench into a universal frontend for Codex, Claude, Pi, and OpenCode. Those harnesses are design references, not additional supported runtimes.

## 2. Product position

The target product should be described as:

> **The OpenCode-native harness and control plane for VS Code.**

Workbench should remain responsible for the integration layer between OpenCode and VS Code, not for replacing either product.

It should preserve these ownership boundaries:

| Concern | Authority |
|---|---|
| Models, providers, agents, tools, sessions, messages, permissions, questions | OpenCode |
| Goal persistence and continuation, approved preferences, staged skill candidates | Workbench companion OpenCode plugin |
| Editor state, diffs, SCM, tasks, terminals, diagnostics, workspace trust | VS Code |
| Run groups, comparison metadata, context receipts, walkthrough cache, UI layout | Workbench |
| Generic native session synchronization in native mode | VS Code Agent Host/AHP |
| Generic custom webview synchronization in fallback mode | Workbench extension host |

## 3. Comparative summary

| System | Runtime boundary | Protocol/session shape | Strongest lesson for Workbench | Primary caution |
|---|---|---|---|---|
| **OpenCode** | Server/CLI owns the harness | HTTP/OpenAPI + SSE; generated SDK; ACP subprocess | Keep OpenCode authoritative; use ACP as the native editor bridge candidate | ACP feature parity must be proven, not inferred from a broad documentation claim |
| **Codex** | App server owns agent state | Typed bidirectional JSON-RPC; Thread → Turn → Item | Versioned handshake, generated schemas, correlated requests, item lifecycles, structured approvals, backpressure | Do not force OpenCode data into Codex-specific semantics |
| **Claude Code** | CLI/SDK owns sessions and tools | Persistent sessions, resume/fork, worktrees, checkpoints, hooks, layered permissions | Permission precedence, honest checkpoints, plan/review UX, worktree isolation | Hooks can run with full user privileges; checkpoints do not cover every filesystem change |
| **Pi** | Minimal CLI/SDK/RPC harness | JSONL RPC; session tree; steering and follow-up queues | Separate prompt admission from completion; separate turn end from settled state; session-tree branching | Core intentionally omits permissions and other safety systems; extensions have broad process access |
| **VS Code Agent Host** | Dedicated host owns shared sessions | AHP JSON-RPC; immutable snapshots + ordered actions + reconciliation | Native shared sessions, worktrees, changesets, multi-client sync, remote/independent execution | Platform is still moving; public third-party harness registration is not yet a stable contract |
| **VS Code Chat extension APIs** | VS Code harness owns loop unless using a full agent-host path | Chat participants, tools, models, proposed session provider | Use native context menus, tools, diffs, SCM, and supplemental views | Chat Participant and model-provider APIs are the wrong layer for preserving OpenCode’s agent loop |
| **OpenChamber** | Application/server wraps OpenCode | Cross-platform application state and workflows | Multi-run, task/run organization, walkthroughs, verifier UX | Its broad desktop/web/mobile/remote scope should not be copied |

## 4. OpenCode review

### 4.1 Runtime architecture

OpenCode is already a client/server harness. `opencode serve` exposes a headless HTTP API and event stream, while the terminal UI is another client of the same runtime. This is exactly why Workbench’s current architecture is sound: the extension can remain a UI and editor-integration client rather than creating a competing agent loop.

The generated OpenCode SDK and server contracts should remain the canonical source for:

- session creation, listing, selection, fork, deletion, and history;
- messages and parts;
- agents, providers, models, and variants;
- tool activity;
- permission and question requests;
- session status;
- queue, steer, replace, and abort behavior where supported;
- diffs and runtime services.

### 4.2 OpenCode ACP

OpenCode now documents `opencode acp`, which starts an ACP-compatible subprocess using JSON-RPC over stdio. The documentation says that tools, custom tools, slash commands, MCP, project rules, formatters, linters, agents, and permissions are supported; `/undo` and `/redo` are named exceptions.

This is strategically important because ACP is the right layer for connecting an external coding harness to an editor. It is a better candidate than:

- wrapping the terminal UI;
- making OpenCode a VS Code language-model provider;
- implementing OpenCode as a Chat Participant;
- translating OpenCode into VS Code’s own model/tool loop.

However, the project must verify the following before relying on ACP:

1. Does ACP expose existing OpenCode sessions or only subprocess-local sessions?
2. Can sessions be resumed and forked?
3. Are custom OpenCode agents and model variants selectable?
4. Are exact permission choices preserved, including once, exact pattern, broader scope, and reject-with-feedback?
5. Are questions represented as durable user-input requests?
6. Are queue, steer, follow-up, replace, and abort represented distinctly?
7. Are token usage, cost, todos, reasoning, diffs, and tool metadata exposed?
8. What is the lifecycle after the visible assistant response ends but a goal continuation, retry, compaction, or queued instruction remains?
9. What happens on process crash, client disconnect, and reconnection?
10. Can VS Code-contributed tools or editor context be made available without double-injecting context?
11. Does the companion plugin load and retain exact bridge affinity in ACP mode?
12. Are preferences, goals, and skill-candidate tools discoverable and usable?

### 4.3 What Workbench should preserve from OpenCode

- OpenCode’s provider and model catalog remains the only catalog.
- OpenCode’s permission system remains authoritative.
- OpenCode’s agents and configuration are not translated into a competing Workbench format.
- OpenCode session IDs remain canonical.
- Workbench metadata references OpenCode sessions; it does not clone transcript content into another database.
- The existing HTTP/SSE path remains supported even if ACP is added.
- External-server mode remains a first-class capability.

### 4.4 What Workbench should add around OpenCode

- A transport capability model that describes what the connected OpenCode mode can actually do.
- Provider-free ACP contract tests.
- A canonical session/turn/item projection for UI purposes without replacing OpenCode’s native message/part schema.
- Exact prompt-admission results.
- A settled-state barrier.
- Better diff identity and deterministic evidence.
- Native AHP integration only after a lossless mapping has been demonstrated.

## 5. Codex review

### 5.1 Protocol design

The Codex app server is the strongest protocol reference in this review. It uses bidirectional JSON-RPC with:

- an `initialize`/`initialized` handshake;
- correlated requests and responses;
- server-initiated requests for approval and client tools;
- generated TypeScript and JSON Schema artifacts tied to the running Codex version;
- bounded queues and an explicit retryable overload error;
- structured lifecycle notifications;
- explicit cancellation;
- structured failures.

Its core domain model is:

```text
Thread
└── Turn
    ├── User input
    ├── Reasoning item
    ├── Command item
    ├── File-change item
    ├── Tool item
    └── Agent message item
```

The per-item lifecycle is explicit:

```text
item/started
→ zero or more item-specific updates
→ item/completed
```

The turn lifecycle is similarly explicit:

```text
turn/start accepted
→ turn/started
→ streamed item events
→ turn/completed | interrupted | failed
```

Codex also emits an aggregated turn-level diff snapshot after file changes. That avoids forcing every UI to reconstruct a complete diff from isolated edit events.

### 5.2 What Workbench should copy

#### Versioned initialization

Every webview or native adapter connection should negotiate:

- protocol version;
- Workbench version;
- OpenCode version;
- experience mode;
- transport mode;
- capabilities;
- event epoch;
- limits.

#### Correlated bidirectional requests

Permissions, questions, cancellation, tool requests, and long-running operations should all have stable request IDs and structured responses.

#### Generated or mechanically verified schemas

Workbench should stop allowing protocol types, validators, and fixtures to drift independently. It does not need to adopt Codex’s code generator, but it should establish one source of truth and generate or mechanically verify:

- TypeScript types;
- runtime validators;
- JSON examples/fixtures;
- version compatibility tests.

#### Backpressure

The current event stress tests are a strong start. Protocol v2 should also define:

- bounded request queues;
- retryable overload errors;
- coalescing rules for token deltas and status updates;
- maximum snapshot size;
- maximum pending correlated requests;
- cancellation cleanup.

#### Aggregated diff snapshots

Workbench should expose an exact, hashed diff snapshot per turn and per session/worktree rather than making the UI infer change state from tool events.

### 5.3 What Workbench should not copy

- Do not rename OpenCode sessions to threads internally merely to resemble Codex.
- Do not require every OpenCode message part to fit a Codex item type.
- Do not add Codex authentication or provider semantics.
- Do not make the Workbench webview the protocol authority.

The lesson is protocol discipline, not domain imitation.

## 6. Claude Code review

### 6.1 Sessions, worktrees, and forks

Claude Code treats a session as durable conversation state and supports continuation, explicit resume, and fork. It also provides first-class worktree execution so parallel sessions do not modify the same checkout.

The useful product lesson is that session identity and filesystem isolation are related but separate:

```text
Conversation/session identity
≠
Filesystem/worktree identity
```

Workbench should represent both explicitly. A fork may share history but use a new branch/worktree. A new chat may share a worktree while maintaining a different context window.

### 6.2 Permission precedence

Claude Code documents a clear layered permission evaluation order. Deny rules take precedence over ask and allow behavior; hooks cannot silently override a deny rule. This is a strong safety model for any future Workbench policy layer.

Workbench should preserve this general invariant:

```text
hard deny
> explicit ask
> scoped allow
> session convenience mode
```

Workbench must not flatten OpenCode permission detail into generic “Allow” and “Deny” choices if the underlying request contains more exact semantics.

### 6.3 Checkpoints

Claude Code checkpointing is useful because it is honest about its limitations: it tracks edits made through its edit tools, but not arbitrary shell-command changes, external edits, or all concurrent activity. It explicitly says checkpoints complement Git rather than replace it.

That is the standard Workbench should follow. Do not advertise “restore session changes” unless the implementation can prove which changes are covered. For parallel autonomous work, worktrees and Git remain the stronger isolation and recovery mechanism.

### 6.4 Plans and review

Claude’s editor experience emphasizes:

- plan review before implementation;
- inline diffs;
- selection context;
- session history;
- resume and fork;
- clear permission controls.

Workbench should make OpenCode’s Plan agent more discoverable through a first-class “Plan first” command and a plan-to-implementation handoff, rather than treating Plan as only another name in an agent picker.

### 6.5 Hooks

Claude’s hooks demonstrate the value of deterministic lifecycle policy, but also the danger: command hooks run with the user’s full permissions.

Workbench should not add a generic shell-hook platform. Existing OpenCode plugins, MCP, VS Code tasks, and explicit Workbench companion tools are enough. Any deterministic verifier or policy hook should be typed, bounded, and purpose-specific.

## 7. Pi review

### 7.1 Minimal-core philosophy

Pi intentionally keeps the core small and lets users extend it through TypeScript extensions, skills, templates, themes, packages, RPC, and SDK embedding. This validates Workbench’s decision not to recreate the model loop.

The right lesson is:

> Keep the Workbench core focused on integration, state projection, and safety. Add workflows as composable services, not as hidden prompt behavior.

### 7.2 Prompt admission versus run completion

Pi’s SDK distinguishes prompt preflight acceptance from completion of the accepted run. That distinction should be explicit in Workbench.

A `send` request should resolve when OpenCode has authoritatively done one of the following:

```text
accepted and started
accepted and queued as steering
accepted and queued as follow-up
accepted and replaced a queued prompt
rejected before admission
```

It should not remain pending until the entire agent run ends. Later events report progress and final outcome.

### 7.3 Steering versus follow-up

Pi has user-facing semantics that are clearer than exposing protocol labels alone:

- **Steer current work:** deliver after the current assistant tool calls, before the next model step.
- **Follow up after completion:** wait until the agent would otherwise stop.

Workbench currently exposes queue/steer/replace behavior. The UX should use behavioral language and display exactly where each queued item will be delivered.

### 7.4 Turn end versus settled state

Pi’s work around `agent_settled` highlights a subtle but important invariant:

A visible assistant turn can end while the session is not truly idle because any of the following may still happen:

- queued steering;
- queued follow-up;
- retry;
- compaction continuation;
- goal continuation;
- post-run handler;
- session transition;
- delayed asynchronous re-entry.

Workbench needs two distinct events:

```text
turnCompleted
sessionSettled
```

`sessionSettled` should mean:

- no stream is active;
- no tool call is executing;
- no permission or question is unresolved;
- no admitted queue item can immediately start another turn;
- no internal retry or compaction continuation is pending;
- no goal continuation has been admitted but not started;
- the session generation/epoch still matches;
- mutation-sensitive operations such as cleanup or branch transition are safe.

### 7.5 Session tree

Pi stores entries with `id` and `parentId`, allowing in-place branching and navigation. Workbench already supports message-scoped fork actions; it should preserve parentage explicitly and expose a concise branch breadcrumb or tree only when branches exist.

### 7.6 What not to copy

Pi intentionally does not provide a built-in permission system and its extensions can have broad process access. Workbench’s stricter bridge, path containment, no-network webview, exact permissions, and workspace-trust requirement are stronger and should remain.

## 8. Built-in VS Code Chat and Agent Host review

### 8.1 The built-in product has become a platform

Current VS Code separates two primary user surfaces:

- **Chat view:** code-first, scoped to the open workspace, integrated with editor tabs, tasks, tests, terminals, notebooks, and inline diffs.
- **Agents window:** agent-first, cross-workspace, parallel, worktree-aware, and focused on session monitoring and change review.

The surfaces share sessions. Current releases also provide or are rolling out:

- session grouping, filtering, pinning, archiving, and forking;
- parallel sessions;
- multiple chats inside one agent-host session/worktree;
- subagent visibility;
- worktree-based isolation;
- native changes panels and diff statistics;
- range-level feedback and reviewed state;
- checkpoints;
- plan agents and handoff;
- permission levels;
- OS notifications;
- remote and multi-client sessions;
- browser and terminal tooling.

Rebuilding all of those generically inside Workbench would now create permanent duplication.

### 8.2 Agent Host and AHP

The Agent Host is a dedicated process that owns sessions independently of VS Code windows. AHP uses JSON-RPC, immutable state, pure reducers, ordered server actions, snapshots, and replay/reconciliation.

AHP and ACP are intentionally complementary:

- ACP is the 1:1 editor/client-to-agent protocol.
- AHP is the N-client coordination and shared-state protocol.
- An AHP host can bridge to an ACP agent.

This is a very close match to the desired OpenCode architecture:

```text
N VS Code clients
      │
      │ AHP
      ▼
OpenCode session host
      │
      │ ACP
      ▼
OpenCode agent subprocesses
```

### 8.3 Why Workbench should not immediately pivot

The official material also makes clear that the Agent Host and AHP are still evolving. The current first-party adapters are for Copilot, Claude, and Codex. A stable Marketplace extension API for registering an arbitrary harness in the harness picker is not yet documented.

The project must therefore treat native integration as a gated prototype, not as an assumed dependency.

### 8.4 VS Code extension APIs: which layer is correct?

#### Chat Participant API

A Chat Participant gives an extension a named conversational endpoint inside VS Code Chat. It is useful for narrow commands, documentation assistance, or a handoff action.

It is **not** the correct primary integration for Workbench because the extension would either:

- use VS Code’s model and tool loop, violating OpenCode authority; or
- manually stream an external session into a participant surface that was not designed to own a full independent harness lifecycle.

A small `@opencode` handoff participant may be useful later, but it should not become the runtime.

#### Language Model Chat Provider API

This API contributes models to VS Code’s model picker. It is the wrong layer for Workbench because OpenCode is a complete agent harness, not merely a model endpoint. Using it would bypass OpenCode’s agents, tools, prompt assembly, permissions, session state, and plugins.

#### Custom agents, skills, hooks, and MCP

These customize VS Code’s own harness. Workbench should not automatically translate them into OpenCode configuration. Their semantics and trust models differ.

The native OpenCode harness may be able to consume client-contributed tools through Agent Host/ACP. That mapping must be explicit and capability-tested.

#### `chatSessionsProvider`

VS Code documents this as a proposed API. It may eventually be useful for projecting OpenCode sessions into the native sessions view, but Workbench must not make stable releases depend on a proposed API or Marketplace allowlisting.

#### AHP/Agent Host

This is the correct conceptual layer for a complete external agent harness. It is the only path in this list that preserves the idea that OpenCode, not VS Code, owns the agent loop.

### 8.5 Native-versus-custom mode

The recommended experience model is:

#### Stable Workbench mode

- Current custom OpenCode chat surfaces.
- Existing HTTP/SSE runtime integration.
- Compatible with the existing VS Code minimum.
- Full OpenCode-specific permission and plugin support.
- Receives the UI, protocol, context, goal, review, and Multi-run improvements from the plan.

#### Experimental native mode

- OpenCode launched through ACP.
- AHP bridge/host if the VS Code connection path is proven.
- Native Chat view and Agents window for generic session work.
- Workbench supplemental view for OpenCode-specific state.
- Disabled automatically when exact permission or session semantics cannot be represented.

The user must never see the same OpenCode session simultaneously controlled by two independent orchestration authorities.

## 9. Cross-harness design decisions

### 9.1 Canonical lifecycle model

Workbench should introduce a UI projection with these layers:

```text
Runtime
└── Session
    ├── Chat/branch
    │   ├── Turn
    │   │   └── Activity items
    │   └── Queued input
    ├── Filesystem locator/worktree
    └── Goal/run-group metadata references
```

Suggested lifecycle types:

```ts
type PromptAdmission =
  | { status: "started"; turnID: string }
  | { status: "queued"; queueID: string; delivery: "steer" | "followUp" }
  | { status: "replaced"; queueID: string }
  | { status: "rejected"; error: StructuredError };

type TurnStatus =
  | "accepted"
  | "running"
  | "awaiting-permission"
  | "awaiting-question"
  | "completed"
  | "interrupted"
  | "failed";

type SettlementState =
  | "active"
  | "settling"
  | "settled"
  | "needs-input"
  | "disconnected";
```

OpenCode remains the data authority. These types are a projection and synchronization contract, not a second transcript schema.

### 9.2 Protocol v2

Protocol v2 should combine the best properties of Codex and AHP while retaining Workbench’s bounded validation:

- initialize/ready handshake;
- protocol-range negotiation;
- capability negotiation;
- request/response correlation;
- server-initiated permission and question requests;
- cancellation;
- mutation IDs and idempotency;
- structured errors;
- epoch + ordered event sequence;
- snapshot + incremental actions;
- replay or full resync after gaps;
- bounded queues and explicit overload behavior;
- schema generation or mechanical type-validator-fixture verification;
- independent prompt-admission and run-completion events;
- settled-state barrier.

### 9.3 Permission mapping

Permission mapping must be lossless. The adapter should advertise exactly which decisions it can represent:

```ts
interface PermissionCapabilities {
  allowOnce: boolean;
  allowExact: boolean;
  allowScope: boolean;
  reject: boolean;
  rejectWithFeedback: boolean;
  amendCommandPolicy: boolean;
  amendNetworkPolicy: boolean;
}
```

If a native surface can represent only a subset, Workbench must either:

1. show an OpenCode-specific elicitation card for the missing choices; or
2. disable those choices and explain why; or
3. disable native mode for that session.

It must not silently map “allow scope” to “allow once” or “always allow.”

### 9.4 Context ownership

Three concepts must remain distinct:

1. **Available environment context:** tools and resources the agent may query.
2. **Attached prompt context:** selections, files, diagnostics, terminal excerpts, images, and pasted text admitted with a specific prompt.
3. **Actual model context:** what OpenCode ultimately included after its own prompt assembly and compaction.

Workbench’s context ledger should expose the first two exactly and the third only where OpenCode reports reliable metadata.

In native mode, avoid double context assembly. VS Code should not independently construct a Copilot prompt around an OpenCode ACP session.

### 9.5 Plans, goals, and handoff

Use separate concepts:

- **Plan:** a user-reviewable design artifact created before implementation.
- **Goal:** an objective that can continue across several OpenCode turns until completion, block, or limit.
- **Run group:** several independent sessions attempting the same task.
- **Review:** a separate evaluation of code or a result.
- **Walkthrough:** an explanation of what changed and in what order to read it.

Workbench should add a first-class Plan workflow using OpenCode’s Plan agent and then hand the approved plan to an implementation session or goal.

### 9.6 Change review

Use this hierarchy:

```text
Exact Git diff identity
→ native VS Code diff/editor navigation
→ per-turn and per-session change summaries
→ deterministic task/diagnostic evidence
→ optional Walkthrough explanation
→ separate Review operation
```

Do not treat an LLM summary as the source of truth for changed files or passed tests.

### 9.7 Worktree ownership

Exactly one component may own a worktree lifecycle:

- In native mode, prefer the Agent Host if it exposes a complete and recoverable worktree lifecycle.
- In stable custom mode, use the Workbench worktree journal from the original plan.
- Never let both create, rename, remove, or recover the same worktree.

### 9.8 Multi-run

Multi-run remains a differentiated Workbench feature even if native VS Code manages individual sessions.

Workbench should own only the grouping and comparison metadata:

```text
Run group
├── Native or custom OpenCode session A
├── Native or custom OpenCode session B
└── Native or custom OpenCode session C
```

Each child remains a normal OpenCode session and, where isolation is enabled, a normal worktree-backed session.

### 9.9 Health, trace, and evals

The harness review adds two required engineering surfaces:

#### Sanitized session trace

A developer-only trace should show:

- protocol handshake;
- capability negotiation;
- prompt admission;
- turn and item lifecycle;
- permission/question requests;
- queue delivery;
- reconnect/resync;
- diff revision;
- settlement;
- no prompt or secret payloads by default.

#### Harness conformance suite

Create provider-free scenarios that can run against the HTTP/SSE adapter and ACP adapter:

- create/resume/fork/delete session;
- admit prompt without a provider call where possible;
- parse representative streaming fixtures;
- permission round trip;
- question round trip;
- cancel;
- queue/steer/follow-up;
- disconnect and resume;
- diff updates;
- goal continuation;
- session settlement;
- multi-directory behavior.

Optional real-model evals should measure product behavior, not only model quality:

- correct context admitted;
- permission shown before execution;
- edits associated with the correct turn;
- session remains recoverable after interruption;
- no cross-worktree contamination;
- deterministic evidence matches actual task results.

## 10. Revised feature decisions

| Feature | Revised decision |
|---|---|
| Protocol v2 | Build; use Codex/AHP lifecycle and schema discipline |
| Context ledger/receipts | Build; remains a primary differentiator |
| Needs Attention inbox | Build in custom mode; use native attention state where available |
| Custom Work tree | Conditional fallback, not assumed primary future shell |
| Persistent inspector | Build for OpenCode-specific details; avoid duplicating native generic panels |
| Worktree management | Native owner when proven; Workbench journal otherwise |
| Multi-run | Build as transport-independent run-group orchestration |
| Run comparison | Build as Workbench-specific panel linked to native/custom sessions |
| Changes Walkthrough | Build; anchor to exact native Git diff |
| Independent goal verifier | Build through OpenCode, not a provider SDK |
| Plan-first workflow | Add using OpenCode Plan agent and explicit handoff |
| Native VS Code Chat/Agents integration | Prototype behind capability and version gates |
| Chat Participant integration | Optional narrow handoff only |
| Language Model Provider integration | Do not build |
| `chatSessionsProvider` | Research only; do not depend on proposed API for stable release |
| Universal Codex/Claude/Pi adapters | Do not build |
| Generic shell hooks | Do not build |
| Custom terminal/browser/remote relay | Do not build |

## 11. Required architecture spikes

The implementation plan must start with these spikes before broad UI work:

### ACP-001 — OpenCode ACP contract

Produce a provider-free fixture recorder and capability matrix. Record exact JSON-RPC method names, lifecycle, errors, session behavior, and permission/question mapping.

### AHP-001 — VS Code custom harness feasibility

Determine, using current VS Code Stable and Insiders:

- how a third-party AHP host is discovered or connected;
- whether a Marketplace extension can register a harness;
- whether a separate host process can be selected in the harness picker;
- whether GitHub/Copilot authentication is required for the UI shell;
- whether sessions appear in both Chat and Agents window;
- whether worktrees and changesets are available to a third-party host;
- whether extension-contributed tools reach the host;
- whether the connection works on local, remote SSH, and code-server variants;
- which APIs are proposed or allowlisted.

### MAP-001 — Lossless mapping

Map every Workbench/OpenCode capability to ACP and AHP. Mark each as:

```text
native
mapped losslessly
mapped with supplemental Workbench UI
unsupported but degradable
blocking incompatibility
```

### ADR-001 — Native integration decision

Choose one of:

- **Native-first:** stable enough to become the preferred current-VS-Code mode.
- **Hybrid:** experimental native mode plus stable custom mode.
- **Defer:** continue custom Workbench while monitoring AHP.

Historical recommendation: **Hybrid**, subject to the spikes. Recorded outcome:
ADR 0003 selected **Defer** (`defer-native`) after the stop conditions were met.

## 12. Source references

Primary references used in this review:

- OpenCode ACP documentation: https://opencode.ai/docs/acp/
- OpenCode server and SDK documentation: https://opencode.ai/docs/server/ and https://opencode.ai/docs/sdk/
- OpenCode Workbench repository: https://github.com/Nulifyer/opencode-workbench
- Codex app-server protocol: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code worktrees: https://code.claude.com/docs/en/worktrees
- Claude Code checkpointing: https://code.claude.com/docs/en/checkpointing
- Claude Code sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Pi coding-agent documentation: https://github.com/earendil-works/pi/tree/main/packages/coding-agent
- Pi RPC protocol: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- VS Code Agent Host architecture: https://code.visualstudio.com/docs/agents/concepts/agent-host
- VS Code Chat sessions: https://code.visualstudio.com/docs/chat/chat-sessions
- VS Code Agents window: https://code.visualstudio.com/docs/agents/agents-window
- Agent Host Protocol: https://microsoft.github.io/agent-host-protocol/
- AHP and ACP layering: https://microsoft.github.io/agent-host-protocol/guide/ahp-and-acp.html
