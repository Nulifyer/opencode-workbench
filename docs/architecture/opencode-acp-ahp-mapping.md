# OpenCode, ACP, and AHP semantic mapping

Status: MAP-001 baseline, 2026-08-08

This mapping combines the recorded OpenCode 1.18.15 ACP contract with AHP's
current state/action model. “Native” means both protocols have an unambiguous
first-class concept. “Lossless mapping” permits an adapter-owned identifier or
state field. Supplemental state remains owned and rendered by Workbench. A safe
degradation must be visible and must never silently approve, discard, or repeat
work. A blocking incompatibility disables the affected native operation.

| Capability                          | OpenCode / recorded ACP evidence                                                                                  | AHP representation                                                           | Classification            | Required guardrail                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Session create                      | `session/new` returns an OpenCode session ID                                                                      | `createSession`, session channel                                             | native                    | Persist both IDs before accepting a prompt                                                                       |
| Session resume/load                 | `session/load` and `session/resume` succeed after process restart                                                 | Subscribe/reconnect to durable session state                                 | lossless mapping          | Reconcile by persisted OpenCode ID; never infer from title                                                       |
| Session fork                        | `session/fork` returns a distinct child ID                                                                        | New session/chat plus adapter parent metadata                                | lossless mapping          | Preserve immutable parent ID and fork point                                                                      |
| Session delete                      | ACP exposes close, not durable delete                                                                             | `disposeSession` disposes host resources                                     | supplemental Workbench UI | Delete through authoritative OpenCode HTTP only after explicit confirmation                                      |
| Chat and branch identity            | OpenCode session is the primary conversation; parentage is available outside ACP                                  | Session contains chat channels                                               | lossless mapping          | One OpenCode session per writable chat; persist branch/worktree separately                                       |
| Turn start/end/failure/cancel       | Prompt streams updates; cancel is advertised; provider-free completion shapes remain partly unknown               | `chat/turnStarted`, completion/failure/cancel actions                        | lossless mapping          | Use distinct terminal reasons and process generation                                                             |
| Turn settlement                     | OpenCode visible completion can precede permission/question/tool quiescence                                       | AHP turn state plus pending durable inputs                                   | lossless mapping          | Settled only when terminal **and** no pending input/tool/queued mutation remains                                 |
| Text and reasoning deltas           | ACP update kinds exist but provider-producing shapes require opt-in recording                                     | Chat delta/response-part actions                                             | lossless mapping          | Preserve channel, order, item ID, and final replacement semantics                                                |
| Tool calls and results              | ACP supports client terminal/fs requests and update events; exact tool schemas are not discoverable provider-free | Tool-call start/update/ready/complete state                                  | lossless mapping          | Preserve call ID, raw status, locations, and terminal identity                                                   |
| Permission choices                  | OpenCode has allow once/exact/scope and rejection variants; provider-free ACP round trip is unproven              | First confirmation wins, but AHP does not define all OpenCode policy choices | supplemental Workbench UI | Never collapse choices to boolean; disable native permission-bearing turns without exact supplemental round trip |
| Questions / elicitation             | OpenCode durable question semantics are not proven through ACP                                                    | AHP elicitation/input state                                                  | supplemental Workbench UI | Persist question ID/options/multi-select/custom answer; cancellation is not rejection                            |
| Queue / steer / follow-up / replace | Not advertised or proven by recorded ACP                                                                          | AHP pending messages and sequenced turn actions                              | blocking incompatibility  | Do not expose native queueing until every operation has an idempotent mapping                                    |
| Model / agent selection             | Agent and model selection proven                                                                                  | Root agent catalogue and session configuration                               | native                    | Round-trip exact provider/model IDs; no provider account duplication                                             |
| Variant selection                   | Not advertised by recorded ACP                                                                                    | No proven exact OpenCode variant contract                                    | supplemental Workbench UI | Keep variant in Workbench and OpenCode request metadata                                                          |
| Todos                               | Available in OpenCode HTTP/SSE; provider-free ACP update not observed                                             | No required portable todo state                                              | supplemental Workbench UI | Key by session/turn and preserve OpenCode ordering/status                                                        |
| Token, cost, context metadata       | OpenCode HTTP/SSE provides authoritative usage; ACP provider-free seam cannot produce it                          | Optional response/telemetry state does not guarantee OpenCode accounting     | supplemental Workbench UI | Display source and unknown values; never synthesize cost                                                         |
| File changes / exact diff           | OpenCode messages and repository state can identify changes                                                       | AHP changesets/change entries                                                | lossless mapping          | Preserve repository root, before/after object IDs, paths, and turn boundary                                      |
| Terminals                           | ACP advertises terminal support                                                                                   | Root terminal catalogue and terminal channels                                | native                    | Preserve process/terminal ID, cwd, exit state, and ownership                                                     |
| Worktree / root                     | ACP session is cwd-scoped; OpenCode does not own VS Code native worktree state                                    | Session root and native worktree metadata                                    | supplemental Workbench UI | Stable mode is the sole worktree owner; never allow two cleanup authorities                                      |
| Reconnect / replay                  | ACP sessions persist, but ACP has no multi-client replay protocol                                                 | AHP snapshot, `serverSeq`, reconnect, replay                                 | lossless mapping          | Host epoch + ordered sequence + snapshot fallback; reject stale generations                                      |
| Custom/client tools                 | ACP client capabilities can expose fs/terminal; exact extension tool schemas are not discoverable                 | Client tools are optional and disappear with the client                      | safe degradation          | Mark unavailable tools immediately; autonomous turns may depend only on host-local tools                         |
| Goals / preferences / skills        | Companion plugin commands are discovered; richer state lives in Workbench/OpenCode                                | No portable first-class state                                                | supplemental Workbench UI | Keep typed, versioned state and context receipts outside transcript text                                         |
| Bridge/editor context               | Stable bridge contributes explicit editor context                                                                 | Client-contributed tool/context route                                        | safe degradation          | Attach once, record provenance/size, and never double-assemble prompts                                           |
| Errors / overload                   | JSON-RPC method/param errors are proven; overload behavior is not                                                 | JSON-RPC errors, rejected action envelope, connection state                  | lossless mapping          | Typed codes, retryability, correlation ID, bounded queues, and no raw secrets                                    |

## Identity and authority rules

- OpenCode remains authoritative for agent sessions, messages, permissions,
  questions, todos, usage, and provider execution.
- A future AHP host would be authoritative only for AHP ordering, subscriptions,
  replay, and client reconciliation.
- Workbench owns supplemental metadata and stable-mode UI projections.
- Git/worktree lifecycle has exactly one selected owner.
- A prompt is admitted once. Acceptance, execution, visible terminal state, and
  settlement are separate facts.

## Native stop rows

Permission choices and durable questions require supplemental UI and an exact
round trip before a native permission-bearing session could be enabled. Queue
semantics remain a blocking incompatibility because the ACP fixture does not
advertise or prove steer/follow-up/replace. AHP's open protocol cannot repair
those gaps without an adapter contract and a public VS Code registration path.

Primary references: [AHP and ACP layering][layering], [AHP actions][actions],
[AHP message reference][messages], and the checked
`packages/vscode-extension/test/fixtures/acp/opencode-1.18.15.json` fixture.

[layering]: https://microsoft.github.io/agent-host-protocol/guide/ahp-and-acp.html
[actions]: https://microsoft.github.io/agent-host-protocol/guide/actions.html
[messages]: https://microsoft.github.io/agent-host-protocol/reference/messages.html
