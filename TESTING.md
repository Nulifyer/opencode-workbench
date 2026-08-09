# Testing Strategy

Workbench uses layered tests so failures identify the broken boundary without
requiring a live model provider.

## Required gates

| Gate                  | Purpose                                                                                                                  | Command                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Static                | Type-check shared code, scripts, and the extension.                                                                      | `deno task check`                                                                   |
| Synthetic             | Run deterministic unit, protocol, integration, packaging, and stress coverage.                                           | `deno task test:synthetic`                                                          |
| Synthetic integration | Exercise plugin hooks and persistence, HTTP, SSE, process management, event ordering, reconciliation, and final patches. | `deno task test:integration:synthetic`                                              |
| Stress                | Exercise FIFO ordering and backpressure with 20,000-event bursts.                                                        | `deno task test:stress`                                                             |
| Repeated stress       | Detect timing-sensitive failures by running each stress test five times.                                                 | `deno task test:stress:repeat`                                                      |
| Real integration      | Validate an installed OpenCode executable without sending a model request.                                               | `OPENCODE_INTEGRATION_EXECUTABLE=/absolute/path/to/opencode OPENCODE_INTEGRATION_VERSION=1.18.11 deno task test:integration:real` |
| ACP contract          | Compare an installed pinned OpenCode ACP executable with the sanitized provider-free fixture.                            | `OPENCODE_ACP_EXECUTABLE=/absolute/path/to/opencode OPENCODE_ACP_VERSION=1.18.15 deno task test:integration:acp` |
| Verifier contract     | Compare the isolated, tools-disabled verifier path with its pinned provider-free fixture.                                | `OPENCODE_VERIFIER_EXECUTABLE=/absolute/path/to/opencode OPENCODE_VERIFIER_VERSION=1.18.15 deno task test:integration:verifier` |
| Agent Host contract   | Compare an installed VS Code product and CLI with the pinned proposed-API and host fixture.                              | `VSCODE_PRODUCT_JSON=/path/to/resources/app/product.json VSCODE_EXECUTABLE=/absolute/path/to/code deno task test:integration:agent-host` |
| Harness UX            | Run the twelve provider-free lifecycle, queue, permission, recovery, isolation, run, diff, continuity, GitHub, and accessibility scenarios. | `deno task test:harness:ux`                                                  |
| Package               | Build and inspect the distributable VSIX.                                                                                | `deno task package`                                                                 |
| Release               | Re-run synthetic integration, Harness UX, and five-pass stress after verify, then write release metadata and checksums. | `deno task release`                                                                 |

`deno task verify` runs static checks, the synthetic suite (including one stress
run), and packaging. `deno task test:release` adds synthetic integration,
Harness UX, and five-pass repeated stress; the tag-triggered release workflow
runs `deno task release` and requires both layers before it writes metadata and
checksums, then attests and publishes those assets. Installed compatibility remains
separate: the real, ACP, and verifier gates require a compatible OpenCode
executable, while the Agent Host gate requires a compatible VS Code product and
CLI.

## Synthetic integration

Synthetic servers must use loopback networking and deterministic fixtures. They
should validate both the request contract and the resulting controller state.
Event tests should cover the complete path when practical:

1. Encode events as SSE frames.
2. Parse every frame through `OpenCodeClient.events()`.
3. Queue events through `OrderedEventBus`.
4. Reduce events into `SessionController` state.
5. Assert final `messagePatches()` content, revision, ordering, and active
   state.

Goal continuation tests must assert the complete admitted prompt payload and the
persisted lifecycle transition. A send-call count or "message sent" placeholder
is insufficient. Cover duplicate idle events, repeated idle-after-busy cycles,
canonical-plus-deprecated idle pairs, idle-before-error settlement, edit and
pause state, cancellation, terminal goals, limits, prompt-admission failure,
V2-only projection, and timeline presentation. Event-pipeline stress must retain
goal markers while interleaving them with the full delta burst.

Tests must not rely on arbitrary sleeps. Use explicit connection signals,
bounded polling for externally scheduled work, and deadlines that report the
failed condition.

## Real integration

The real suite starts `OPENCODE_INTEGRATION_EXECUTABLE` through
`ManagedOpenCodeServer` in a temporary workspace. It verifies authentication,
health, SSE, runtime service shapes, bundled-plugin command and tool discovery,
provider-free synthetic continuation admission, session lifecycle, fork,
history, and deletion. It must not send prompts to a model provider.

Set `OPENCODE_INTEGRATION_VERSION` when the expected executable version differs
from the minimum supported version. The suite must always stop the server,
delete created sessions, and remove its temporary workspace.

## Stress invariants

Stress tests must be deterministic and assert invariants rather than timing:

- Every accepted SSE frame is observed exactly once and in wire order.
- FIFO event handling continues after an isolated handler failure.
- Interleaved message streams retain per-message ordering.
- Reconciliation never replaces newer live parts with stale snapshots.
- The final patch contains the complete text, latest revision, and terminal
  session state.
- Publication remains serialized when a consumer applies backpressure.

The default burst size is 20,000 events. Increase it only when the additional
runtime detects a distinct failure mode.

## Feature checklist

Each new transport or UI feature should add the smallest applicable layers:

1. A unit test for parsing, validation, or state reduction.
2. A synthetic integration test for the boundary crossed by the feature.
3. A regression test for ordering, reconnect, stale snapshot, or failure
   recovery when state spans multiple events.
4. A real contract assertion when the feature depends on OpenCode behavior.
5. A stress assertion when the feature processes streamed or bursty data.

Keep real tests provider-free so they remain safe to run repeatedly and in CI.

## Harness UX scenarios

`deno task test:harness:ux` is the named scripted scenario gate required by the
implementation plan. It composes the existing boundary tests instead of
duplicating their fixtures. The exact mapping and limitations are recorded in
[`docs/testing/harness-ux-scenarios.md`](docs/testing/harness-ux-scenarios.md).
The accessibility automation and Extension Development Host smoke procedure are
recorded in
[`docs/testing/accessibility-smoke.md`](docs/testing/accessibility-smoke.md).

## ACP contract recording

`deno task record:acp-contract` launches the pinned OpenCode `1.18.15` ACP
subprocess with isolated HOME/XDG directories and the bundled companion plugin.
It records initialization, session lifecycle and persistence, model/mode
selection, commands, cancellation, malformed input, process termination,
working-directory filtering, and simultaneous processes. The normalized fixture
contains no local paths, session IDs, credentials, prompts, or model output.

The default recorder never sends `session/prompt`. The explicit
`--allow-model-prompt` option is an opt-in real provider seam and must write to
a separate review artifact, not silently replace the provider-free fixture.

## Agent Host and verifier contracts

The Agent Host feasibility test compares an installed VS Code product and CLI
with the pinned proposed-API allowlist and host options:

```bash
VSCODE_PRODUCT_JSON=/path/to/resources/app/product.json VSCODE_EXECUTABLE=/absolute/path/to/code \
  deno task test:integration:agent-host
```

The verifier recorder creates an isolated, tool-denied OpenCode agent and
separate session. Its default `noReply` probe never contacts a model:

```bash
OPENCODE_VERIFIER_EXECUTABLE=/absolute/path/to/opencode OPENCODE_VERIFIER_VERSION=1.18.15 \
  deno task test:integration:verifier
```
