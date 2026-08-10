# Harness UX scenario gate

The provider-free harness UX gate is:

```sh
deno task test:harness:ux
```

It deliberately composes real boundary tests rather than relying on model
quality or duplicating fixtures in a second scenario runner.

| # | Scenario | Automated evidence |
|---|---|---|
| 1 | Idle send is admitted exactly once. | `client_test.ts`: durable admission check; `communication_test.ts`: authenticated HTTP/SSE controller path; `session-controller_test.ts`: first prompt creation and concurrent creation guards. |
| 2 | Steering during tools is delivered at the correct boundary. | `session-controller_test.ts`: busy send choices and steer surviving concurrent admission; `lifecycle_test.ts`: explicit item blockers. |
| 3 | Follow-up waits until the agent would stop. | `lifecycle_test.ts`: visible completion remains unsettled while follow-up can start; `session-controller_test.ts`: queue ordering. |
| 4 | Permission precedes execution and exposes exact valid choices. | `client_test.ts`: current and truncated permission contracts; `session-controller_test.ts`: exact/conservative scopes, failed replies remain pending, truncated requests are reject-only. |
| 5 | A question response survives webview reload. | `session-controller_test.ts`: in-flight question remains in a fresh snapshot, rejects duplicate submission, and disappears only after settlement; `webview_transport_test.ts`: listener disposal/recreation. |
| 6 | Disconnect reconciles without duplicate content. | `event_stream_test.ts`: epoch/revision gaps and snapshot fallback; `session-controller_test.ts`: stale reconnect rejection and live/snapshot transcript merge; `communication_test.ts`: end-to-end SSE state. |
| 7 | Goal continuation does not settle the session early or duplicate work after restart. | `goal_integration_test.ts`: atomic continuation reservation, idle ordering, stable-ID transcript recovery, lost-response reconciliation, and conservative pause when history is unavailable; `lifecycle_test.ts`: continuation settlement blockers; `webview-assets_test.ts`: continuation timeline marker. |
| 8 | A worktree session cannot reach the root checkout through the bridge. | `bridge_containment_test.ts`: exact worktree affinity, sibling/root rejection, and symlink escape rejection; `worktree_service_test.ts`: canonical typed worktree operations. |
| 9 | Multi-run results remain independent. | `run_group_service_test.ts`: partial failure isolation, independent retry/cancellation, persisted idempotency, and restart refresh. |
| 10 | Diff/evidence matches repository/task state. | `diff_evidence_test.ts`: exact-byte hash, tracked and untracked files, hunk resolution, reload-stable references, visible oversize failure, and session-scoped evidence; `task_evidence_service_test.ts`: completion subscription precedes task launch; `diagnostics_evidence_service_test.ts`: repository containment and before/after deltas. |
| 11 | GitHub handoff uses native authentication and explicit bounded context. | `native_integration_service_test.ts`: canonical URL validation, injected VS Code session use, sanitized HTTP errors, response/selection bounds, issue/PR metadata, changed-file patch coverage, redaction, and native-surface feature detection. |
| 12 | Receipt and evidence continuity survives an isolated-worktree window boundary. | `handoff_continuity_service_test.ts`: actual per-run receipt rebinding, metadata-only redaction, explicit limits/expiry, ordered flushable writes, atomic Git-common-dir storage, POSIX owner-only permissions, concurrent extension hosts, symlink-escape refusal, and restart import. |
| 13 | A new user can discover the OpenCode-backed workflow and use its critical controls without a pointer. | `webview-assets_test.ts`: five-step command-backed walkthrough, host-handler coverage, Workbench-scoped shortcuts, narrow/short viewport fallbacks, static reduced-motion progress, and forced-color state visibility. |
| 14 | Durable task surfaces remain bounded metadata keyed to OpenCode provenance. | `workbench_domain_test.ts`: plan/review/verifier/comparison/context schemas reject objectives, plan bodies, raw diffs, prompt fields, and clipboard bytes; `task_artifact_service_test.ts`: revision, restart, capacity, and canonical-session behavior; `webview_snapshot_projector_test.ts`: bounded artifact/evidence/comparison projection. |
| 15 | Jobs reflects native OpenCode terminals and child sessions without becoming a second scheduler. | `client_test.ts`: strict `/pty` and native background-child contracts; `session-controller_test.ts`: bounded PTY hydration, event ordering, confirmed cancellation, and backgrounding; `job_projection_service_test.ts`: read-only grouping of needs-input, running, failed, and completed work. |
| 16 | Recovery is previewed conservatively and applied only through OpenCode's coupled revert state. | `recovery_preview_service_test.ts`: idle/user-boundary validation, exact transcript tail, bounded current-file summaries, explicit limitations, and native-marker redo gating; `session-controller_test.ts`: accepted undo/redo responses, rollback, and ambiguous-admission safety. |
| 17 | Session organization preserves native archive/share/lineage state while pins stay local. | `session_presentation_service_test.ts`: bounded local pin persistence and authoritative reconciliation; `session_list_view_test.ts`: pinned ordering plus archive/shared/changed/state filters; `protocol_test.ts`: bounded lineage and native session metadata projection. |
| 18 | Browser capture and multi-run comparison remain explicit and non-judgmental. | `browser_context_service_test.ts` and `protocol_test.ts`: originating-session binding, explicit source selection, bounded capture, URL-secret stripping, and rejection of implicit/private payloads; `run_comparison_service_test.ts`: pending-run isolation, exact objective evidence and revision-bound Markdown export, unavailable-state labeling, redaction, and the explicit no-winner/no-score contract. |
| 19 | Durable context metadata can reopen only a still-safe source. | `context_receipt_source_service_test.ts`: exact receipt/session/item ownership, credential-free HTTP(S), canonical file containment, symlink-escape refusal, missing-source handling, and `mtime:size` staleness checks without reading or fetching content. |

The gate also includes the static accessibility contract because keyboard and
screen-reader semantics are part of the UX boundary. It does **not** prove
actual speech output. The NVDA, VoiceOver, or Orca procedure in
`docs/testing/accessibility-smoke.md` remains a required manual release smoke
and must not be marked complete from headless results. Live OpenCode and ACP
compatibility remain separate provider-free gates so the scenario suite is
deterministic on machines without an installed executable.

## Onboarding and keyboard contract

The **OpenCode: Open Workbench Help** command reopens the five-step Getting
Started walkthrough. Every step invokes an extension-host command and continues
to use the selected OpenCode installation; the walkthrough does not introduce a
second chat or model backend.

Default shortcuts are limited to contexts where they cannot replace normal
editor commands:

- **Ctrl/Cmd+Shift+O** opens the editor Workbench only while the OpenCode sidebar
  has focus.
- **Ctrl/Cmd+L** focuses the composer only while a Workbench webview has focus.
- **Escape** stops the active OpenCode session only while that session is busy
  and a Workbench webview has focus.

Task Workbench, Sessions, Jobs, Needs Attention, next-attention, and Help remain
available through the Command Palette even when users avoid default shortcuts.
