<div align="center">

<img src="https://raw.githubusercontent.com/Nulifyer/opencode-workbench/main/packages/vscode-extension/media/opencodeWorkbench.png" alt="OpenCode Workbench logo" width="128" height="128">

# OpenCode Workbench

Multi-session OpenCode chat and editor tools for VS Code.

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/nulifyer.opencode-workbench)](https://marketplace.visualstudio.com/items?itemName=nulifyer.opencode-workbench)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/nulifyer.opencode-workbench)](https://marketplace.visualstudio.com/items?itemName=nulifyer.opencode-workbench)
[![GitHub Release](https://img.shields.io/github/v/release/Nulifyer/opencode-workbench?logo=github)](https://github.com/Nulifyer/opencode-workbench/releases)

</div>

OpenCode Workbench starts a private server from the user's OpenCode installation
and adds a VS Code-native workflow around its models, agents, tools,
permissions, sessions, and transcripts.

## Features

- Copilot-style chat in the Secondary Side Bar.
- Searchable session history in the chat header and an editor-area Sessions rail.
- Background session status and unread indicators.
- Per-session agent, model, reasoning variant, and synchronized draft state.
- Streaming responses, reasoning, tool activity, and stop controls.
- Inline permission decisions with exact request details and optional rejection
  feedback.
- Editor-aware tools through the companion OpenCode plugin.
- Image, PDF, workspace, current-editor, untitled-buffer, notebook, agent, and
  MCP-resource context.

## Requirements

- VS Code 1.106 or newer.
- OpenCode 1.18.11 or newer within major version 1.
- A trusted workspace folder.

## Quick start

1. Install and configure OpenCode.
2. Install **OpenCode Workbench** from the Marketplace.
3. Open a trusted workspace folder.
4. Run **OpenCode: Open Chat** or open the OpenCode view from the Secondary Side
   Bar.
5. Press `Ctrl+Alt+N` to create a session.

The extension starts in the Secondary Side Bar. You can move its container or
individual views through the normal VS Code layout controls.

Managed mode finds `opencode` on VS Code's `PATH`, validates its version, starts
an authenticated loopback server on an available port, and loads the bundled
companion plugin. It does not modify the user's OpenCode configuration.

## Sessions and chat

Select or search for the active session from the chat header. Run **OpenCode:
Open Chat in Editor** for a larger Sessions, Changes, and Details rail. Creating
or selecting a session keeps its transcript, draft, agent, and model independent
from other background sessions.

Choose the agent, approval mode, and model below the prompt. Press `Enter` to
send, `Shift+Enter` for a newline, or `Ctrl+Enter` for compatibility. Sending
while OpenCode is working uses OpenCode's durable queue delivery. Reasoning and
tool output remain collapsible so the conversation stays readable.

The model picker is populated from OpenCode's resolved provider catalog. It
shows advertised context, input, and output limits, capability metadata, and
provider-specific variants. OpenCode does not expose account subscription tiers,
so the extension labels providers as configured rather than claiming a verified
plan. The last user-selected model and reasoning level persist across projects
and windows. An explicit model configured for the selected agent takes
precedence, followed by the global selection and then OpenCode's default.

## External server mode

Set `opencodeWorkbench.serverMode` to `external` to connect to an existing
loopback or remote HTTPS server. Configure its URL and username, then run
**OpenCode: Set External Server Password**. External mode does not inject the
bundled companion plugin into the independently managed server.

## Commands and keybindings

| Command | Default key | Purpose |
| --- | --- | --- |
| **OpenCode: Open Chat** | — | Opens and focuses the chat view. |
| **OpenCode: Open Chat in Editor** | — | Opens chat with the Sessions, Changes, and Details rail. |
| **OpenCode: New Session** | `Ctrl+Alt+N` | Creates a session and opens chat. |
| **OpenCode: Refresh** | — | Reloads the OpenCode workspace instance, provider catalog, sessions, and runtime status. |
| **OpenCode: Abort Active Session** | — | Stops the active OpenCode request. |
| **OpenCode: Launch in Terminal** | — | Starts a terminal OpenCode client. |
| **OpenCode: Set External Server Password** | — | Stores the external HTTP password in Secret Storage. |

Composer shortcuts are handled while the prompt has focus. Command keybindings
can be changed through **Preferences: Open Keyboard Shortcuts**.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `opencodeWorkbench.serverMode` | `managed` | Starts a private server or connects to an external server. |
| `opencodeWorkbench.executablePath` | Empty | Optional absolute OpenCode executable path for managed mode. |
| `opencodeWorkbench.serverUrl` | `http://127.0.0.1:4096` | External server URL. |
| `opencodeWorkbench.serverUsername` | Empty | External HTTP Basic username override. |
| `opencodeWorkbench.serverEnvironmentFile` | `~/.config/opencode-workbench/server.env` | Optional external credentials file. |

Plain HTTP is accepted only for numeric loopback addresses. Remote servers must
use HTTPS. Passwords cannot be stored in workspace settings.

## Security and privacy

The extension does not operate a model or copy transcripts into its own
database. Managed server credentials remain in memory and differ for each VS
Code window. The local editor bridge listens only on loopback, requires an
ephemeral bearer token, validates workspace containment, and exposes a fixed
operation allowlist.

The chat webview has no network access. Messages cross a validated protocol and
Markdown is rendered with escaping before links are delegated back to VS Code.

See the [full project documentation](https://github.com/Nulifyer/opencode-workbench)
and [design notes](DESIGN.md) for architecture and trust boundaries.
