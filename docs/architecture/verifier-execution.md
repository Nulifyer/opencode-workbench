# Independent verifier execution contract

Status: VER-001 baseline, OpenCode 1.18.15, 2026-08-08

## Selected path

The verifier runs in a separate OpenCode session through the user's OpenCode
runtime and model selection. Production uses the configured verifier agent, or
the read-only `plan` agent by default. It does not call a provider SDK directly
and it never reuses the implementation session as a hidden evaluator.

Every production request disables all tools. The provider-free compatibility
recorder additionally proves that OpenCode accepts a dedicated
`workbench-verifier` agent with wildcard-denied permissions:

```json
{
  "agent": {
    "workbench-verifier": {
      "mode": "primary",
      "permission": { "*": "deny" }
    }
  },
  "request": {
    "tools": { "*": false },
    "format": {
      "type": "json_schema",
      "retryCount": 2
    }
  }
}
```

The production request supplies a bounded schema with `verdict`, `reason`,
`missingCriteria`, and `confidence`, plus typed evidence input. The verifier may evaluate only evidence explicitly
assembled by Workbench. It receives no filesystem or editor bridge tools.

## Reproducible evidence

Run the provider-free recorder:

```bash
deno task record:verifier-contract -- \
  --executable /absolute/path/to/opencode \
  --expected-version 1.18.15
```

The checked fixture is
`packages/vscode-extension/test/fixtures/verifier/opencode-1.18.15.json`. Its
isolated HOME/XDG directories contain no copied credentials. The recorder
creates the custom agent and a distinct session, admits a `noReply` structured
prompt, verifies the selected model and wildcard deny state, tests interruption,
and removes the session and storage. `noReply` is the provider-free seam: it
exercises admission and persistence without creating an assistant response.

## Required behavior

| Concern                   | Decision                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Model selection           | Store the exact OpenCode provider/model/variant selected for the verifier run. Do not introduce a second account or provider configuration. |
| Schema enforcement        | Use OpenCode `json_schema`, then validate the returned value again inside Workbench before accepting a verdict.                             |
| Timeout/cancellation      | Workbench owns an absolute deadline, sends OpenCode interrupt, and ignores any event from an expired execution generation.                  |
| Transcript visibility     | Retain the separate verifier session ID and bounded attempt/result metadata in the generated report and deterministic evidence ledger.      |
| Filesystem/tool isolation | Require both agent wildcard deny and request wildcard false. Any tool event fails the verifier run.                                         |
| Token accounting          | Read authoritative usage from OpenCode's verifier assistant message; unknown remains unknown rather than zero.                              |
| Retry                     | Workbench owns a small explicit retry budget and records every attempt with timestamps, outcome, and available session/usage metadata.       |
| Provider-free tests       | Use `noReply`; tests must assert that no assistant message or provider request was produced.                                                |

## OpenCode 1.18.15 compatibility finding

OpenCode 1.18.15 accepts `format.type = "json_schema"` and `retryCount`, but its
legacy transcript response rejects the stored structured-output value because
the runtime materializes `retryCount` while that endpoint's response schema does
not accept it. The provider-free v2 message projection is empty. Therefore:

- schema output, token accounting, and readable provider transcript require an
  explicit opt-in model integration test;
- Workbench must not depend on OpenCode's `retryCount` for safety;
- Workbench stores the bounded verifier attempt/result projection itself and
  records an attributable criterion-evidence reference;
- cancellation is exposed through VS Code progress and interrupts the separate
  OpenCode session;
- applying a result carries the exact expected settlement generation into the
  plugin tool, so a goal change between admission and tool execution rejects the
  stale verdict atomically;
- this limitation does not authorize a direct provider SDK fallback.

The runtime implementation for structured output is documented in OpenCode's
official [`session/prompt.ts`][prompt-source]; custom agent permission behavior
is documented in [OpenCode agents][agents].

[prompt-source]: https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/session/prompt.ts
[agents]: https://opencode.ai/docs/agents
