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

The gate also includes the static accessibility contract because keyboard and
screen-reader status are part of the UX boundary. Live OpenCode and ACP
compatibility remain separate provider-free gates so the scenario suite is
deterministic on machines without an installed executable.
