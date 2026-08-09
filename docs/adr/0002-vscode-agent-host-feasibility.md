# ADR 0002: VS Code Agent Host connectivity is not a public extension contract

- Status: Accepted
- Date: 2026-08-08
- Decision scope: AHP-001 feasibility only
- Tested build: VS Code Stable `1.131.0`
  (`e4c7e7b1d6d060162f4aa7f8225271b67ce1df75`, x64)

## Context

VS Code now ships an Agent Host and the open Agent Host Protocol (AHP). The
protocol being open does not by itself prove that a Marketplace extension can
register a new agent runtime with VS Code's native Chat or Agents surfaces.
Workbench needs a public, reproducible connection path before native mode may
become a production dependency.

The official architecture describes an independently running host, remote AHP
over WebSocket, session continuation without a client, and client-contributed
tools that disappear when their extension client disconnects. It also says the
feature is under active development and illustrates agent adapters running
inside the host. See [VS Code Agent Host architecture][agent-host].

## Reproducible probe

Run against an installed VS Code product:

```bash
deno task probe:agent-host -- \
  --product-json /usr/share/code/resources/app/product.json \
  --code /usr/bin/code
```

The normalized result for Stable 1.131.0 is checked in at
`packages/vscode-extension/test/fixtures/ahp/vscode-1.131.0.json`. The probe:

1. records the CLI build;
2. records every `code agent host --help` option;
3. reads the product's explicit proposed-API allowlist;
4. compares the installed Workbench identity with the native-session proposals;
5. inspects Workbench's manifest without changing it.

The CLI can launch, secure, replace, and tunnel the Microsoft Agent Host. It
does not accept an adapter, backend, harness, plugin, or agent executable. The
native session APIs are proposed and allowlisted. `chatSessionsProvider` is
enabled for `GitHub.copilot-chat`, `GitHub.vscode-pull-request-github`, and
`openai.chatgpt`; it is not enabled for `nulifyer.opencode-workbench`.

Enabling a proposed API with a development CLI switch is not a Marketplace
contract and does not satisfy the production requirement.

## Matrix

| Environment                                  | Result                            | Evidence or limitation                                                                                                                 |
| -------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Stable, local, trusted                       | Blocking registration result      | Executable and product probe above                                                                                                     |
| Stable, local, untrusted                     | Same registration block           | Trust cannot grant an unavailable API; no runtime session was started                                                                  |
| Stable, GitHub signed out / Copilot disabled | Same registration block           | The standalone CLI exists, but native shell availability and Workbench registration are separate concerns                              |
| Stable, Marketplace install                  | Blocking                          | Installed `nulifyer.opencode-workbench@0.4.6` has no allowlist entry                                                                   |
| Stable, development host                     | Prototype-only escape hatch       | `--enable-proposed-api` can aid experiments but cannot ship as a Marketplace dependency                                                |
| Insiders                                     | Not installed on the test machine | Public documentation still labels Agent Host as actively developing; re-probe is required before reconsideration                       |
| Remote SSH                                   | Not exercised                     | The public architecture supports a remote host, but there is still no public Workbench adapter registration path                       |
| code-server / non-Microsoft distributions    | Unsupported/unknown               | The tested Microsoft product owns the CLI, allowlist, native shell, and built-in adapters; no portable registration contract was found |

The unavailable matrix entries do not weaken the stop result: the required
public registration contract is absent in the current Stable product itself.

## Answers to AHP-001 questions

1. A standalone host is configured through `code agent host` transport and
   security flags. No public custom-adapter discovery mechanism was found.
2. A normal Marketplace extension cannot call the allowlisted session-provider
   API under its own identity.
3. Therefore Workbench cannot publicly add OpenCode to the native harness
   picker.
4. The CLI can select how the Microsoft host is reached, not inject a
   third-party adapter into that host.
5. VS Code documents shared sessions across Chat and the Agents window, but
   Workbench cannot register such a session provider through a public API.
6. Native worktree and changeset behavior belongs to the native session stack;
   it is not available to an unregistered Workbench harness.
7. Connected extension tools can reach a host session when that host integrates
   them; by default they are unavailable once the editor extension disconnects.
8. A running host can continue a turn after all editor clients disconnect.
9. The host endpoint uses a connection token by default. The Agents window has
   additional GitHub/Copilot prerequisites documented by VS Code.
10. AHP itself is public. Native session registration, Agents-window
    configuration, session workspace, and customization-provider APIs are
    proposed/allowlisted in the tested product. Host adapter internals are not
    an extension API.
11. No public native-session deep-link contract was proven. Standard VS Code
    commands can continue to open the Workbench view.
12. Non-Microsoft distributions are not assumed to carry Microsoft's Agent Host
    binary, adapters, allowlists, or shell. Stable Workbench remains portable
    because it does not depend on them.

## Decision

Do not build a production or experimental native bridge on private assumptions.
Add no production dependency and continue stable-mode work. Re-run the checked
probe when VS Code publishes a stable third-party host/provider registration
contract.

This is a blocking result for native mode only. It is not a blocker for the
stable Workbench plan.

[agent-host]: https://code.visualstudio.com/docs/agents/concepts/agent-host
