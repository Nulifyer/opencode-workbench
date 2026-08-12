# Implementation plan v2 completion report

- Date: 2026-08-10
- Plan: `planning/OPENCODE_WORKBENCH_IMPLEMENTATION_PLAN_V2.md`
- Stable authority: OpenCode HTTP/SSE plus the bundled companion plugin
- Native decision: `defer-native` under ADR 0003

## Issue audit

| Issue        | Status                           | Primary implementation/evidence                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DISC-001     | Complete                         | `docs/architecture/invariants.md`, `current-state.md`, and `harness-capabilities.md` freeze owners, contracts, unknowns, persistence, and tests.                                                                                                                                                                                                                                                        |
| ACP-001      | Complete                         | Provider-free recorder, pinned sanitized fixture, contract test, and ADR 0001.                                                                                                                                                                                                                                                                                                                          |
| AHP-001      | Complete                         | Reproducible stable/proposed/private probe, pinned VS Code fixture, feasibility test, and ADR 0002.                                                                                                                                                                                                                                                                                                     |
| MAP-001      | Complete                         | `docs/architecture/opencode-acp-ahp-mapping.md` classifies every required mapping without collapsing permissions or lifecycle.                                                                                                                                                                                                                                                                          |
| ADR-001      | Complete                         | ADR 0003 selects `defer-native` from the proven registration and mapping stop conditions.                                                                                                                                                                                                                                                                                                               |
| VER-001      | Complete                         | Provider-free isolated verifier recorder/fixture/test and `docs/architecture/verifier-execution.md`.                                                                                                                                                                                                                                                                                                    |
| FND-001–003  | Complete                         | Canonical lifecycle/settlement types, protocol v2 envelopes/capabilities/errors, one schema source, generated manifest/docs, accepted/rejected fixtures, and reproducibility checks.                                                                                                                                                                                                                    |
| FND-004–005  | Complete                         | Correlated host router, cancellation, idempotency, overload, runtime epochs, revisions, replay/snapshot gap recovery, bounded hidden queues, and 20,000-event coverage.                                                                                                                                                                                                                                 |
| FND-006      | Complete                         | Controller delegates to repository, catalog, prompt, settlement, permission, question, transcript, snapshot, and connection services while controller regressions remain green.                                                                                                                                                                                                                         |
| FND-007      | Complete                         | Webview delegates transport/request correlation, v1 adaptation, state, composer/scroll/focus/overlay, history/turn navigation, and substantive session-list behavior while preserving both surfaces. The coordinator remains intentionally visible as a later maintainability seam.                                                                                                                     |
| FND-008      | Complete                         | Bounded Health Center and sanitized session trace commands/services; sensitive categories are rejected.                                                                                                                                                                                                                                                                                                 |
| UI-001–006   | Complete                         | Needs Attention, behavioral steer/follow-up/replace semantics, admitted-context receipts, persistent inspector, bounded older-history paging with preserved anchors, turn/checkpoint/fork markers, and editable Plan-first handoff.                                                                                                                                                                     |
| UI-007       | Partial — platform smoke pending | Semantic lists/logs/dialogs/tabs, roving tabs, focus trap/restoration, live status, configurable Enter behavior, reduced motion, forced-colors support, and behavioral keyboard/accessibility regression tests are complete. The required NVDA, VoiceOver, or Orca speech smoke remains a documented release procedure and was not available in this headless environment.                              |
| UI-008       | Complete                         | Stable custom rail progressively exposes current checkout context, ordinary sessions, RunGroups, and nested model worktree sessions; review/Fusion destinations remain ordinary OpenCode sessions.                                                                                                                                                                                                      |
| NAT-001–010  | Skipped by ADR                   | Phase N is not permitted after `defer-native`. No proposed API, dual authority, or hidden native dependency was shipped.                                                                                                                                                                                                                                                                                |
| WT-001       | Complete                         | `docs/architecture/worktree-ownership.md` makes Workbench the sole fallback owner.                                                                                                                                                                                                                                                                                                                      |
| WT-002A      | Skipped by ADR                   | Native worktree integration is inapplicable under `defer-native`.                                                                                                                                                                                                                                                                                                                                       |
| WT-002B–003  | Complete                         | Typed shell-free Git runner, canonical identity, durable journal, crash recovery across every phase, idempotency, isolated session creation, dirty retention, and separate branch/worktree/session actions.                                                                                                                                                                                             |
| MR-001–003   | Complete                         | Persisted transport-independent RunGroups, two-to-five isolated runs, exact receipt reuse, partial-failure isolation, explicit retry, recovery, and progressive stable-mode UI.                                                                                                                                                                                                                         |
| MR-004       | Complete                         | Exact pinned base commit, objective comparison, direct open/native-diff/review/keep/discard/compare/Fusion actions, and no AI winner.                                                                                                                                                                                                                                                                   |
| MR-005       | Complete                         | Individual/group cancellation, restart refresh, duplicate mutation recovery, discarded/retained state, dirty cleanup refusal, and stale/missing session reporting.                                                                                                                                                                                                                                      |
| REV-001–002  | Complete                         | Exact diff identity and scoped captures, turn association, Git recomputation, visible oversize/partial behavior, and changed-file projection.                                                                                                                                                                                                                                                           |
| REV-003–004  | Complete                         | Bounded cached walkthrough generation, exact-anchor validation, coverage markers, persisted Inspector documents, stale-hash rejection, and native diff navigation.                                                                                                                                                                                                                                      |
| REV-005      | Complete                         | Deterministic exact-diff, repository-scoped diagnostic/delta, todo, criterion, verifier, and attributable VS Code task/terminal exit evidence. Test-group task exits are recorded; Workbench does not claim access to arbitrary results owned by another Test Controller.                                                                                                                               |
| REV-006      | Complete                         | Separate model-labeled code-review workflow with exact anchors and stale native navigation rejection.                                                                                                                                                                                                                                                                                                   |
| GOAL-001     | Complete                         | Schema v2 migration adds criteria, verifier config, evidence, verdicts, repeated-block state, pending continuation, settlement generation, and plan/run references. Auto-turn reservations carry stable OpenCode message/part IDs, reconcile against transcript history after restart or a lost response without double-counting, and pause for explicit recovery when admission cannot be established. |
| GOAL-002     | Complete                         | Independent bounded tools-disabled verifier, strict structured output, configured model/agent/threshold, cancellable execution, retained attempt/session/usage metadata, an atomic stale-generation guard at apply time, explicit apply, and repeated-block policy.                                                                                                                                     |
| GOAL-003–004 | Complete                         | Deterministic evidence and diagnostics enter verification; Goal inspector configures criteria/limits/verifier and exposes status, progress, verdict, needs-user, and lifecycle actions.                                                                                                                                                                                                                 |
| INT-001      | Complete                         | Canonical GitHub issue/PR handoff uses VS Code GitHub authentication, bounded/redacted REST context and PR patches, exact context receipts, isolated-first execution, and version-gated native GitHub surfaces.                                                                                                                                                                                         |
| INT-002      | Complete (optional)              | Narrow `@opencode` participant hands off to a real OpenCode session and does not own a model loop.                                                                                                                                                                                                                                                                                                      |
| INT-003      | Complete (optional)              | Explicit bounded editor/debug/clipboard/screenshot capture with no proxy, navigation, implicit collection, or persistence.                                                                                                                                                                                                                                                                              |
| FUS-001      | Complete (optional)              | Plan/build/review synthesis in a fresh isolated worktree with complete exact diffs, deterministic evidence, objective comparison rows, bounded summaries, hashes, source/session provenance, transactional context admission, and no automatic merge/cherry-pick/push/publish.                                                                                                                          |

## Behavior and compatibility

Before this plan, Workbench had a capable stable chat but conflated several
lifecycle boundaries, concentrated controller/webview ownership, and lacked the
planned protocol, recovery, multi-run, exact-review, verifier, and integration
surfaces. After it, OpenCode is still the only model/session/transcript
authority, while Workbench has explicit admission/settlement semantics,
recoverable orchestration, bounded evidence, and progressive control-plane UX.

Managed and external server modes, sidebar/editor surfaces, supported OpenCode
1.18.x releases from 1.18.11 onward, and
VS Code `^1.106.0` remain supported. No provider SDK, second agent loop,
transcript database, custom terminal/browser, generic hook platform, proposed VS
Code API, or additional harness adapter was introduced.

## Security and persistence

- New durable state contains bounded plan references, context receipts,
  deterministic evidence references/summaries, verifier attempt metadata, worktree journal metadata,
  RunGroup references/status, walkthrough documents, and goal schema v2 state.
- Cross-workspace receipt/evidence continuity uses a 2 MiB, 128-record,
  30-day registry in the repository's Git common directory. Writes are ordered,
  locked, fsynced, atomically replaced, and owner-only where POSIX permissions
  are available; no checkout or sibling worktree file is created.
- It does not contain complete prompts, source prompt bytes, attachment payloads,
  screenshots, unsaved-buffer content, console bodies, GitHub credentials,
  provider secrets, or verifier tool access.
- Git mutations use typed arguments with `shell: false`; canonical worktree
  context and realpath/symlink containment prevent root/sibling access.
- External capabilities are feature/capability gated; traces and fixtures are
  sanitized and bounded.

## Verification results

All commands completed successfully on 2026-08-10 against the final integrated
workspace:

| Command                                                                                                                                | Exact result                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno task release`                                                                                                                    | Passed the complete verify, synthetic-integration, Harness UX, repeated-stress, packaging, release-metadata, and checksum rehearsal.            |
| `deno task verify`                                                                                                                     | Static/generated/type checks passed; synthetic suite **543 passed, 0 failed**; production VSIX packaged.                                        |
| `deno task test:harness:ux`                                                                                                            | **394 passed, 0 failed** across the provider-free scenarios, protocol/recovery paths, GitHub-context contracts, and accessibility interactions. |
| `deno task test:integration:synthetic`                                                                                                 | **17 passed, 0 failed**.                                                                                                                        |
| `deno task test:stress`                                                                                                                | **15 passed, 0 failed**, including the 20,000-event pipeline and aggregate UTF-8 snapshot bound.                                                |
| `deno task test:stress:repeat`                                                                                                         | **15 test definitions × 5 repetitions (75 executions), 0 failed**.                                                                              |
| `OPENCODE_INTEGRATION_EXECUTABLE=/usr/bin/opencode OPENCODE_INTEGRATION_VERSION=1.18.15 deno task test:integration:real`               | **1 passed, 0 failed** without a model request.                                                                                                 |
| `OPENCODE_ACP_EXECUTABLE=/usr/bin/opencode OPENCODE_ACP_VERSION=1.18.15 deno task test:integration:acp`                                | **4 passed, 0 failed** against installed OpenCode 1.18.15.                                                                                      |
| `OPENCODE_VERIFIER_EXECUTABLE=/usr/bin/opencode OPENCODE_VERIFIER_VERSION=1.18.15 deno task test:integration:verifier`                 | **3 passed, 0 failed**.                                                                                                                         |
| `VSCODE_PRODUCT_JSON=/usr/share/code/resources/app/product.json VSCODE_EXECUTABLE=/usr/bin/code deno task test:integration:agent-host` | **3 passed, 0 failed** against installed VS Code 1.131.0 and reconfirmed the native registration stop condition.                                |
| `git diff --check`                                                                                                                     | Passed.                                                                                                                                         |
| Project-owner live testing                                                                                                             | Completed before `v0.4.7` release preparation.                                                                                                  |

The distributable is `dist/opencode-workbench-vscode-0.4.7.vsix`.

## Verified limitations

- Native Agent Host mode is intentionally absent, not unfinished; ADR 0003 is
  the plan-authorized terminal outcome.
- Model-backed walkthrough, review, and verifier quality is not asserted by
  provider-free tests. Their schemas, bounds, isolation, anchoring, stale guards,
  and deterministic evidence inputs are asserted.
- Older-history paging reaches the 10,000-message safety-bounded history retained
  by the OpenCode client. The UI explicitly warns when still-older server history
  may exist; no persistent upstream cursor lifecycle is claimed.
- Actual speech output depends on OS/assistive technology. Automated tests prove
  semantic, focus, keyboard, and announcement-state behavior; the manual platform
  procedure in `docs/testing/accessibility-smoke.md` was not executed in this
  headless environment.
- The live GitHub sign-in/API/PR-deep-link flow could not be executed because no
  signed-in GitHub Pull Requests extension was available. Provider-injected tests
  cover authentication headers, bounds, redaction, errors, and version gating;
  the official deep link is offered only for extension version 0.126.0 or newer.
- The stable VS Code API does not expose arbitrary results owned by other Test
  Controllers. Workbench records test-group VS Code task exits plus its own task,
  terminal, diagnostics, diff, todo, criterion, and verifier evidence without
  inventing unavailable detail.
