# OpenCode Workbench — Coding Model Handoff Prompt v2

You are working in the repository currently checked out as `opencode-workbench`.

Your controlling documents are:

1. `planning/OPENCODE_WORKBENCH_HARNESS_REVIEW.md`
2. `planning/OPENCODE_WORKBENCH_IMPLEMENTATION_PLAN_V2.md`
3. `packages/vscode-extension/DESIGN.md`
4. `TESTING.md`
5. applicable ADRs under `docs/adr/`

Read these code paths before changing behavior:

- `packages/shared/src/protocol.ts`
- `packages/shared/src/session-state.ts`
- `packages/shared/src/opencode.ts`
- `packages/vscode-extension/src/session-controller.ts`
- `packages/vscode-extension/src/opencode-client.ts`
- `packages/vscode-extension/src/bridge.ts`
- `packages/vscode-extension/src/views/chat-view.ts`
- `packages/vscode-extension/src/webview/main.ts`
- `packages/opencode-plugin/src/bridge.ts`
- `packages/opencode-plugin/src/goals.ts`
- `packages/opencode-plugin/src/index.ts`

## Mission

Evolve Workbench into the **OpenCode-native harness and control plane for VS Code**.

Preserve these boundaries:

- OpenCode owns models, providers, agents, tools, sessions, messages, transcripts, permissions, questions, and runtime status.
- The companion plugin owns persistent goals, goal continuation, approved preferences, and staged skill candidates.
- Stable Workbench mode remains extension-host + no-network webview + OpenCode HTTP/SSE.
- Native VS Code Agent Host integration is experimental and may be implemented only after the controlling ADR permits it.
- Do not add a provider SDK, competing model loop, transcript database, custom terminal, custom browser, remote relay, generic shell hooks, duplicated GitHub auth, or duplicated provider configuration.
- Do not turn Workbench into a universal frontend for Codex, Claude, Pi, or other harnesses.
- Do not pass arbitrary shell strings or arbitrary VS Code command IDs across a UI boundary.
- Do not persist prompt attachment bytes, unsaved-buffer contents, credentials, or complete prompt payloads.
- Do not silently weaken OpenCode permission choices.
- Do not silently truncate context, diffs, permission detail, or verifier inputs.
- Do not use proposed VS Code APIs as a stable Marketplace requirement.
- Do not raise the VS Code minimum merely for an experimental prototype.
- Do not migrate the webview to React or another framework as part of this program.

## Critical lifecycle rules

Treat these as separate events:

```text
prompt admitted
turn started
turn completed
session settled
```

A turn is not settled while any of these remain possible:

- steering message;
- follow-up message;
- retry;
- compaction continuation;
- goal continuation;
- permission/question resolution;
- post-run re-entry;
- session transition;
- stale asynchronous completion.

Every mutation must be correlated and idempotent where retry is possible.

## Initial bootstrap assignment (historical)

The original first implementation session started with **DISC-001** from
`planning/OPENCODE_WORKBENCH_IMPLEMENTATION_PLAN_V2.md`. For later audits, use
that plan together with
`docs/architecture/implementation-plan-v2-completion.md` to identify remaining
work rather than repeating this bootstrap sequence.

After DISC-001 is complete and all tests pass, begin **ACP-001** only. Do not implement production ACP, AHP, worktrees, Multi-run, protocol v2, or broad UI changes in the same session.

### DISC-001 deliverables

Create or update:

```text
docs/architecture/invariants.md
docs/architecture/harness-capabilities.md
docs/architecture/current-state.md
```

Document the actual current contracts and tests for:

- OpenCode HTTP/SSE methods/events;
- session/message/part IDs;
- queue/steer/replace/abort;
- prompt admission behavior;
- permissions and questions;
- reconnect/reconciliation;
- companion-plugin goals/preferences/skills;
- bridge authentication, roots, and affinity;
- persistence and privacy boundaries;
- sidebar/editor synchronization;
- current VS Code and OpenCode compatibility.

Do not guess. Mark unknowns as unknown.

### ACP-001 deliverables

Build a provider-free `opencode acp` contract recorder and checked-in sanitized fixtures. Prove exact JSON-RPC behavior for every operation available without sending a model request. Where a model turn is required, add an opt-in test seam rather than running it by default.

Record:

- initialization and capabilities;
- session create/resume/list/fork behavior;
- agent/model/variant selection;
- tools, slash commands, MCP, and companion-plugin discovery;
- permissions and response choices;
- questions/user input;
- cancellation;
- working directory;
- process crash/malformed input;
- persistence across restart;
- queue/steer/follow-up if represented;
- documented unsupported commands.

Create:

```text
docs/adr/0001-opencode-acp-contract.md
packages/vscode-extension/test/acp_contract_test.ts
packages/vscode-extension/test/fixtures/acp/
scripts/record-opencode-acp-contract.ts
```

Adapt exact paths to repository conventions if needed.

## Working method

Before editing:

1. Inspect current `HEAD` and recent commits.
2. Compare actual code with the plan baseline.
3. Write a concise checklist for the selected issue.
4. Identify the smallest deterministic tests that prove the boundary.
5. State any assumption that needs evidence.

While editing:

- Keep discovery and production behavior separate.
- Keep mechanical refactors separate from behavior.
- Follow existing strict TypeScript/Deno style.
- Prefer existing dependencies and utilities.
- Add bounds, cancellation, deterministic cleanup, and structured failures at every new boundary.
- Preserve managed and external server modes.
- Preserve both sidebar and editor webview surfaces.
- Preserve event ordering, transcript reconciliation, permission exactness, attachment privacy, and goal continuation.
- Avoid arbitrary sleeps in tests.
- Sanitize fixtures and logs.

## Required validation

For each completed issue, run:

```sh
deno task check
deno task test:synthetic
deno task test:integration:synthetic
deno task test:stress
deno task package
```

Run the provider-free real OpenCode integration suite when changing an OpenCode contract and a compatible executable is available.

Do not mark an issue complete when a required gate is skipped. State why it could not run.

## Stop rules

Stop dependent implementation and write/update an ADR when:

- OpenCode behavior contradicts the plan;
- ACP cannot represent a required capability;
- native VS Code integration requires private/allowlisted APIs;
- exact permission semantics cannot be preserved;
- two components would own the same session or worktree;
- a test requires a real provider call but no opt-in boundary exists;
- a persistence change could store sensitive content;
- a proposed VS Code API would become a stable dependency.

Do not silently work around a disproven assumption.

## End-of-session report

```text
Issue:
Status: complete | partial | blocked

Summary:
Files added/modified/removed:
Behavior changed:
External contracts proven:
Capabilities added/removed:
Security and persistence impact:
Tests and exact results:
Documentation/ADR updated:
Known verified limitations:
Blocking discoveries:
Next dependency-ready issue:
```
