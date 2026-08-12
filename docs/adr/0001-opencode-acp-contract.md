# ADR 0001: Record the OpenCode ACP contract before implementing an adapter

- Status: Accepted
- Date: 2026-08-08
- Decision scope: ACP-001 discovery only
- Recorded executable: OpenCode `1.18.15`
- Embedded ACP SDK: `@agentclientprotocol/sdk` `0.21.0`
- ACP protocol: `1`

## Context

OpenCode Workbench stable mode uses OpenCode HTTP/SSE and must preserve native
session, prompt, permission, question, plugin, and lifecycle semantics. OpenCode
also offers `opencode acp`, but its broad feature statement is not evidence that
every Workbench contract maps losslessly.

The discovery boundary must be provider-free by default. A test may create,
list, fork, load, resume, configure, close, and cancel an idle session; it may
not send `session/prompt` unless the operator explicitly opts in.

Primary implementation references for the pinned version are OpenCode's
[`agent.ts`](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/acp/agent.ts),
[`service.ts`](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/acp/service.ts),
and [`acp.ts`](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/cli/cmd/acp.ts).
The checked fixture, however, is derived from executable behavior rather than
source inspection.

## Decision

Maintain a checked-in normalized contract fixture and a recorder that launches
the exact executable directly with typed arguments, isolated HOME/XDG storage,
the bundled companion plugin, bounded deadlines, deterministic process cleanup,
and no shell.

Default recording does not call `session/prompt`. The recorder provides a
separate `--allow-model-prompt` seam which prints a warning, identifies the
result as opt-in, cancels after a bound, and rejects client permission requests
rather than approving actions. That seam is not part of normal tests.

Do not implement a production ACP adapter in this issue. Later mapping and
native-strategy ADRs must consume the facts below and retain stable HTTP/SSE
whenever ACP cannot preserve semantics.

## Recorded transport

- JSON-RPC 2.0 messages are newline-delimited JSON over stdin/stdout.
- `initialize` returns protocol version `1`, OpenCode agent info, one
  `opencode-login` authentication method, and capabilities.
- Agent capabilities advertise `loadSession`, HTTP/SSE MCP registration,
  embedded context, images, and session close/fork/list/resume.
- `session/update` is the only agent-to-client notification observed without a
  model turn. Its observed update kind is `available_commands_update`.
- An unknown request returns `-32601`; invalid parameters return `-32602`.
- A malformed NDJSON line is reported on stderr but does not terminate the
  process; a subsequent request succeeds.
- Closing stdin exits cleanly. SIGTERM is observable as a non-clean exit.

### Exact client-to-agent request methods observed

```text
authenticate
initialize
session/close
session/fork
session/list
session/load
session/new
session/resume
session/set_config_option
session/set_mode
session/set_model
```

`workbench/unknown` is also sent intentionally to prove the method-not-found
contract. `session/cancel` is a notification, not a request.

### Session behavior

- `session/new` returns a canonical OpenCode session ID and configuration
  options. The isolated fixture exposes `model` and `mode`; modes are `build`
  and `plan`.
- Model and mode changes work through `session/set_config_option`; the older
  `session/set_model` and `session/set_mode` methods also return success.
- `session/list` accepts `cwd` and returns only sessions for that directory in
  the two-process probe.
- `session/fork` returns a distinct OpenCode session ID.
- `session/load` and `session/resume` accept an existing backing session. Load
  is the replay-oriented operation; resume does not request transcript replay.
- `session/close` releases the live ACP session mapping and aborts active work;
  it does not delete the backing OpenCode session.
- Backing sessions remain listable and resumable after the ACP process restarts.
- Two ACP subprocesses can run simultaneously against distinct directories.

### Discovery behavior

- The bundled companion plugin loads through `OPENCODE_CONFIG_CONTENT`.
- `/goal` and `/goal-unlimited` appear in
  `available_commands_update`, alongside ordinary OpenCode commands.
- `/undo` and `/redo` do not appear.
- There is no provider-free tool-list or tool-schema message. Companion goal,
  preference, skill, and editor-bridge tools therefore remain undiscovered at
  the ACP wire boundary until a model turn uses them.
- MCP HTTP and SSE registration is advertised, but MCP tool inventory was not
  observed provider-free.

## Capability classification

| Capability                                              | Classification | Reason                                            |
| ------------------------------------------------------- | -------------- | ------------------------------------------------- |
| Initialize/capabilities                                 | Supported      | Exact response recorded                           |
| Session new/list/load/resume/fork/close                 | Supported      | Provider-free probes, including restart           |
| Working-directory filtering and concurrent subprocesses | Supported      | Two isolated cwd probes                           |
| Agent/mode and model selection                          | Supported      | Config options and setters recorded               |
| Variant/effort selection                                | Unknown        | Default isolated model exposed no `effort` option |
| Slash-command and companion-command discovery           | Supported      | `available_commands_update`                       |
| Tool and companion-tool schema discovery                | Missing        | No provider-free ACP operation/update             |
| MCP registration                                        | Supported      | Initialized capabilities and session setup input  |
| MCP tool discovery                                      | Unknown        | No provider-free inventory update                 |
| Permission request/choices                              | Unknown        | Requires a tool/model turn                        |
| Questions/user input                                    | Unknown        | No provider-free trigger                          |
| Prompt, reasoning, tools, diffs, usage/cost             | Unknown        | Default recorder forbids model requests           |
| Idle cancellation                                       | Mapped         | `session/cancel` notification accepted            |
| Active cancellation                                     | Unknown        | Requires opt-in prompt                            |
| Queue/steer/follow-up/replace                           | Missing        | No distinct method or capability                  |
| `/undo` and `/redo`                                     | Missing        | Not advertised                                    |
| Malformed input recovery                                | Supported      | Later `session/list` succeeds                     |
| Process restart/crash                                   | Mapped         | Persistence proven; in-flight outcome unknown     |

The fixture at
`packages/vscode-extension/test/fixtures/acp/opencode-1.18.15.json` is the
machine-checked version of this table.

## Security and privacy consequences

- The recorder removes inherited `OPENCODE_*` and secret-like environment
  values, uses fresh HOME/XDG directories, and deletes the exact temporary root.
- The committed fixture contains capabilities, method/update names, normalized
  observations, and classifications only. It contains no local path, OpenCode
  session ID, prompt, credential, tool output, or model response.
- The subprocess is launched without `shell: true` and receives a fixed argument
  structure.
- Malformed-parser stderr is not committed because it can contain local binary
  paths and implementation stacks.
- The opt-in prompt seam rejects permission requests and is never enabled by
  ordinary synthetic, integration, stress, or package gates.

## Compatibility and drift policy

The fixture is pinned to OpenCode `1.18.15`. A real conformance run fails before
recording when the executable version differs. For the same version it compares
a normalized compatibility signature containing:

- protocol and advertised capabilities;
- request and notification method inventories;
- config option/mode and companion-command inventories;
- JSON-RPC error codes; and
- every capability classification.

Version or signature drift requires explicit review and a newly named fixture;
tests must not silently rewrite the existing contract.

## Commands

```sh
deno task record:acp-contract

OPENCODE_ACP_EXECUTABLE=/absolute/path/to/opencode \
OPENCODE_ACP_VERSION=1.18.15 \
deno task test:integration:acp
```

The optional model seam is deliberately separate:

```sh
deno task build
deno run -A scripts/record-opencode-acp-contract.ts \
  --allow-model-prompt \
  --output /an/explicit/nonfixture/path.json
```

## Consequences

- ACP session and command behavior now has deterministic, sanitized evidence.
- A newer OpenCode executable or changed same-version contract fails clearly.
- Production ACP remains unimplemented.
- Native integration remains blocked on AHP discovery, lossless mapping, exact
  permissions/questions, queue semantics, and a later strategy ADR.
