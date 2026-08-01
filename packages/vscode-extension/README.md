# OpenCode Workbench for VS Code

OpenCode Workbench adds a native session tree and chat view for a shared OpenCode HTTP server. It can run alongside the official `sst-dev.opencode` extension because all extension-owned identifiers use the `opencodeWorkbench` namespace.

## Requirements

- VS Code 1.95 or newer.
- A reachable OpenCode server, such as `opencode serve`.
- An open workspace folder that maps to the server's filesystem.

## Configuration

Configure these settings in VS Code:

| Setting | Default | Purpose |
| --- | --- | --- |
| `opencodeWorkbench.serverUrl` | `http://127.0.0.1:4096` | Shared OpenCode server URL. |
| `opencodeWorkbench.serverUsername` | Empty | HTTP Basic username override. |
| `opencodeWorkbench.serverEnvironmentFile` | `~/.config/opencode-workbench/server.env` | Owner-only shared server credentials. |
| `opencodeWorkbench.confirmPermissions` | `true` | Shows OpenCode permission requests as modal confirmations. |

Use **OpenCode: Set Server Password** to override the environment-file password
through VS Code Secret Storage. Passwords cannot be stored in workspace
settings. Plain HTTP is accepted only for numeric loopback addresses; remote
servers require HTTPS.

## Usage

Open the OpenCode Activity Bar container to create, select, and delete sessions. The chat view loads the selected transcript, sends prompts asynchronously, and continues tracking background sessions when you switch.

The **OpenCode: Launch in Terminal** and **OpenCode: Attach Terminal to Server** commands remain available as terminal fallbacks.

## Security

The chat webview uses a strict content security policy and escaping-first Markdown rendering. The local VS Code bridge listens only on loopback, requires a random bearer token, validates worktree containment, and advertises only its fixed operation allowlist.

See [DESIGN.md](DESIGN.md) for protocol and architecture details.

## Development

The package build command produces `dist/extension.cjs` and `media/chat.js`:

```sh
npm run build
```

Do not publish the package without those generated files.
