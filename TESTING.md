# Testing Strategy

Workbench uses layered tests so failures identify the broken boundary without
requiring a live model provider.

## Required gates

| Gate | Purpose | Command |
| --- | --- | --- |
| Static | Type-check shared code, scripts, and the extension. | `deno task check` |
| Synthetic | Run deterministic unit, protocol, integration, packaging, and stress coverage. | `deno task test:synthetic` |
| Synthetic integration | Exercise HTTP, SSE, process management, event ordering, reconciliation, and final patches. | `deno task test:integration:synthetic` |
| Stress | Exercise FIFO ordering and backpressure with 20,000-event bursts. | `deno task test:stress` |
| Repeated stress | Detect timing-sensitive failures by running each stress test five times. | `deno task test:stress:repeat` |
| Real integration | Validate an installed OpenCode executable without sending a model request. | `deno task test:integration:real` |
| Package | Build and inspect the distributable VSIX. | `deno task package` |

`deno task verify` runs static checks, the synthetic suite (including one stress
run), and packaging. Repeated stress is scheduled or run manually because it
repeats the most expensive deterministic tests. Real integration is separate
because it requires an external executable.

## Synthetic integration

Synthetic servers must use loopback networking and deterministic fixtures. They
should validate both the request contract and the resulting controller state.
Event tests should cover the complete path when practical:

1. Encode events as SSE frames.
2. Parse every frame through `OpenCodeClient.events()`.
3. Queue events through `OrderedEventBus`.
4. Reduce events into `SessionController` state.
5. Assert final `messagePatches()` content, revision, ordering, and active state.

Tests must not rely on arbitrary sleeps. Use explicit connection signals,
bounded polling for externally scheduled work, and deadlines that report the
failed condition.

## Real integration

The real suite starts `OPENCODE_INTEGRATION_EXECUTABLE` through
`ManagedOpenCodeServer` in a temporary workspace. It verifies authentication,
health, SSE, runtime service shapes, session lifecycle, fork, history, and
deletion. It must not send prompts to a model provider.

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
