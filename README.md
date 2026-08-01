# OpenCode Workbench

OpenCode Workbench is a VS Code interface and companion plugin for a shared
[OpenCode](https://opencode.ai) server. It adds multi-session chat, editor-aware
tools, permission prompts, approved preferences, and staged skill evidence
without introducing another agent runtime.

OpenCode remains responsible for models, agents, tools, permissions, sessions,
and transcripts. Workbench provides the editor experience around that runtime.

## What it provides

- A Copilot-style chat view in the VS Code Secondary Side Bar.
- Session switching from the chat header or an optional native Sessions view.
- Background session status and unread indicators.
- Agent and model selection for each session.
- Streaming responses, reasoning sections, tool activity, and abort controls.
- Native VS Code permission confirmations for OpenCode tool requests.
- Editor context tools for selections, diagnostics, files, debugging, terminals,
  and approved URLs.
- Explicitly approved global and project preferences.
- Staged skill candidates that never modify skill files automatically.
- Terminal commands that launch or attach OpenCode to the same shared server.

The project does not implement its own model loop, provider configuration,
prompt compiler, or transcript database.

## Components

- `packages/vscode-extension` contains the VS Code session and chat interface.
- `packages/opencode-plugin` contains preferences, skill candidates, and the
  authenticated VS Code bridge tools.
- `packages/shared` contains the validated protocol and multi-session state.

The VS Code extension can display and manage OpenCode sessions by itself. The
companion plugin is required for preference, skill-candidate, and editor bridge
tools.

## Requirements

- OpenCode 1.18.8 or newer within major version 1.
- VS Code 1.106 or newer.
- A workspace folder that is visible to both VS Code and the OpenCode server.
- A loopback OpenCode server for the default local setup.

## Install the VS Code extension

Install **OpenCode Workbench** from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=nulifyer.opencode-workbench),
or install the verified VSIX attached to the latest
[GitHub release](https://github.com/Nulifyer/opencode-workbench/releases/latest).

The Marketplace extension ID is `nulifyer.opencode-workbench`.

Pre-Marketplace `0.1.x` VSIX builds used a different extension identity. The
verified installer removes that legacy build during upgrade. If its password
was stored only in VS Code Secret Storage, run **OpenCode: Set Server Password**
once after upgrading. Unix installations that use `server.env` keep working
without credential migration.

## Install the companion plugin

Download `opencode-plugin.js` from the latest GitHub release and keep it at a
stable local path. Add that file URI to the global OpenCode configuration:

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/opencode-plugin.js"
  ]
}
```

Linux dotfiles users can run:

```sh
./dotfiles workbench install
```

That path verifies GitHub provenance and checksums, installs releases
side-by-side, configures the shared service, and supports rollback.

### Windows plugin path

A convenient Windows location is
`%LOCALAPPDATA%\OpenCodeWorkbench\opencode-plugin.js`. Download the latest
asset in PowerShell:

```powershell
$root = Join-Path $env:LOCALAPPDATA "OpenCodeWorkbench"
New-Item -ItemType Directory -Force $root | Out-Null
Invoke-WebRequest `
  "https://github.com/Nulifyer/opencode-workbench/releases/latest/download/opencode-plugin.js" `
  -OutFile (Join-Path $root "opencode-plugin.js")
```

Then add the resulting absolute file URI to the global OpenCode configuration.

## Start the shared OpenCode server

Workbench expects an authenticated server at `http://127.0.0.1:4096` by
default.

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

Run **OpenCode: Set Server Password** in VS Code and enter the same password.
The password is stored in VS Code Secret Storage, not workspace settings.

## Use Workbench

1. Open a workspace folder.
2. Click the OpenCode icon in the editor title bar or run
   **OpenCode: Open Chat**.
3. Create a session with the view title action or `Ctrl+Alt+N`.
4. Select a session from the chat header. Expand the Sessions view for a larger
   work queue with status and unread indicators.
5. Choose an agent and model in the composer, enter a prompt, and press
   `Ctrl+Enter` to send.

The chat view starts in the Secondary Side Bar so Explorer, Search, and source
control remain available on the left. VS Code still allows moving the OpenCode
container or individual views.

Terminal fallbacks remain available through **OpenCode: Launch in Terminal**
and **OpenCode: Attach Terminal to Server**.

## VS Code settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `opencodeWorkbench.serverUrl` | `http://127.0.0.1:4096` | Shared OpenCode server URL. |
| `opencodeWorkbench.serverUsername` | Empty | HTTP Basic username override. |
| `opencodeWorkbench.serverEnvironmentFile` | `~/.config/opencode-workbench/server.env` | Owner-only credentials file on Unix systems. |
| `opencodeWorkbench.confirmPermissions` | `true` | Shows OpenCode permission requests as modal confirmations. |

Plain HTTP is accepted only for numeric loopback addresses. Remote servers must
use HTTPS. Passwords cannot be stored in workspace settings.

## Security model

- The OpenCode server remains loopback-only and password-protected by default.
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
for protocol and trust-boundary details.

## Development

Development requires Deno 2.9 or newer.

```sh
deno task check
deno task test
deno task package
```

Install a local build:

```sh
deno task install:local
```

Generated artifacts are written to `dist/`.

## Releases

Tags matching `v*` must match all package versions. Release CI checks, tests,
builds, and packages from a clean checkout. It generates a compatibility
manifest and checksums, records GitHub build provenance, uploads GitHub release
assets, and can publish the same verified VSIX to the Visual Studio Marketplace.

Build-time dependency updates do not raise the minimum supported OpenCode
runtime unless Workbench uses a newer API.
