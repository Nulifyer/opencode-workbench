# OpenCode Workbench invariants

This document defines the non-negotiable authority, persistence, and privacy
boundaries of Workbench `v0.4.6`. It describes current behavior and constrains
later UI evolution.

## Ownership

| Concern | Current authority | Workbench responsibility | Contract and evidence |
| --- | --- | --- | --- |
| Models, providers, agents, tools, commands | OpenCode | Read, bound, validate, and project catalogs | `OpenCodeClient.catalogs()`, `commands()`, and `toolIDs()`; `client_test.ts` catalog tests |
| Sessions and transcripts | OpenCode | Select, reconcile, paginate, and project sessions | `OpenCodeClient` session methods; `session-controller_test.ts` reconciliation tests |
| Prompt execution | OpenCode | Admit a prompt with a stable message ID and requested delivery | `OpenCodeClient.sendPrompt()`; `client_test.ts` prompt-admission tests |
| Stable-mode queue | Workbench extension host until delivery | Keep bounded in-memory entries and their private file bytes; deliver via OpenCode `steer` or `queue` | `SessionController.sendToSession()` and `drainQueue()`; queue tests in `session-controller_test.ts` |
| Permissions and questions | OpenCode | Preserve, display, and return exact supported responses | `parsePermission()`, `parseQuestion()`, coordinator methods; permission/question tests |
| Goals, preferences, skill candidates | Companion OpenCode plugin | Project goal state and offer controls; never run a second model loop | `packages/opencode-plugin/src/index.ts`; plugin goal, memory, skill, and integration tests |
| Session lineage, archive, sharing, revert state | OpenCode | Project native `parentID`, `time.archived`, `share`, and `revert`; invoke only proven native mutations | `OpenCodeClient`, `SessionController`, and recovery/session-list tests |
| PTYs and background child sessions | OpenCode | Project the bounded native PTY feed; request native cancellation/backgrounding | OpenCode `/pty` and `/experimental/session/:id/background`; client/controller PTY tests |
| Task artifacts and session pins | VS Code workspace state | Retain bounded presentation/action metadata keyed to canonical OpenCode session/message IDs | `TaskArtifactService`, `SessionPresentationService`, and shared artifact validators |
| Editor state, tasks, terminals, diagnostics | VS Code | Expose a typed, authenticated, bounded bridge | `packages/vscode-extension/src/bridge.ts`; workspace and security tests |
| Sidebar/editor synchronization | Extension host | Publish one bounded projection and synchronize private composer payloads | `ChatViewProvider`; communication and protocol tests |

Exactly one `SessionController` owns stable-mode orchestration for a connected
workspace. OpenCode is the sole agent runtime and the sole authority for
sessions, transcripts, models, tools, prompt execution, child-session lineage,
and native terminal state. The extension host is a presentation/control plane;
it does not run a second agent loop or provider SDK. There is no production ACP
adapter or Agent Host authority.

## Lifecycle

Prompt admission, turn activity, visible turn completion, and a truly settled
session are different concepts. The current implementation partially exposes
the first three; it does **not** have a canonical settlement contract.

- A submitted prompt receives a client-generated `msg_...` ID before transport.
- The v2 endpoint admits `{ id, prompt, delivery, resume: true }`. A successful
  request means admission, not completion.
- A busy stable-mode session may retain the prompt in the extension queue. A
  queued entry is not admitted until `drainQueue()` successfully delivers it.
- `steer` asks OpenCode to yield at its next opportunity. `queue` waits for the
  session to become terminal. `replace` first aborts, then sends.
- OpenCode `busy`, `retry`, `idle`, error, `session.next.*`, message, permission,
  and question events may re-enter after a visible message update.
- Goal continuation is reserved and admitted by the companion plugin after an
  idle event-loop boundary. The extension does not duplicate that loop.
- Unknown or ambiguous prompt-admission failures retain visible prompt text and
  reconcile against durable OpenCode history before retry/rollback decisions.

Until the lifecycle foundation work lands, no consumer may interpret a single
assistant message, `session.next.step.ended`, or `session.idle` event as a
general `sessionSettled` guarantee. This gap is proven by the goal-continuation
and stale-event tests in `goal_integration_test.ts` and
`session-controller_test.ts`.

## Identity and ordering

- OpenCode session IDs are canonical. A child session carries `parentID`; the
  controller follows that chain to determine root-scoped approval state.
- Workbench-generated message IDs match `msg_[0-9a-f]{26}`. OpenCode-generated
  session, message, and part IDs are treated as opaque bounded strings.
- A part belongs to both `sessionID` and `messageID`; it is merged by part `id`.
- Live message mutations receive monotonic in-memory revisions per session and
  per message. Transcript reconciliation cannot replace newer live state or
  resurrect explicitly removed messages/parts.
- SSE frames pass through `OrderedEventBus` in wire order. One handler failure
  does not stop later frames. The deterministic stress path covers 20,000
  events.
- Reconnect generations invalidate stale fetches and stale event loops. An old
  stream may not settle a replacement connection or drain a queue.

Evidence: `packages/shared/test/session-state_test.ts`,
`packages/vscode-extension/test/ordered-event-bus_test.ts`,
`event_pipeline_stress_test.ts`, and the transcript/reconnect cases in
`session-controller_test.ts`.

## Permissions and questions

- OpenCode remains the decision authority. Workbench stores at most 100 visible
  permission requests per session and bounds aggregate detail.
- Legacy, current, and v2 permission identities remain distinct. Responses use
  the endpoint belonging to the request protocol.
- The UI may offer once, exact reusable patterns, conservative command scopes,
  or reject with feedback. Reusable grants are in-memory and root-session
  scoped; new roots default to Ask.
- An incomplete or truncated request is reject-only. Auto approval never covers
  it, and `vscode.reload_opencode` always requires explicit approval.
- Questions retain all bounded question blocks, options, multiple/custom flags,
  and their legacy/v2 protocol. Reply and reject target the owning session and
  request ID.
- Pending permission and question lists are reconciled on connection. A failed
  protocol does not erase requests recovered through another protocol.

Evidence: `packages/vscode-extension/test/client_test.ts`, permission/question
cases in `session-controller_test.ts`, and
`packages/shared/test/protocol_test.ts`.

## Connection and recovery

- Managed mode accepts OpenCode `>=1.18.11` and `<1.19.0`, starts one private
  loopback server per extension host, injects the packaged plugin, and requires
  ephemeral Basic authentication.
- External mode accepts numeric-loopback HTTP or remote HTTPS. Credentials are
  never embedded in the URL. An optional password override is held in VS Code
  Secret Storage.
- Every stable HTTP/SSE request includes the selected directory. Legacy routes
  use `directory`; v2 routes additionally use `location[directory]` where the
  server contract requires it.
- Reconnect first hydrates session metadata, status, catalogs, commands,
  runtime services, pending permissions/questions, and selected or busy
  transcripts. Only then does the connection become ready.
- Recovered mappings for legacy-unsafe sessions reference OpenCode forks; they
  do not copy transcript data into Workbench storage.
- Session archive is OpenCode's native `time.archived` mutation. The supported
  OpenCode 1.18.15 contract does not prove a clear/unarchive mutation, so
  Workbench offers archive but does not fabricate unarchive state. Pins are a
  separate, bounded VS Code presentation preference and never alter OpenCode.
- Public sharing and unsharing use OpenCode's native share endpoints. The
  resulting `share.url` is projected as public state; Workbench does not mint,
  proxy, or persist a second share identity.
- PTY status, PID, command metadata, and exit code come from OpenCode. Cancel
  deletes the native PTY only after identity validation, and backgrounding uses
  OpenCode's child-session endpoint rather than a Workbench scheduler.
- Undo/recovery previews are side-effect-free projections of an idle OpenCode
  session. Applying a preview revalidates the session and invokes OpenCode's
  coupled transcript-and-file revert boundary. Redo is offered only when the
  native `revert` marker proves it is available. Current file totals are not
  exact per-message attribution, and shell, external-service, and manual side
  effects may remain.

Evidence: `managed-server_test.ts`, `communication_test.ts`,
`opencode_integration_test.ts`, and reconnect/recovery cases in
`session-controller_test.ts`.

## Bridge security and affinity

- The extension bridge listens only on `127.0.0.1` at an ephemeral port and
  requires a random 256-bit bearer token plus the exact bridge ID.
- The registry is atomic, bounded to 1 MiB, mode `0600` inside a `0700`
  directory, refreshed every five seconds, and treats entries as stale after
  30 seconds.
- A bridge entry authorizes one canonical worktree root and an explicit
  operation allowlist. Request context must use that worktree and a contained
  real directory.
- Managed mode supplies `OPENCODE_WORKBENCH_BRIDGE_ID` for exact window
  affinity. External mode rejects ambiguous same-worktree matches.
- No caller-provided VS Code command ID or shell string crosses the boundary.
  Terminal execution uses an executable plus argument array through VS Code
  shell integration. Code actions and rename operations are previews only.
- Requests, responses, paths, JSON depth, process lifetime, and every operation
  have explicit bounds and cancellation.

Evidence: `workspace-root_test.ts`, `security_test.ts`, and bridge cases in
`communication_test.ts`.

## Persistence and privacy

| Data | Location/lifetime | Rule |
| --- | --- | --- |
| OpenCode sessions/transcripts | OpenCode storage | Canonical transcript; Workbench does not create a transcript database |
| Selected workspace root, selected session, recovery mapping | VS Code workspace state | IDs/URIs only; no prompt payload |
| Session pins | VS Code workspace state | Bounded presentation metadata keyed by OpenCode session ID; archive/share/lineage remain native |
| Task artifacts | VS Code workspace state | Bounded, revisioned presentation/action metadata keyed by OpenCode provenance; never a second transcript or plan/prompt body store |
| Composer agent/model/variant preferences | VS Code global state | Metadata only |
| External server password override | VS Code Secret Storage | Never settings, workspace state, registry, or logs |
| Managed credentials and bridge bearer token | Extension-host memory; bridge token also in owner-only registry | Removed/invalidated on disposal |
| Goal state | `$XDG_DATA_HOME/opencode-workbench/plugin/goals.json` (fallback under the user data home) | Bounded atomic schema v2 state with durable continuation IDs and transcript-based restart recovery |
| Preferences, evidence, staged skill candidates | `$XDG_DATA_HOME/opencode-workbench/plugin/state.json` | Approved/staged metadata; secret and prompt-injection scanning |
| Attachment, screenshot, clipboard, and unsaved-buffer bytes | Webview and extension-host memory until admission | Never VS Code state or transcript snapshots; historical snapshots omit data URLs/base64 |
| Webview state | VS Code webview state | Presentation only: pane widths/visibility, selected inspector tab, session filters, and todo expansion |

Complete prompt payloads, attachment bytes, unsaved buffers, credentials, and
bridge response bodies must not be added to new persisted metadata. Plan
artifacts store a URI, exact revision, lifecycle, handoff references, and
OpenCode producer provenance, never the objective or Markdown body. Review
artifacts may store bounded structured findings and dispositions tied to an
exact diff hash, but never the raw diff. Goal-verification artifacts retain
bounded verdict/evidence/attempt metadata. Run comparisons retain objective
rows only and never an AI-selected winner. Context-capture artifacts retain
sanitized receipt/source metadata only; browser screenshot and clipboard bytes
remain one-shot prompt material and are never persisted.

## Stable UI boundary

- Both the secondary-sidebar view and resizable editor Task Workbench use
  `ChatViewProvider` and the same controller state.
- The webview has a nonce CSP, `default-src 'none'`, no network permission, and
  runtime-validated bounded messages in both directions.
- New surfaces negotiate protocol v2 with `hello`/`ready`. Every webview action
  then uses a correlated request/response envelope with a stable mutation ID;
  legacy in-process webviews can still use the validated v1 messages.
- Each surface has an epoch-bound event cursor, monotonic sequence and revision,
  bounded hidden queue, and replay-or-snapshot recovery. A reconnect replaces
  the epoch before later state can be applied.
- The extension host projects aggregate snapshots to a 24 MiB UTF-8 byte
  budget before either webview transport is used. The selected session,
  pending input, recent transcript, actionable runs/worktrees, recent context
  receipts, and recent walkthroughs take priority. Any omitted counts travel
  with the snapshot and are shown in the UI; durable records are not pruned.
- The host owns filesystem reads, OpenCode network access, link opening, native
  editors/diffs, clipboard operations, task and terminal actions.
- Pending composer payloads synchronize by revision and mutation ID. Conflicts
  preserve both sides within limits and require review before sending.
- Snapshots omit raw attachment URLs/base64. Targeted message patches are
  bounded and revisioned.

Evidence: `protocol_test.ts`, `protocol_v2_test.ts`, `event_stream_test.ts`,
`webview_protocol_host_test.ts`, `webview_protocol_client_test.ts`,
`webview-assets_test.ts`, `communication_test.ts`, `presentation_test.ts`, and
`session-controller_test.ts`, plus `webview_snapshot_projector_test.ts`.

## Known gaps

- Protocol cancellation is cooperative: a handler that does not observe its
  abort signal can finish upstream work after its surface is disposed.
- A canonical session settlement barrier remains incomplete.
- `SessionController` and `webview/main.ts` remain concentration points.
- `OpenCodeConnection` has one directory; run-group and worktree identities do
  not exist in `WorkbenchState`.
- ACP provider-free discovery does not expose companion tool schemas,
  permissions, questions, prompt lifecycle, usage, diffs, or queue semantics.
- Native VS Code Agent Host registration and lossless mapping remain unknown.
- Native unarchive is feature-gated until the supported OpenCode contract proves
  a clear mutation; Workbench does not emulate it with local metadata.
- OpenCode revert recovery cannot guarantee reversal of shell commands,
  external-service calls, manual edits, or other effects outside the native
  coupled transcript/file boundary.

These are documented gaps, not permission to emulate missing behavior.
