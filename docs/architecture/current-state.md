# Current architecture and contracts

This is the implementation map for OpenCode Workbench `v0.4.6` at
`c6c415221a3c1d2ba893efae9a14136231cd37ea`.

## Compatibility

| Component | Current contract |
| --- | --- |
| VS Code | Extension engine `^1.106.0`; stable code uses no proposed API |
| OpenCode managed mode | `>=1.18.11` and `<1.19.0` |
| OpenCode used for ACP fixture | `1.18.15`, ACP SDK `0.21.0`, protocol version `1` |
| Extension | `0.4.6` |
| Runtime | Extension bundle targets Node 20; webview targets ES2022 |

Managed compatibility is enforced by `managed-server.ts` and
`managed-server_test.ts`. The provider-free HTTP/SSE real test is
`opencode_integration_test.ts`; the ACP pin is in `acp_contract_test.ts`.

## Stable runtime topology

```text
sidebar WebviewView ─┐
                     ├─ ChatViewProvider ─ SessionController ─ OpenCodeClient
editor WebviewPanel ─┘                          │                    │
                                               │                    ├─ HTTP methods
                                               │                    └─ ordered SSE
                                               ├─ VS Code native APIs
                                               └─ authenticated editor bridge
                                                                  │
                                                     companion OpenCode plugin
```

The extension host is the only webview backend. The webview cannot access the
network or filesystem. Managed mode owns an authenticated loopback OpenCode
server; external mode connects to a separately managed endpoint.

## HTTP methods used

All paths below are OpenCode-owned. Every request includes the selected
directory; v2 `/api` routes use `location[directory]` where shown in code.

| Domain | Methods currently called |
| --- | --- |
| Health and instance | `GET /global/health`, `POST /instance/dispose` |
| Sessions | `GET/POST /session`, `PATCH/DELETE /session/:id`, `GET /session/status`, `GET /api/session/active` |
| Session history/actions | `POST /session/:id/fork`, `/revert`, `/unrevert`, `/summarize`, `/share`; `DELETE /session/:id/share` |
| Transcripts | legacy `GET /session/:id/message`; v2 `GET /api/session/:id/message` and `/history` |
| Prompt admission | v2 `POST /api/session/:id/agent`, `/model`, `/prompt`; legacy `POST /session/:id/prompt_async` and `/command` |
| Interruption | `POST /api/session/:id/interrupt` and legacy `/session/:id/abort` |
| Permissions | `GET /api/permission/request`, `GET /permission`; v2 `/api/session/:sid/permission/:rid/reply`, current `/permission/:rid/reply`, legacy `/session/:sid/permissions/:rid` |
| Questions | `GET /api/question/request`, `GET /question`; v2 session-scoped reply/reject and legacy `/question/:rid/reply|reject` |
| Session projections | `GET /session/:id/todo`, `/diff` |
| Catalogs | `GET /agent`, `/config/providers` with `/provider` fallback, `/config`, `/experimental/resource`, `/command`, `/experimental/tool/ids` |
| Runtime services | `GET /path`, `/vcs`, `/lsp`, `/formatter`, `/mcp`; typed MCP connect/disconnect/auth/remove-auth routes |
| Events | `GET /event` with `Accept: text/event-stream` |

Request bodies are JSON, ordinary requests time out after 30 seconds, long
operations after ten minutes, response bodies after 32 MiB, error bodies after
64 KiB, SSE frames after 8 MiB, and transcript pagination after 10,000 messages.

## SSE events consumed

The controller recognizes these event families:

- server connection/heartbeat/disposal;
- session create/update/delete/status/idle/error/diff/compaction;
- message and part create/update/remove/delta;
- `session.next.*` agent/model selection, prompt admission, steps, text,
  reasoning, tools, retries, compaction, shell, and revert lifecycle;
- legacy/current/v2 permissions and legacy/v2 questions;
- todos, file watcher/edit, LSP, VCS, MCP, catalog, provider/integration,
  project/workspace/worktree, PTY, command, installation, and TUI events.

The exact allowlist is `KNOWN_OPENCODE_EVENTS` in `session-controller.ts`.
Unknown event types are logged once and ignored. Events remain wire ordered
through `OrderedEventBus`; streamed deltas are not coalesced or discarded.

The frozen event-name contract is:

```text
server.connected
server.heartbeat
server.instance.disposed
session.created
session.updated
session.deleted
session.status
session.idle
session.error
session.diff
session.compacted
message.updated
message.removed
message.part.updated
message.part.removed
message.part.delta
session.next.agent.switched
session.next.model.switched
session.next.moved
session.next.prompted
session.next.prompt.admitted
session.next.context.updated
session.next.synthetic
session.next.shell.started
session.next.shell.ended
session.next.step.started
session.next.step.ended
session.next.step.failed
session.next.text.started
session.next.text.delta
session.next.text.ended
session.next.reasoning.started
session.next.reasoning.delta
session.next.reasoning.ended
session.next.tool.input.started
session.next.tool.input.delta
session.next.tool.input.ended
session.next.tool.called
session.next.tool.progress
session.next.tool.success
session.next.tool.failed
session.next.retried
session.next.compaction.started
session.next.compaction.delta
session.next.compaction.ended
session.next.revert.staged
session.next.revert.cleared
session.next.revert.committed
permission.updated
permission.asked
permission.replied
permission.v2.asked
permission.v2.replied
question.asked
question.replied
question.rejected
question.v2.asked
question.v2.replied
question.v2.rejected
todo.updated
file.edited
file.watcher.updated
lsp.updated
vcs.branch.updated
mcp.tools.changed
mcp.browser.open.failed
command.executed
pty.created
pty.updated
pty.exited
pty.deleted
models-dev.refreshed
catalog.updated
integration.updated
integration.connection.updated
reference.updated
plugin.added
project.directories.updated
installation.updated
installation.update-available
project.updated
tui.prompt.append
tui.command.execute
tui.toast.show
tui.session.select
workspace.ready
workspace.failed
workspace.status
worktree.ready
worktree.failed
global.disposed
```

## Session, message, and part identity

- Session IDs originate in OpenCode and remain canonical across UI state,
  plugin goals, bridge calls, forks, and reconnects.
- Child sessions reference their OpenCode `parentID`. Approval convenience is
  evaluated against the root of that chain.
- New prompt IDs are Workbench-generated OpenCode-compatible `msg_` IDs. The
  same ID keys pending text/files, queue entries, admission history, messages,
  and targeted webview patches.
- Message parts retain `id`, `sessionID`, and `messageID`. The reducer will not
  attach an unknown part to another message.
- Message/part values are snapshots from OpenCode. Workbench adds a derived
  in-memory revision only for synchronization; it does not rewrite canonical
  IDs or persist transcript copies.

## Prompt and queue behavior

`SessionController.send()` creates a session if needed and delegates to
`sendToSession()`.

| User choice | Current behavior |
| --- | --- |
| Ordinary send to idle/error session | Add a bounded local entry, then v2 `delivery: steer` (immediate admission) or compatible legacy async prompt |
| Add to Queue while busy | Keep the prompt and private file payload in the extension host; deliver when terminal |
| Steer with Message while busy | Mark the entry as steering and ask OpenCode to yield at its next opportunity |
| Stop and Send | Abort active OpenCode work, retain queue integrity, then deliver immediately |
| Edit/reorder/remove queued | Mutate only not-yet-admitted local queue entries |
| Send queued now | Abort when required, move the selected entry first, then drain |
| Abort | Call both current and legacy interruption routes; accepted abort projects idle |

Queue count, text, attachment count, and aggregate character limits are defined
in shared state. Attachment bytes are held in `promptFiles` only until admission
or cleanup. Durable history is checked after ambiguous failures.

## Reconciliation and reconnect

`reconcile()` fetches sessions and status without allowing an older response to
replace a newer revision. A connection generation invalidates previous fetches,
event streams, queued terminal events, and deferred refresh work.

Initial/reconnect hydration includes:

1. session metadata and legacy/v2 active status;
2. agents, providers, models, resources, commands, and tool IDs;
3. path, VCS, LSP, formatter, and MCP status;
4. pending permission and question requests;
5. selected, loaded, and busy transcripts, todos, diffs, and delegated children.

The UI stays in `connecting`/`reconnecting` until hydration settles. Transcript
snapshots merge around live revisions and removal tombstones. Busy-session
reconciliation retains prompt text until OpenCode projects it.

## Permissions and questions

Permission parsers support three OpenCode contracts:

- legacy `permission.updated` plus session-scoped response;
- current `permission.asked`/`permission.replied` plus `once|reject`;
- v2 `permission.v2.asked`/`replied`, including actions, resources, save scopes,
  and rejection feedback.

Metadata is depth/count/character bounded. Truncation is explicit and makes a
request reject-only. Exact and conservative reusable scopes live only for the
root session in extension memory. They never change OpenCode configuration.

Question parsers support legacy and v2 request lists/events. Answers are arrays
of selected/custom strings per question. Reject targets the original protocol
and owning session.

## Companion plugin

The packaged plugin is injected with `OPENCODE_CONFIG_CONTENT` without replacing
disk configuration. It owns:

- `/goal` and `/goal-unlimited` commands;
- goal get/create/update/pause/resume/cancel/complete and history tools;
- bounded automatic goal continuation after authoritative idle state;
- global/project approved preference proposal, review, listing, and forgetting;
- staged skill-candidate proposal, approval/rejection, and evidence;
- VS Code bridge tool registration and OpenCode permission requests;
- native LSP config preservation and approved-preference context injection.

State writes use a bounded atomic store with lock recovery. Goal continuation
coalesces duplicate idle contracts, reserves before admission, cancels stale
timers/fetches, and records failures rather than silently continuing.

## Bridge roots and affinity

`VsCodeBridge` registers one canonical workspace root and its supported
operations. Companion tools select a fresh entry with:

1. exact `OPENCODE_WORKBENCH_BRIDGE_ID` affinity in managed mode;
2. canonical worktree and contained directory;
3. required operation membership;
4. live PID and a heartbeat no older than 30 seconds.

External mode with multiple candidates fails as ambiguous. Bridge context and
all paths are realpath-contained. The only accepted operations are the editor,
language, diagnostics, debug, terminal argument-array, task, preview, URL, and
deferred-reload operations listed in `packages/vscode-extension/DESIGN.md`.

## State and UI ownership

`WorkbenchState` is extension-host memory keyed by OpenCode session ID. It owns
the selected session, connection projection, loaded transcript projection,
draft, unread count, local queue, pending requests, todo/diff projection, and
root-scoped auto-approval convenience.

`ChatViewProvider` owns both webview surfaces, editor context collection,
private context/composer attachment bytes, composer revisions, and bounded
host-side routing. `webview/main.ts` owns DOM state, overlays, scroll/focus,
local attachment previews, and the persisted todo-expanded presentation flag.
The two surfaces synchronize through the host, never directly.

## Test map

| Contract | Deterministic evidence |
| --- | --- |
| Shared protocol validation and privacy | `packages/shared/test/protocol_test.ts` |
| Session reducer identity/order | `packages/shared/test/session-state_test.ts` |
| HTTP parsers/routes/admission | `packages/vscode-extension/test/client_test.ts` |
| Controller queue/reconnect/permission/question/diff behavior | `packages/vscode-extension/test/session-controller_test.ts` |
| Authenticated HTTP/SSE full path | `communication_test.ts` |
| 20,000-frame ordering and final projection | `event_pipeline_stress_test.ts`, `ordered-event-bus_test.ts` |
| Managed process/version/plugin/auth | `managed-server_test.ts`, `opencode_integration_test.ts` |
| Bridge containment and affinity | `workspace-root_test.ts`, plugin `security_test.ts` |
| Goal continuation and persistence | plugin `goal_integration_test.ts`, `goals_test.ts` |
| Preferences and skill candidates | plugin `memory_test.ts`, `skills_test.ts`, `security_test.ts` |
| Webview CSP/assets/presentation | `webview-assets_test.ts`, `presentation_test.ts`, `markdown_test.ts` |
| Packaging | `package_test.ts` and `deno task package` |
| ACP provider-free contract | `acp_contract_test.ts` and `fixtures/acp/opencode-1.18.15.json` |

## Unknowns frozen at discovery

- There is no stable third-party Agent Host registration proof.
- Stable UI has no explicit `sessionSettled` event.
- ACP active-turn permission exactness, questions, usage, diffs, tool metadata,
  and queue/steer/follow-up semantics are not provider-free observable.
- ACP companion tool schemas and MCP tool inventory have no discovery method in
  the recorded contract.
- Variant selection was not advertised for the isolated default ACP model.

These remain unknown until a later executable spike or explicit opt-in model
test proves them.
