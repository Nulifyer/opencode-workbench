# Changelog

## Unreleased

## 0.1.1 - 2026-08-01

### Changed

- Updated OpenCode plugin compatibility to 1.18.9.
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
