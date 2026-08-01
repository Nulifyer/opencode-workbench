<div align="center">

<img src="https://raw.githubusercontent.com/Nulifyer/opencode-workbench/main/packages/vscode-extension/media/opencodeWorkbench.png" alt="OpenCode Workbench logo" width="128" height="128">

# OpenCode Workbench

Multi-session OpenCode chat and editor tools for VS Code.

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/nulifyer.opencode-workbench)](https://marketplace.visualstudio.com/items?itemName=nulifyer.opencode-workbench)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/nulifyer.opencode-workbench)](https://marketplace.visualstudio.com/items?itemName=nulifyer.opencode-workbench)
[![GitHub Release](https://img.shields.io/github/v/release/Nulifyer/opencode-workbench?logo=github)](https://github.com/Nulifyer/opencode-workbench/releases)

</div>

OpenCode Workbench connects VS Code to a shared OpenCode server. OpenCode still
owns models, agents, tools, permissions, sessions, and transcripts. Workbench
adds a VS Code-native workflow around them.

## Features

- Copilot-style chat in the Secondary Side Bar.
- Session switching from the chat header or expandable Sessions view.
- Background session status and unread indicators.
- Per-session agent, model, and draft state.
- Streaming responses, reasoning, tool activity, and stop controls.
- Native permission confirmations and terminal fallbacks.
- Editor-aware tools through the companion OpenCode plugin.
- A top-right editor action for opening chat.

## Requirements

- VS Code 1.106 or newer.
- OpenCode 1.18.8 or newer within major version 1.
- A reachable authenticated OpenCode server.
- An open workspace folder that maps to the server filesystem.

## Quick start

1. Install **OpenCode Workbench** from the Marketplace.
2. Start an authenticated OpenCode server:

   ```sh
   OPENCODE_SERVER_USERNAME=opencode \
   OPENCODE_SERVER_PASSWORD="replace-with-a-long-random-secret" \
   opencode serve --hostname 127.0.0.1 --port 4096
   ```

3. Run **OpenCode: Set Server Password** and enter the same password.
4. Open a workspace folder.
5. Click the OpenCode icon in the editor title bar or run
   **OpenCode: Open Chat**.
6. Press `Ctrl+Alt+N` to create a session.

The extension starts in the Secondary Side Bar. You can move its container or
individual views through the normal VS Code layout controls.

Pre-Marketplace `0.1.x` development builds used a different extension identity.
After upgrading, run **OpenCode: Set Server Password** again if the password was
stored only in VS Code Secret Storage. Installations using `server.env` retain
their credentials.

## Sessions and chat

Select the active session from the chat header. Expand the Sessions view for a
larger work queue showing busy, error, and unread state. Creating or selecting
a session keeps its transcript, draft, agent, and model independent from other
background sessions.

Choose the agent and model below the prompt. Press `Ctrl+Enter` to send. Use
**Stop** while OpenCode is working. Reasoning and tool output remain collapsible
so the conversation stays readable.

## Companion OpenCode plugin

Chat and session management connect directly to the OpenCode server. Install
the companion `opencode-plugin.js` release asset to enable preference memory,
skill candidates, and authenticated editor bridge tools.

Download the plugin from the latest
[GitHub release](https://github.com/Nulifyer/opencode-workbench/releases/latest),
save it at a stable path, and add its file URI to the global OpenCode config:

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/opencode-plugin.js"
  ]
}
```

Windows users can keep the plugin at
`%LOCALAPPDATA%\OpenCodeWorkbench\opencode-plugin.js`. Linux dotfiles users can
install and update the full integration with `./dotfiles workbench install`.

## Commands and keybindings

| Command | Default key | Purpose |
| --- | --- | --- |
| **OpenCode: Open Chat** | — | Opens and focuses the chat view. |
| **OpenCode: New Session** | `Ctrl+Alt+N` | Creates a session and opens chat. |
| **OpenCode: Show Sessions** | — | Opens the expanded session work queue. |
| **OpenCode: Refresh** | — | Reconciles sessions and status with the server. |
| **OpenCode: Abort Active Session** | — | Stops the active OpenCode request. |
| **OpenCode: Launch in Terminal** | — | Starts a terminal OpenCode client. |
| **OpenCode: Attach Terminal to Server** | — | Attaches a terminal to the shared server. |
| **OpenCode: Set Server Password** | — | Stores the HTTP password in Secret Storage. |

`Ctrl+Enter` sends the current prompt. All command keybindings can be changed
through **Preferences: Open Keyboard Shortcuts**.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `opencodeWorkbench.serverUrl` | `http://127.0.0.1:4096` | Shared OpenCode server URL. |
| `opencodeWorkbench.serverUsername` | Empty | HTTP Basic username override. |
| `opencodeWorkbench.serverEnvironmentFile` | `~/.config/opencode-workbench/server.env` | Owner-only credentials file on Unix systems. |
| `opencodeWorkbench.confirmPermissions` | `true` | Shows permission requests as modal confirmations. |

Plain HTTP is accepted only for numeric loopback addresses. Remote servers must
use HTTPS. Passwords cannot be stored in workspace settings.

## Security and privacy

The extension does not operate a model or copy transcripts into its own
database. It communicates with the configured OpenCode server. The local editor
bridge listens only on loopback, requires an ephemeral bearer token, validates
workspace containment, and exposes a fixed operation allowlist.

The chat webview has no network access. Messages cross a validated protocol and
Markdown is rendered with escaping before links are delegated back to VS Code.

See the [full project documentation](https://github.com/Nulifyer/opencode-workbench)
and [design notes](DESIGN.md) for architecture and trust boundaries.
