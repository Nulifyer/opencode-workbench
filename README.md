# OpenCode Workbench

OpenCode Workbench is a VS Code interface for an installed
[OpenCode](https://opencode.ai) runtime. It adds multi-session chat,
editor-aware tools, permission prompts, approved preferences, and staged skill
evidence without introducing another agent runtime.

OpenCode remains responsible for models, agents, tools, permissions, sessions,
and transcripts. Workbench provides the editor experience around that runtime.

## What it provides

- A Copilot-style chat view in the VS Code Secondary Side Bar.
- Searchable session history in the chat header and an editor-area Sessions rail.
- Background session status and unread indicators.
- Agent and model selection for each session, using OpenCode's resolved provider
  catalog, model capabilities, variants, and token limits.
- Streaming responses, reasoning sections, tool activity, and abort controls.
- Anchored image and PDF attachments, collapsible large-paste context, previews,
  and synchronized pending composer payloads across chat surfaces.
- Per-message copy, edit, retry, undo, and message-scoped fork actions.
- Plugin-owned auto-continuation for active goals, with persistent limits and controls.
- Inline permission requests with exact scope details and explicit decisions.
- Editor context tools for selections, unsaved buffers, notebooks, diagnostics,
  files, debugging, terminals, tasks, MCP resources, and approved URLs.
- Explicitly approved global and project preferences.
- Staged skill candidates that never modify skill files automatically.
- A terminal command that launches the normal OpenCode TUI.

The project does not implement its own model loop, provider configuration,
prompt compiler, or transcript database.

## Components

- `packages/vscode-extension` contains the VS Code session and chat interface.
- `packages/opencode-plugin` contains native goals, preferences, skill
  candidates, and the authenticated VS Code bridge tools.
- `packages/shared` contains the validated protocol and multi-session state.

Managed mode bundles and loads the companion plugin for preference,
goal, skill-candidate, and editor bridge tools.

## Requirements

- OpenCode 1.18.11 or newer within major version 1.
- VS Code 1.106 or newer.
- A trusted workspace folder.

## Install the VS Code extension

Install **OpenCode Workbench** from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=nulifyer.opencode-workbench),
or install the verified VSIX attached to the latest
[GitHub release](https://github.com/Nulifyer/opencode-workbench/releases/latest).

The Marketplace extension ID is `nulifyer.opencode-workbench`.

Managed mode is the default. The extension finds `opencode` on VS Code's
`PATH`, validates its version, and starts a private authenticated loopback
server for the current VS Code window. The bundled companion plugin is added to
that process without modifying the user's OpenCode configuration.

## External server mode

Set `opencodeWorkbench.serverMode` to `external` to use a separately managed or
remote OpenCode server. Start the server with authentication:

Linux or macOS:

```sh
export OPENCODE_SERVER_USERNAME=opencode
export OPENCODE_SERVER_PASSWORD="replace-with-a-long-random-secret"
opencode serve --hostname 127.0.0.1 --port 4096
```

Windows PowerShell:

```powershell
$env:OPENCODE_SERVER_USERNAME = "opencode"
$env:OPENCODE_SERVER_PASSWORD = "replace-with-a-long-random-secret"
opencode serve --hostname 127.0.0.1 --port 4096
```

Run **OpenCode: Set External Server Password** in VS Code and enter the same
password. The password is stored in VS Code Secret Storage, not workspace
settings.

## Use Workbench

1. Open a workspace folder.
2. Run **OpenCode: Open Chat** or open the OpenCode view from the Secondary Side
   Bar.
3. Create a session with the view title action or `Ctrl+Alt+N`.
4. Select or search sessions from the chat header. Run **OpenCode: Open Chat in
   Editor** for the Sessions, Changes, and Details rail.
5. Choose an agent and model in the composer, enter a prompt, and press `Enter`
   to send. Use `Shift+Enter` for a newline; `Ctrl+Enter` also sends.

The model picker shows only providers and models resolved by the connected
OpenCode instance. OpenCode reports how each provider was configured, model
capabilities, variants, and advertised context/input/output limits. It does not
report provider subscription tiers, so Workbench does not infer a plan from a
provider ID or credential.

The chat view starts in the Secondary Side Bar so Explorer, Search, and source
control remain available on the left. VS Code still allows moving the OpenCode
container or individual views.

The terminal experience remains the normal OpenCode TUI through **OpenCode:
Launch in Terminal** or the `opencode` command.

### Continue an active goal automatically

Create an active goal with `/goal <objective>` or the goal tools. Use
`/goal-unlimited <objective>` to explicitly create one without token, duration,
or auto-turn limits; typing `/goal` in the chat input surfaces both commands.
When the model finishes a turn and OpenCode would otherwise wait for more user
input, the bundled companion plugin submits the complete goal-continuation
prompt. It keeps doing so while the goal is `active`, until the model verifies
completion, records a concrete blocker, or reaches a configured goal limit.

The plugin atomically persists each admitted continuation before prompting. It
does not replace OpenCode's normal post-compaction continuation, approve
permissions, or bypass destructive-action safeguards. Prompt-admission failures
pause the goal instead of retrying indefinitely. Automatic prompts appear as
**Goal continued automatically** timeline markers rather than user messages.

Use the goal bar or `/goal edit`, `/goal pause`, `/goal resume`, and `/goal
cancel` to control the goal. Token, duration, and auto-turn limits stored on the
goal remain authoritative.

Goal tools and `/goal` are provided by the bundled Workbench companion plugin;
no third-party goal plugin is required. On first managed startup, Workbench
imports compatible state from
`$XDG_DATA_HOME/opencode-goal-plugin/goals.json` when its native goal store does
not yet exist. Native state is stored in
`$XDG_DATA_HOME/opencode-workbench/plugin/goals.json`.

## VS Code settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `opencodeWorkbench.serverMode` | `managed` | Starts a private server or connects to an external server. |
| `opencodeWorkbench.executablePath` | Empty | Optional absolute OpenCode executable path for managed mode. |
| `opencodeWorkbench.managedServerStartupTimeout` | `120` | Seconds to wait for managed-server version checks and startup. Increase this on systems slowed by antivirus scanning. |
| `opencodeWorkbench.serverUrl` | `http://127.0.0.1:4096` | External server URL. |
| `opencodeWorkbench.serverUsername` | Empty | External HTTP Basic username override. |
| `opencodeWorkbench.serverEnvironmentFile` | `~/.config/opencode-workbench/server.env` | Optional external credentials file on Unix systems. |

Plain HTTP is accepted only for numeric loopback addresses. Remote servers must
use HTTPS. Passwords cannot be stored in workspace settings.

## Security model

- Managed OpenCode servers bind to loopback, use ephemeral random credentials,
  and stop with their VS Code window.
- The VS Code bridge uses an ephemeral 256-bit token and an owner-only registry.
- Bridge requests are allowlisted, size-limited, and workspace-contained.
- The bridge does not accept shell command strings or arbitrary VS Code command
  IDs.
- The chat webview has no network access and uses a nonce-based content security
  policy with escaping-first Markdown rendering.
- Preferences require explicit approval, and inferred preferences remain
  proposals until approved.
- Skill candidates never modify skill files automatically.

See [`packages/vscode-extension/DESIGN.md`](packages/vscode-extension/DESIGN.md)
for protocol and trust-boundary details. See
[`SKILL-LIFECYCLE.md`](SKILL-LIFECYCLE.md) for the reviewed skill-development,
activation, reload, session-continuity, and memory design.

## Development

Development requires Deno 2.9 or newer.

```sh
deno task check
deno task test:synthetic
deno task package
```

The test tasks are layered so feature work can select the smallest useful
suite. See [`TESTING.md`](TESTING.md) for invariants and the feature checklist.

| Task | Coverage |
| --- | --- |
| `deno task test:synthetic` | All deterministic unit, protocol, mocked HTTP/SSE, controller, packaging, and stress tests. This is the default `test` task. |
| `deno task test:integration:synthetic` | Goal-plugin hook and persistence, mocked HTTP/SSE, managed-process, and end-to-end event-pipeline integration tests. |
| `deno task test:stress` | Ordered event-bus and parser-to-controller backpressure tests with 20,000-event bursts. |
| `deno task test:stress:repeat` | Runs each stress test five times to detect timing-sensitive regressions. |
| `deno task test:integration:real` | Starts an installed OpenCode server and validates live contracts plus bundled goal command/tool discovery without a model request. |

Run the real integration suite against an installed `1.18.11` executable. The
suite starts an authenticated server in a temporary workspace and exercises
health, SSE, session, fork, history, and deletion contracts without sending a
model prompt. Real integration is intentionally excluded from the deterministic
default suite.

```sh
OPENCODE_INTEGRATION_EXECUTABLE=/absolute/path/to/opencode deno task test:integration:real
```

Set `OPENCODE_INTEGRATION_VERSION` when validating another explicitly supported
version. `deno task test:opencode` remains an alias for the real integration
suite.

Install a local build:

```sh
deno task install:local
```

Local installs use a timestamped prerelease of the next patch, such as
`0.3.1-dev.20260803.t040506`, so VS Code clearly distinguishes them from the
current and next stable Marketplace versions.

Generated artifacts are written to `dist/`.

## Releases

Tags matching `v*` must match all package versions. Release CI checks, tests,
builds, and packages from a clean checkout. It generates a compatibility
manifest and checksums, records GitHub build provenance, uploads GitHub release
assets, and can publish the same verified VSIX to the Visual Studio Marketplace.

Build-time dependency updates do not raise the minimum supported OpenCode
runtime unless Workbench uses a newer API.
