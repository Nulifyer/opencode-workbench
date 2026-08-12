# Changelog

## Unreleased

### Changed

- Split transcript history, multi-run selection, metrics, and modal state out of
  the main webview module into focused controllers.
- Kept acknowledged Needs Attention items visible until their underlying issue
  resolves, while badges count only unread revisions.
- Clarified that goal cancellation archives its metrics and that displayed
  session and goal durations are elapsed time.

### Fixed

- Enforced multi-run concurrency for active model jobs, queued excess runs, and
  avoided rewriting unchanged run journals on each status poll.
- Kept the send-options menu hidden for an empty composer and stable across
  streaming updates, and preserved drafts edited while multi-run starts.
- Preserved keyboard focus in the multi-model dialog, added roving checkbox
  navigation, and restored focus to a visible control.
- Bounded aggregate server-history loading, retried transient history transport
  failures, and checked complete legacy history before prompt admission.
- Preserved cumulative goal usage across context compaction, bounded archived
  goal storage, and sanitized errors before displaying them in chat.
- Prevented continuity-export failures after prompt admission from presenting an
  active multi-run as failed and inviting duplicate runs.
- Made proposed edits and failed patches use the same highlighted diff block as
  completed edits. Workspace changes now open in named native two-sided or
  multi-file review editors without Untitled documents, support durable
  reviewed state and Timeline navigation, and keep external changes as
  explicitly bounded transcript patch previews.
- Grouped identical permission requests from the same owning session into one
  approval card with explicit Allow all and Reject all actions.
- Allowed edited-file links to open exact source-bound files outside the current
  workspace, including isolated worktrees, while ordinary file links remain
  workspace-contained.

### Release

- Reject release builds that reuse a version tag from an older commit or lack a
  matching dated changelog entry.

## 0.4.7 - 2026-08-10

### Added

- Added Plan-first handoff, isolated worktrees, two-to-five-model Multi-run,
  objective run comparison, and opt-in Fusion in a fresh worktree.
- Added exact-diff walkthroughs, model-labeled code review, deterministic task
  and diagnostics evidence, and native diff navigation.
- Added independent bounded goal verification, configurable acceptance
  criteria, repeated-block handling, and stale-verdict protection.
- Added Needs Attention, the persistent inspector, Health Center, sanitized
  lifecycle traces, admitted-context receipts, and long-session navigation.
- Added bounded GitHub issue/PR handoff through VS Code sign-in and explicit
  diagnostic, debug, terminal/task excerpt, screenshot, and approved-URL
  context capture.
- Added OpenCode-native session lineage, child-session and PTY jobs, pinned and
  archived session organization, objective run comparison, recovery previews,
  and durable metadata-only task artifacts.
- Added syntax-highlighted edited-file previews, attachment previews, contextual
  session-work guidance, and bounded long-conversation navigation.

### Changed

- Reorganized controller and webview responsibilities around explicit session,
  transport, lifecycle, context, worktree, run, review, and verifier services.
- Made the README a task-oriented guide for installing and using Workbench;
  contributor and architecture detail now lives in the dedicated documents.
- Expanded accessibility for keyboard navigation, focus restoration, live
  status, reduced motion, forced colors, and both sidebar and editor surfaces.
- Made isolated run status, pending input, failures, receipts, and evidence
  update across worktrees without requiring an unrelated chat refresh.
- Reworked the editor experience into a theme-native two-column session-work
  and Sessions layout. Session work is contextual, starts closed, remembers its
  last visibility, and restores across extension-host reloads.
- Consolidated Plan, Goal, Context, changes/review/evidence, jobs/runs/lineage,
  and health information into clearer contextual destinations with concise
  explanations instead of a permanently open secondary sidebar.
- Replaced the overflowing dot rail with bounded turn navigation and explicit
  older-history loading, and reordered the chat actions around the primary
  new-session, attention, help, workbench, editor, and Sessions workflows.

### Fixed

- Included untracked files in working-tree diff identity, review, run
  comparison, and Fusion inputs instead of presenting an incomplete diff as
  complete.
- Preserved user edits made while a Plan-first result is still being generated.
- Made worktree/run recovery journal transitions crash-safe and prevented
  cancellation from being overwritten by an in-flight launch.
- Rejected walkthrough and review anchors outside their exact Git hunk and
  rejected false complete-coverage claims.
- Scoped verifier evidence to its session and invalidated verdicts when goal
  inputs change.
- Surfaced Command Palette workflow failures as bounded, redacted VS Code error
  messages instead of requiring users to discover them in Output.
- Recovered from malformed optional snapshot projections without discarding the
  authoritative conversation, and distinguished Workbench synchronization
  failures from OpenCode request failures.
- Kept one stable prompt ID through composer, queue, admission, transcript, and
  retry. V2 delivery now requires an exact OpenCode receipt, while ambiguous
  legacy delivery is reconciled without duplicating the prompt.
- Stopped treating provider-step or compaction completion as session settlement;
  queued follow-ups now wait for OpenCode's authoritative runner status.
- Hid OpenCode's native post-compaction continuation from the authored chat and
  turn navigator instead of presenting it as a failed unsaved message.
- Refreshed generated OpenCode titles after settled turns, restored bottom-scroll
  intent when returning to a session, stabilized resizable Sessions width, and
  cleared selection when deleting the active session.
- Corrected Needs Attention routing and clearing, anchored menus and health
  popovers in the browser top layer, added copy confirmation, and aligned action
  and goal controls with VS Code theme tokens.
- Preserved editor/selection ownership across browser-context capture and review
  generation, and returned only the canonical file URI that passed containment
  checks when reopening context receipt sources.

### Security

- Updated the Markdown renderer to `markdown-it` 14.2.0 to remove the known
  smartquotes complexity and regular-expression denial-of-service advisories.
- Kept protocol, trace, evidence, worktree, browser/debug capture, and verifier
  inputs bounded and sanitized without persisting prompt or attachment bodies.
- Shared only private, expiring receipt/evidence metadata through Git's common
  directory and requested owner-only filesystem permissions where supported.

## 0.4.6 - 2026-08-05

### Changed

- Displayed the active shell command as `Running Command: <command>` and changed
  it to an outcome-specific label when execution stops.
- Made edited filenames the dedicated **Open in VS Code** targets while the
  remainder of each row expands or collapses patch details without repeating
  the filename and change counts inside the expanded panel.
- Aligned tool, patch, reasoning, todo, and elapsed-time wording with their
  actual running, completed, failed, or stopped state.
- Reworked shell details into labeled Command, Output, and Error sections,
  removed terminal escape sequences, and replaced two-column tool inputs with
  readable header-based sections.

## 0.4.5 - 2026-08-05

### Added

- Added the discoverable `/goal-unlimited <objective>` command for creating a
  goal without token, duration, or auto-turn limits.

### Fixed

- Prevented approved-preference injection from creating invalid OpenCode part
  IDs, empty `Message sent` entries, and unexplained session failures.
- Preserved pending legacy prompt text across asynchronous failures and exposed
  exact session, persisted provider, and empty-response errors in the chat UI.
- Treated unknown future OpenCode events as non-fatal for forward compatibility.
- Prevented automatically approved permission prompts from briefly appearing in
  the chat UI while preserving manual fallback when automatic approval fails.
- Stopped stale tool, delegated-task, and todo spinners when their session is no
  longer running, including incomplete history left by an interrupted step.

## 0.4.4 - 2026-08-04

### Added

- Added plugin-owned idle continuation for active goals, with persistent turn
  reservation, goal limits, terminal-state and admission-failure stops, and goal
  bar controls for editing, pausing, resuming, and cancelling.
- Added native persistent goal tools, `/goal` command registration, Plan-mode
  safety, completion evidence, checkpoints, budgets, compaction context, and
  one-time compatible state import to the bundled companion plugin.

### Fixed

- Rendered synthetic goal-continuation prompts as explicit timeline markers
  instead of empty `Message sent` placeholders, including legacy transcript and
  V2-only fallback paths.
- Coalesced canonical `session.status: idle` and deprecated `session.idle`
  events, and delayed continuation until a preceding asynchronous prompt can
  report failure.
- Prevented workspace mention search from inventing filename-prefix entries such
  as `READ` and `README.` for a root-level `README.md` file.
- Removed the runtime dependency on the third-party OpenCode goal plugin.

## 0.4.3 - 2026-08-04

### Changed

- Replaced the custom chat Markdown parser with `markdown-it` to support
  CommonMark blocks and GFM tables, strikethrough, autolinks, and task lists.

### Security

- Continued to escape raw HTML and restricted externally opened links to HTTP(S).

## 0.4.2 - 2026-08-03

### Added

- Added layered synthetic, stress, and installed-OpenCode integration suites
  for event ordering, connection lifecycle, and prompt projection behavior.

### Changed

- Presented user-facing process updates as distinct activity blocks.
- Kept the active work block expanded across assistant step transitions and
  collapsed it when the full response completed.

### Fixed

- Distinguished initial loading and reconnecting from a confirmed connection
  failure, preventing transient offline warnings during session hydration.
- Preserved ordered SSE processing under burst load, isolated handler failures,
  and discarded stale events when replacing a managed server connection.
- Kept submitted prompt text visible across partial server projections and
  ambiguous admission failures instead of showing a temporary placeholder.
- Improved warning contrast and stabilized active-work timing between model
  steps.

## 0.4.1 - 2026-08-03

### Added

- Added foreground detail popovers for formatter, MCP, and context status with
  OpenCode-compatible service states, token usage, limits, and cost.

### Fixed

- Kept operational throbbers and Braille spinners active when reduced motion is
  enabled while continuing to suppress decorative transitions.
- Replaced the permission Allow menu text arrow with a centered chevron icon.
- Kept runtime status popovers above the composer and aligned LSP, formatter,
  and MCP health counts with their native OpenCode contracts.

## 0.4.0 - 2026-08-03

### Added

- Added ordered image and PDF prompt references, draft thumbnails and previews,
  duplicate detection, model capability checks, and synchronized pending
  attachments across chat surfaces.
- Added collapsible large-paste context cards, per-message actions, a jump-to-latest
  control, pending model-input details, and persistent actionable error notices.
- Added a configurable managed-server startup timeout with a 120-second default.

### Changed

- Local installs now use a timestamped development prerelease of the next patch
  instead of reusing the live Marketplace version.
- Kept operational spinners active when reduced motion is enabled while still
  suppressing nonessential transition and expansion effects.
- Made the repository README the single source for GitHub and VSIX packaging.

### Fixed

- Preserved explicit ordered-list numbering when nested content splits Markdown
  lists into separate rendered blocks.
- Removed repeated attachment reference labels from sent-message cards and kept
  compact image thumbnails for newly sent attachments.
- Kept the composer anchored to the bottom while session messages are loading.
- Restored selected sessions across reloads and recovered incompatible legacy
  conversations into one mapped fork without hiding the real OpenCode title.
- Preserved legacy and V2 prompt transport, generated chronologically sortable
  message IDs, and checked durable admission before retrying uncertain sends.
- Revalidated external OpenCode servers during reconnects and surfaced webview
  request failures in the Workbench output log.

## 0.3.0 - 2026-08-03

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
- Matched VS Code's suggested-context behavior with a subdued current-editor
  chip, distinct folder labels, and no duplicate suggestion after attach.
- Allowed typing and submitting the first prompt to create a new session
  automatically when no session is selected.

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
