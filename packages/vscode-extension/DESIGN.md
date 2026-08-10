# VS Code Extension Design

## Identity

All extension-owned contribution IDs, command IDs, view IDs, context values, settings, and Secret Storage keys use the `opencodeWorkbench` namespace. User-facing text retains the OpenCode product name, and OpenCode HTTP endpoints and CLI commands are unchanged. This prevents collisions with `sst-dev.opencode` when both extensions are installed.

## Runtime

OpenCode is the sole agent runtime and backend. It owns sessions, transcripts,
models, tools, prompts, child-session lineage, native PTYs, and execution. The
extension host is only the VS Code presentation and integration control plane;
it does not load a provider SDK, persist a parallel transcript, or run a second
agent loop. Managed mode resolves and validates the installed OpenCode
executable, starts `opencode serve` on loopback with an available port and
ephemeral credentials, and stops that process with the VS Code window. Each
extension host owns its server, which avoids cross-window ports, credentials,
and lifecycle state. External mode connects to a separately managed server
instead.

In a multi-root window, the user selects the workspace folder owned by the
Workbench runtime. Every OpenCode request includes that folder as the
`directory` query parameter. The client admits prompts through
`POST /api/session/:id/prompt` with stable message IDs and native `steer` or
`queue` delivery, then uses `/event` updates to maintain independent state for
every session. Reconnects refetch session metadata, statuses, catalogs, runtime
services, and transcripts that were previously loaded or remain busy.

Managed credentials remain in memory and are never written to settings or logs.
The bundled companion plugin is added through `OPENCODE_CONFIG_CONTENT` without
replacing disk configuration. External mode can read an owner-only credentials
file, and **OpenCode: Set External Server Password** stores an override in VS
Code Secret Storage. Endpoint settings use machine scope, passwords cannot be
stored in workspace settings, and non-loopback servers require HTTPS.

The companion plugin owns per-session goal tools, persistent goal state, and
idle continuation. When OpenCode emits `session.idle` for an active goal, the
plugin coalesces it with the canonical `session.status: idle` event, waits one
event-loop turn for a possible asynchronous failure event, atomically reserves
the next auto-turn, and submits the full continuation prompt through OpenCode's
asynchronous prompt API. Terminal, paused, cancelled, limited, and failed goals
do not admit another turn. Continuation messages carry bounded synthetic
metadata and render as timeline markers. The extension projects goal state and
provides edit, pause, resume, and cancel controls without running a competing
continuation loop. A missing native goal store can import compatible state once
from the former third-party goal store.

Independent verification remains a separate bounded OpenCode session with
tools disabled and auto-approval off. A verifier receives the objective,
criteria, bounded deterministic evidence, diff/diagnostic summaries, progress,
and remaining limits. Workbench retains bounded per-attempt session, model,
usage, cost, and outcome metadata when OpenCode reports it. Verification is
cancellable. Its structured verdict carries an expected settlement generation
into the plugin tool, so it is rejected even if the goal changes after prompt
admission but before tool execution; it remains advisory until the user applies
it through the plugin-owned goal state.

## Application boundaries

`SessionController` coordinates application services rather than owning their
state directly. `SessionRepository` owns reduced session state and
subscriptions; `CatalogService` owns model/agent catalogs and validated
preferences; `PromptDispatcher` owns admission generations, queued delivery,
and in-flight prompts; `SettlementCoordinator` owns pending operations and
settlement inputs; permission and question coordinators own their response
generations; `TranscriptReconciler` owns live/snapshot merge history; and
`SnapshotProjector` emits the bounded webview projection. Connection lifecycle
and ordered events remain separate session/protocol services.

The webview mirrors those boundaries with a capability-aware transport client
and request registry, a v1 compatibility adapter, a single state store,
composer/scroll/focus/overlay controllers, and focused conversation, queue,
session-list, inspector, and composer views. The extension host remains the
presentation-transport authority; a reloaded or hidden webview can only apply
matching epochs and revisions.

`TaskArtifactService` owns bounded, revisioned VS Code presentation/action
metadata for plans, reviews, goal verification, run comparison, and admitted
context capture. Every artifact is keyed to a canonical OpenCode session and,
when AI-authored, OpenCode producer provenance. It is not a transcript store:
plan objectives and Markdown bodies remain in OpenCode or the visible document,
raw diffs are not retained, and prompt/attachment bodies are rejected by the
artifact schema. `SessionPresentationService` similarly owns only bounded pins;
archive, sharing, lineage, status, and revert remain OpenCode state.

The Jobs feed is a read-only projection of OpenCode child sessions and native
PTYs together with bounded Workbench run/worktree metadata. Needs-input state is
derived from OpenCode questions and permissions. Canceling a PTY and
backgrounding child sessions call OpenCode's native endpoints; the feed never
becomes an extension-host scheduler or execution backend.

Stable mode intentionally remains HTTP/SSE. ADR 0003 defers native Agent Host
integration because a stable third-party registration and lossless ACP mapping
are not proven. The custom rail therefore progressively groups ordinary
sessions and Workbench RunGroups while OpenCode remains the sole session and
transcript authority.

## Session control and recovery

The session rail projects native OpenCode `parentID`, `share.url`,
`time.archived`, summary, and revert metadata. Share/unshare and archive invoke
OpenCode directly. Pinning is explicitly local presentation state. OpenCode
1.18.15 exposes an archive timestamp mutation but no proven clear/unarchive
contract, so unarchive remains feature-gated instead of being emulated locally.

Undo first builds a side-effect-free preview against an idle session, including
the exact transcript tail at the selected user-message boundary and the current
bounded changed-file summary. Apply revalidates the session and then calls
OpenCode's coupled transcript-and-file revert endpoint; redo is available only
while OpenCode reports a native revert marker. File totals are not claimed as
per-message attribution, and shell commands, external services, manual edits,
and other side effects can remain outside the recoverable boundary.

## Worktrees, runs, and review

Workbench is the sole owner of fallback worktrees. A durable metadata journal
records canonical repository identity, typed Git arguments, mutation ID, phase,
branch, worktree path, and OpenCode session/prompt IDs. It never records prompt
or attachment bodies. Recovery reconciles the journal with `git worktree list`;
cleanup refuses dirty worktrees and keeps worktree, branch, and session deletion
as independent user actions.

Linked worktrees share a bounded continuity registry at
`<git-common-dir>/opencode-workbench/handoff-continuity-v1.json`. The registry
contains only sanitized context receipts, deterministic evidence references,
target directory/session IDs, and source receipt IDs. It never contains prompt
text, attachment bytes, task output, diagnostics text, screenshots, or
credentials. Each real multi-run admission receives a receipt cloned onto its
actual session and prompt IDs instead of reusing the synthetic RunGroup
identity.

Continuity writes are ordered in each extension host, serialized across hosts
with an owner-only lock, fsynced, and atomically renamed. The metadata directory
is mode `0700` and the file is mode `0600` where the platform exposes POSIX
permissions. A write can be flushed before another workspace opens or before a
comparison/Fusion read. The registry is limited to 128 records and 2 MiB; each
record is limited to 20 receipts, 200 evidence references, 512 KiB, and a
30-day lifetime. It is stored only in the repository's Git common directory,
not in a checkout or sibling working-tree path.

RunGroups store only references required to reconnect model sessions and
worktrees. Multi-run isolates partial failure and cancellation, and never merges
results. Fusion copies bounded exact diffs, diff manifests, objective comparison
rows, deterministic evidence, assistant summaries, source-session links, and
hashed provenance into a new isolated synthesis session; it never merges,
cherry-picks, pushes, or publishes automatically. Walkthrough and review documents are keyed
to an exact diff hash, and native navigation recaptures and validates that hash
before opening an anchor.

Run comparison is an objective evidence matrix: phase, exact diff totals,
deterministic task/diagnostic/verifier outcomes, usage/cost when OpenCode reports
them, blockers, and source actions. It deliberately assigns no score and chooses
no AI winner. Users keep, discard, inspect, or explicitly send bounded sources
to a new OpenCode Fusion session.

## UI Boundaries

The chat is the primary view in a Secondary Side Bar container. Its header has
a searchable session overlay. The same provider can open a two-column editor
surface: session work on the left and a resizable Sessions list on the right.
Plans, goals, changes/results, current jobs, context, and health appear as
contextual cards within session work instead of a permanent third pane or tab
rail. Both surfaces share controller state and use a nonce-based content
security policy with no network access. Both directions use discriminated
message schemas and runtime validators from `@opencode-workbench/shared`.

Markdown is rendered by an escaping-first renderer. Raw HTML is never passed through. Only `http:` and `https:` links are emitted, and link opening is delegated to the extension host after a second protocol check.

OpenCode permission events are shown inline with their type, pattern, and metadata. Complete details are labeled exact; bounded metadata is marked incomplete and can only be rejected. Rejections can include native corrective feedback. The extension requires an explicit inline decision unless auto approval is enabled for that root session. New sessions start with auto approval disabled, and delegated subagents inherit their root session's mode.

Clipboard images and PDFs use ordered prompt anchors while retaining visual
attachment cards and private in-memory payloads. Large text pastes become
collapsible text attachments with model-visible references. Pending payloads
are synchronized between the sidebar and editor webviews but remain outside
snapshots and persistent VS Code state. User-message snapshots continue to
exclude attachment URLs and base64 data.

Context receipts persist only bounded metadata: kind, label, contained URI or
range where applicable, revision/hash, byte/token estimate, and explicit
truncation. Browser/debug capture, editor selection, console text, inspected
element metadata, screenshots, GitHub selection, and Fusion source files are
one-shot in-memory prompt attachments. Workbench does not persist their bytes,
does not proxy browser traffic, and does not own GitHub credentials. Browser
screenshot and clipboard bytes are discarded from Workbench memory after prompt
admission; only sanitized receipt/source metadata can become a context-capture
artifact.

Deterministic evidence references are retained in workspace state so a goal's
evidence IDs still resolve after an extension-host reload. Entries contain only
bounded source/session/run identifiers and controlled summaries such as task
exit codes, repository-scoped diagnostic count deltas, and exact diff hashes;
task output and diagnostic message text are not persisted.

When a task crosses into a linked worktree, the admitted receipt and controlled
evidence metadata are explicitly exported to the Git-common-dir continuity
registry and imported idempotently by ID. Obvious credential forms are redacted;
unsafe or credential-bearing receipt URIs are omitted. Per-workspace state
remains the local projection, while the private registry is the crash-safe
cross-workspace handoff authority.

Automated accessibility tests enforce semantic roles, focus behavior, reduced
motion, forced colors, and keyboard reachability. They do not establish actual
speech output. A manual release smoke with NVDA, VoiceOver, or Orca is still
required and must not be reported as complete from headless tests alone.

## Bridge

The extension starts an HTTP server bound to `127.0.0.1` on an ephemeral port. Requests require a random 256-bit bearer token and an authenticated `POST /` protocol envelope. The registry is written atomically to `$XDG_DATA_HOME/opencode-workbench/bridges/registry.json`, or `~/.local/share/opencode-workbench/bridges/registry.json` when `XDG_DATA_HOME` is unset. The registry directory is mode `0700`, and the file is mode `0600`.

The extension refreshes its registry entry every five seconds. Entries become stale after 30 seconds. Managed servers receive the exact bridge ID for their VS Code window. External servers reject ambiguous same-worktree routing instead of selecting another window by heartbeat time. Disposal stops the heartbeat and removes only the current extension instance's entry.

The allowlisted operations are:

| Operation | Behavior |
| --- | --- |
| `vscode_list_open_editors` | Lists worktree-contained text and diff editors. |
| `vscode_get_selection` | Returns the active worktree selection. |
| `vscode_get_active_buffer` | Returns bounded selection, visible-range, or document text from the last active worktree editor, including unsaved changes. |
| `vscode_get_definitions` | Returns contained definition locations from VS Code language providers. |
| `vscode_get_references` | Returns contained reference locations from VS Code language providers. |
| `vscode_get_symbols` | Returns bounded document symbols from VS Code language providers. |
| `vscode_get_diagnostics` | Returns bounded worktree diagnostics. |
| `vscode_open_file` | Opens a realpath-contained file. |
| `vscode_get_debug_context` | Returns the active debug session, a bounded contained stack, and worktree breakpoints. |
| `vscode_execute_terminal` | Executes an executable and argument array through terminal shell integration. |
| `vscode_list_tasks` | Lists bounded task metadata scoped to the selected workspace root. |
| `vscode_run_task` | Starts one root-scoped task matched unambiguously by name and source. |
| `vscode_get_code_actions` | Previews code actions and contained text edits without executing commands. |
| `vscode_preview_rename` | Previews contained text edits from a rename provider without applying them. |
| `vscode_open_url` | Opens an `http:` or `https:` URL. |
| `vscode_request_opencode_reload` | Requests one managed reload after the requesting session becomes idle; the tool returns before reload starts. |

The bridge does not accept caller-provided VS Code command IDs, apply provider edits, invoke `child_process`, or use `shell: true`. Language-provider command IDs are fixed in extension code. Requests, responses, context, and filesystem paths are bounded and validated.

Managed mode advertises `vscode_request_opencode_reload`. The request requires
explicit approval, pauses new prompt admission, waits for the requesting session
to become idle, disposes and reconnects the OpenCode workspace instance, and
restores the selected session. External mode omits this bridge capability. The
operation cannot restart OpenCode synchronously from its own tool call.

## Build Layout

The root `deno task build` command is canonical. The package-local build command
delegates to that same builder so a package build cannot omit the managed
companion plugin. It produces `dist/extension.cjs`, `media/chat.js`, and the
bundled `dist/opencode-plugin.js` without shipping source maps. The extension
bundle excludes the host-provided `vscode` module. The webview bundle includes
only the pure shared message validator.

The package includes compiled output, media, README, design notes, and license files. Development sources are excluded from release packages through the package manifest's `files` list.
