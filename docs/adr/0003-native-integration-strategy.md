# ADR 0003: Defer native Agent Host integration

- Status: Accepted
- Date: 2026-08-08
- Decision: `defer-native`

## Context

The plan permits `native-first`, `hybrid`, or `defer-native`. Experimental
native mode requires a public VS Code connection path, exact lifecycle and
permission mapping, cancellation, single worktree/change ownership, reconnect,
capability negotiation, and no forced provider/account duplication.

ADR 0002 proves a stop condition on VS Code Stable 1.131.0: third-party native
session registration depends on proposed, product-allowlisted APIs, and the
standalone Agent Host CLI has no public adapter injection mechanism. MAP-001
also leaves OpenCode permission choices, durable questions, and queue semantics
without a proven lossless ACP path.

## Decision

Select `defer-native`.

- Phase N (`NAT-001` through `NAT-010`) is skipped as directed by the
  implementation plan.
- Stable Workbench remains the only supported authority and UI mode.
- No Agent Host, proposed VS Code API, Copilot authentication, or provider SDK
  becomes a production dependency.
- The custom Work tree remains necessary and the Phase 3 fallback Git path
  (`WT-002B`) is selected.
- Stable lifecycle/protocol work must still use transport-independent canonical
  types so a future adapter does not require another rewrite.

This decision reduces no stable-mode feature requirement. It prevents an
unshippable native experiment from becoming a hidden product dependency.

## Reconsideration gate

Reconsider only after all of the following are reproducibly true:

1. VS Code publishes a stable third-party agent-provider/host registration API
   usable by a normal Marketplace extension.
2. A standalone host can load an OpenCode-backed adapter without product source
   changes or extension-ID allowlisting.
3. OpenCode ACP proves exact permission, question, cancellation, queue, and
   settlement behavior against a pinned executable.
4. Worktree/change ownership and reconnect recovery pass the planned soak tests.
5. Native Chat and Agents surfaces do not impose an incompatible provider or
   billing identity.

Until then, the checked Agent Host probe is the version gate and stable mode is
the one supported product path.
