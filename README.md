# OpenCode Workbench

OpenCode Workbench adds a multi-session VS Code interface, editor-aware tools,
curated user preferences, and staged skill-improvement evidence while keeping
OpenCode as the only agent harness.

## Architecture

- OpenCode server owns models, agents, tools, permissions, sessions, and
  transcripts.
- The OpenCode plugin provides preference, skill-candidate, and VS Code bridge
  tools to terminal and editor clients.
- The VS Code extension provides session switching, chat UI, permission UX,
  and a loopback bridge to stable VS Code APIs.
- A terminal attached to the same OpenCode server sees the same active sessions
  and can call VS Code tools while a matching editor window is open.

The project does not implement a model loop, provider configuration, prompt
compiler, or independent session database.

## Packages

- `packages/vscode-extension`: Activity Bar session tree and chat view.
- `packages/opencode-plugin`: Shared preferences, skill candidates, evidence,
  and editor bridge tools.
- `packages/shared`: Typed protocol and multi-session reducer.

## Development

Requires Deno 2.9 or newer.

```sh
deno task check
deno task test
deno task package
```

Build artifacts are written to `dist/`:

- `opencode-plugin.js`
- `opencode-workbench-vscode-<version>.vsix`

Install the local build:

```sh
deno task install:local
```

This installs the plugin under
`~/.local/lib/opencode-workbench/<version>/`, updates the `current` symlink,
installs the VSIX through `code`, and creates an owner-only OpenCode server
environment file when one does not exist.

## OpenCode configuration

Use the stable installed plugin path:

```jsonc
{
  "plugin": [
    "file://{env:HOME}/.local/lib/opencode-workbench/current/opencode-plugin.js"
  ]
}
```

The plugin stores private runtime state under
`$XDG_DATA_HOME/opencode-workbench`, or `~/.local/share/opencode-workbench`.
No transcripts are copied into Workbench storage.

## Security

- OpenCode server must remain loopback-only and password-protected.
- The VS Code bridge uses an ephemeral 256-bit token and owner-only registry.
- Bridge requests are allowlisted, size-limited, workspace-contained, and do
  not accept shell command strings or arbitrary VS Code command IDs.
- Preferences require explicit user action and inferred preferences remain
  proposals until approved.
- Skill candidates never modify skill files automatically.

## Releases

Tags matching `v*` must match all package versions. The release workflow runs
checks from a clean checkout, builds the plugin and VSIX, creates a machine-
readable release manifest and checksums, generates GitHub build provenance,
and attaches all artifacts to the GitHub release.

Current releases support OpenCode 1.18.8 or newer within major version 1 and
VS Code 1.95 or newer. Build-time dependency updates do not raise the minimum
runtime version unless Workbench uses a newer API.

Dotfiles consumers track the stable release channel. Each install or update
resolves the newest stable release, verifies GitHub build provenance for every
artifact, validates the release manifest and checksums, checks local OpenCode
and VS Code compatibility, and installs the release side-by-side. A failed
health check restores the previous release. Previously installed versions
remain available through `./dotfiles workbench rollback VERSION`.
