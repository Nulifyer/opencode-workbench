# VS Code Extension Design

## Identity

All extension-owned contribution IDs, command IDs, view IDs, context values, settings, and Secret Storage keys use the `opencodeWorkbench` namespace. User-facing text retains the OpenCode product name, and OpenCode HTTP endpoints and CLI commands are unchanged. This prevents collisions with `sst-dev.opencode` when both extensions are installed.

## Runtime

The extension host is the only UI backend. It talks directly to the configured OpenCode server over HTTP and authenticated server-sent events. It does not start, embed, or proxy an OpenCode process.

Every OpenCode request includes the first workspace folder as the `directory` query parameter. The client sends prompts through `POST /session/:id/prompt_async`, then uses `/event` updates to maintain independent state for every session. Reconnects refetch session metadata, statuses, and transcripts that were previously loaded or remain busy.

The extension reads shared server credentials from an owner-only environment
file. The `OpenCode: Set Server Password` command can override its password in
VS Code Secret Storage. Endpoint settings use machine scope, passwords cannot
be stored in workspace settings, and non-loopback servers require HTTPS.

## UI Boundaries

The session list is a native `TreeView`. The chat is a `WebviewView` with a nonce-based content security policy and no network access. Both directions use discriminated message schemas and runtime validators from `@opencode-workbench/shared`.

Markdown is rendered by an escaping-first renderer. Raw HTML is never passed through. Only `http:` and `https:` links are emitted, and link opening is delegated to the extension host after a second protocol check.

OpenCode permission events are shown as modal VS Code confirmations. Dismissing a prompt rejects it, preventing an unattended request from remaining blocked.

## Bridge

The extension starts an HTTP server bound to `127.0.0.1` on an ephemeral port. Requests require a random 256-bit bearer token and an authenticated `POST /` protocol envelope. The registry is written atomically to `$XDG_DATA_HOME/opencode-workbench/bridges/registry.json`, or `~/.local/share/opencode-workbench/bridges/registry.json` when `XDG_DATA_HOME` is unset. The registry directory is mode `0700`, and the file is mode `0600`.

The extension refreshes its registry entry every five seconds. Entries become stale after 30 seconds. Disposal stops the heartbeat and removes only the current extension instance's entry.

The allowlisted operations are:

| Operation | Behavior |
| --- | --- |
| `vscode_list_open_editors` | Lists worktree-contained text and diff editors. |
| `vscode_get_selection` | Returns the active worktree selection. |
| `vscode_get_diagnostics` | Returns bounded worktree diagnostics. |
| `vscode_open_file` | Opens a realpath-contained file. |
| `vscode_get_debug_context` | Returns the active debug session and worktree breakpoints. |
| `vscode_execute_terminal` | Executes an executable and argument array through terminal shell integration. |
| `vscode_open_url` | Opens an `http:` or `https:` URL. |

The bridge does not expose `vscode.commands.executeCommand`, accept VS Code command IDs, invoke `child_process`, or use `shell: true`. Requests, responses, context, and filesystem paths are bounded and validated.

## Build Layout

`node esbuild.mjs` produces `dist/extension.cjs` and `media/chat.js`. The extension bundle excludes the host-provided `vscode` module. The webview bundle includes only the pure shared message validator.

The package includes compiled output, media, README, design notes, and license files. Development sources are excluded from release packages through the package manifest's `files` list.
