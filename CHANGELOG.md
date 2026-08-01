# Changelog

## Unreleased

## 0.2.0 - 2026-08-01

### Added

- Added a Secondary Side Bar chat container, editor-title chat action, compact
  session switcher, and `Ctrl+Alt+N` new-session keybinding.
- Added Visual Studio Marketplace metadata and verified release publication.

### Changed

- Redesigned chat around VS Code's built-in Copilot interaction patterns while
  preserving multi-session state, agent and model selection, tool output,
  permissions, terminal fallbacks, and background sessions.
- Kept the native Sessions work queue as a collapsed secondary view instead of
  consuming most of the chat surface.
- Raised the minimum VS Code version to 1.106 for stable extension-owned
  Secondary Side Bar placement.
- Changed the extension identity from the development-only
  `opencode-workbench.opencode-workbench-vscode` ID to the Marketplace ID
  `nulifyer.opencode-workbench`.
- Expanded Linux, macOS, and Windows installation and usage documentation.

## 0.1.2 - 2026-08-01

### Fixed

- Declared runtime compatibility independently from the build-time OpenCode
  plugin dependency, restoring support for OpenCode 1.18.8 and newer releases
  within major version 1.

## 0.1.1 - 2026-08-01

### Changed

- Updated the OpenCode plugin build dependency to 1.18.9.
- Updated the release toolchain to TypeScript 6.0, esbuild 0.28, and VSCE 3.9.

### Fixed

- Release verification now exercises the dependency versions declared by the
  repository instead of separate hardcoded versions.

## 0.1.0 - 2026-08-01

### Added

- Added multi-session VS Code client for a shared OpenCode server.
- Added editor bridge tools available through the OpenCode plugin.
- Added scoped preference memory with explicit approval and forgetting.
- Added staged skill-candidate and bounded evidence storage.
- Added stable-channel installation, verified updates, and rollback support for
  dotfiles consumers.

### Security

- Added loopback-only editor bridge authentication, workspace containment,
  owner-only credential storage, explicit permission prompts, release
  provenance, and artifact checksum verification.
