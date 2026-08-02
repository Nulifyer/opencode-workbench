# VS Code Extension Design

## Identity

All extension-owned contribution IDs, command IDs, view IDs, context values, settings, and Secret Storage keys use the `opencodeWorkbench` namespace. User-facing text retains the OpenCode product name, and OpenCode HTTP endpoints and CLI commands are unchanged. This prevents collisions with `sst-dev.opencode` when both extensions are installed.

## Runtime

The extension host is the only UI backend. Managed mode resolves and validates
the installed OpenCode executable, starts `opencode serve` on loopback with an
available port and ephemeral credentials, and stops that process with the VS
Code window. Each extension host owns its server, which avoids cross-window
ports, credentials, and lifecycle state. External mode connects to a separately
managed server instead.

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

## UI Boundaries

The chat is the primary view in a Secondary Side Bar container. Its header has
a searchable session overlay. The same provider can open an editor-area
`WebviewPanel` with a Sessions, Changes, and Details rail. Both surfaces share
controller state and use a nonce-based content security policy with no network
access. Both directions use discriminated message schemas and runtime validators
from `@opencode-workbench/shared`.

Markdown is rendered by an escaping-first renderer. Raw HTML is never passed through. Only `http:` and `https:` links are emitted, and link opening is delegated to the extension host after a second protocol check.

OpenCode permission events are shown inline with their type, pattern, and metadata. Complete details are labeled exact; bounded metadata is marked incomplete and can only be rejected. Rejections can include native corrective feedback. The extension requires an explicit inline decision unless auto approval is enabled for that root session. New sessions start with auto approval disabled, and delegated subagents inherit their root session's mode.

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

`node esbuild.mjs` produces `dist/extension.cjs` and `media/chat.js` without
shipping source maps. The extension bundle excludes the host-provided `vscode`
module. The webview bundle includes only the pure shared message validator.

The package includes compiled output, media, README, design notes, and license files. Development sources are excluded from release packages through the package manifest's `files` list.
