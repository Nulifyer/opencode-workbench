# Changelog

## Unreleased

### Added

- Added queued follow-up prompts, `Enter` submission, inline permission and
  question handling, and a visible Ask or Auto approval mode.
- Added searchable session history and an editor-area chat with Sessions,
  Changes, and Details rails.
- Added session-specific changed-file summaries, patch review, native file
  opening, goal and todo status, context usage, cost, VCS, LSP, formatter, and
  MCP information.
- Added session rename, fork, undo, redo, compact, share, unshare, export, and
  slash-command workflows.
- Added model-specific reasoning selection and separate context-limit display.
- Added live delegated-task progress with recent child actions, expandable full
  activity, readable task details, and temporary full-size child-session details with
  back navigation.
- Added native slash-command autocomplete, searchable session actions, transcript
  copy commands, display controls, and sidebar-to-editor switching.
- Added copy controls to fenced code and inline diff blocks.
- Added parent-chat handling for permission and question requests raised by
  delegated subagents.
- Added managed server mode, which validates the installed OpenCode executable,
  starts a private authenticated server per VS Code window, and loads the
  bundled companion plugin without modifying OpenCode configuration.
- Added current-editor, selection, workspace-file, folder, image, and PDF context
  attachments with removable composer chips and fuzzy `@` file search.
- Made Auto approval session-specific. New sessions always begin in Ask mode.
- Added bounded VS Code bridge tools for unsaved buffers, language definitions,
  references, symbols, terminal execution, tasks, code actions, and rename previews.
- Added OpenCode-resolved provider names, model capabilities, separate context,
  input, and output limits, catalog freshness, agent variants, and MCP-resource
  autocomplete.
- Added notebook context, bounded debug stacks, MCP connect and authentication
  controls, editable native plan opening, and checkpoint copying.
- Added an explicitly approved extension-only reload request tool that waits for
  the requesting session to become idle, reloads managed OpenCode out of band,
  reconnects, and restores the current Workbench session.
- Added a persistent expand/collapse control to the composer todo list, with the
  active item shown while collapsed.

### Changed

- Reworked assistant output into grouped turns with useful reasoning summaries,
  compact low-risk activity groups, subtle progress timing, and specialized tool
  presentation.
- Combined model and reasoning controls into a compact nested picker and made the
  primary composer action switch between send, queue, sent, and stop states.
- Replaced working labels with animated active indicators and grouped adjacent
  reasoning into collapsed, scrollable disclosures.
- Separated assistant process activity from the final response with a compact
  timing disclosure that expands the work performed for each user turn.
- Restyled process timing, workspace links, edited-file disclosures, patch
  previews, and goal status to match the compact Codex interaction pattern.
- Matched Codex activity disclosures with an inline toggle, separate subtle
  divider, persisted turn state, and a short reveal animation.
- Matched OpenCode's discrete block scanner using the VS Code theme's chart-blue
  color, and reduced unnecessary full-width action targets.
- Added OpenCode's braille spinner cadence to running chat activities and changed
  sidebar details from a full-height sheet to a centered floating panel.
- Added the Sessions rail to sidebar chat with status icons, searchable status
  terms, relative update times, keyboard navigation, and actionable/date groups.
- Added a compact, scrollable todo list above the composer with pending,
  in-progress, completed, cancelled, and priority presentation.
- Initialized the agent, model, and reasoning controls from OpenCode's resolved
  configuration and provider defaults.
- Changed busy prompt delivery to OpenCode's durable v2 queue and steer APIs with
  idempotent message IDs.
- Changed multi-root startup to require an explicit root selection and scoped
  file search, tasks, buffers, and bridge operations to that root.
- Raised the minimum OpenCode version to 1.18.11 for durable prompt delivery,
  resolved provider catalogs, and current v2 session APIs.
- Replaced raw tool JSON with readable fields and compact, copyable command
  reviews that show only the invoked command, output, and error.
- Added consistent disclosure chevrons, preserved nested expansion state, and
  reduced delegated-task details to recent activity, optional full history, and
  a collapsed task request with an optional full prompt.
- Replaced modal permission prompts and the separate Sessions view with
  contextual chat surfaces.
- Made managed mode the default while retaining external server mode for shared
  and remote deployments. The terminal command now opens the normal OpenCode
  TUI instead of attaching it to Workbench's server.

### Fixed

- Prevented narrow chat layouts, long paths, commands, and tool output from
  widening or clipping the entire view.
- Preserved drafts, keyboard focus, expanded details, and transcript position
  across streaming updates.
- Corrected OpenCode v2 location queries, command model payloads, and session
  operation response handling for OpenCode 1.18.8.
- Bounded large transcripts and tool metadata so long-running sessions remain
  valid and visible in the chat webview.
- Made inline workspace file references open their exact line in VS Code, with a
  unique-filename fallback for shortened paths.
- Extended workspace links to absolute paths, columns, line ranges, and
  line-and-column ranges.
- Rendered Markdown headings, lists, block quotes, and horizontal rules as
  structured content instead of plain text.
- Kept delegated child sessions out of normal session history and search.
- Prevented stale transcript, todo, goal, change, question, and permission UI from
  remaining visible while switching sessions.
- Distinguished running slash commands from pending queue entries and refreshed
  goal status immediately after completed goal-tool updates.
- Added immediate stopping feedback and transitioned sessions to idle when OpenCode
  acknowledges an interrupt request.
- Parsed apply-patch envelopes into per-file diffs with clearer added, removed,
  hunk, and metadata styling.
- Prevented completed patch markers from appearing as indefinitely pending tool
  activity.
- Kept the approval control width stable between Ask and Auto modes, improved
  Auto contrast, and hid agent-selector chrome until focus.
- Distinguished pending questions from permissions in session summaries and
  kept changed-file and todo counts as metadata instead of completion status.
- Matched OpenCode's 40 ms scanner frame, hold, trail, and fade behavior and
  replaced low-contrast persistent-permission button colors.
- Streamed final-answer text as soon as it arrived and collapsed process
  activity before completion to avoid the final layout jump.
- Replaced heavy activity dots with subtle completed glyphs, error markers, and
  braille working indicators, including the title bar.
- Made the process-to-answer divider visible across themes that omit or darken
  VS Code's optional widget-border color.
- Removed the always-on delegated-task scrollbar and wrapped command and output
  text so expanded activity remains readable in narrow chat layouts.
- Bounded and cancelled ordinary OpenCode HTTP responses, tied Auto approval
  messages to their visible session, and bound managed bridge calls to the exact
  VS Code window.
- Preserved checked choices with custom multi-select answers, synchronized drafts
  across chat surfaces, exposed transcript loading failures, and purged deleted
  session attachments.
- Restored current-editor attachment chips and attachment handling for saved,
  dirty, and untitled text buffers.
- Persisted the last user-selected model and reasoning globally across VS Code
  projects and windows while preserving configured agent-model precedence.
- Replaced routine connection, reload, and status notifications with the output
  channel or status bar.
- Rendered fenced code blocks when their opening or closing fences are indented.
- Labeled active patch tools as preparing rather than applied until execution
  completes.

### Removed

- Removed the `vscode_execute_terminal_capture` bridge tool.

### Security

- Kept Auto approval volatile and root-session-specific so repository settings
  cannot enable it and new sessions always begin in Ask mode.
- Made truncated permission requests reject-only and retained strict protocol,
  path, URL, and payload validation.

## 0.2.0 - 2026-08-01

### Added

- Added a Secondary Side Bar chat container, editor-area chat command, compact
  session switcher, and `Ctrl+Alt+N` new-session keybinding.
- Added Visual Studio Marketplace metadata and verified release publication.

### Changed

- Redesigned chat around VS Code's built-in Copilot interaction patterns while
  preserving multi-session state, agent and model selection, tool output,
  permissions, and background sessions.
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
