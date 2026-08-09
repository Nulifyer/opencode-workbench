# Hand off a GitHub issue or pull request

Use **OpenCode: Handoff GitHub Issue or Pull Request** when the task already
lives on GitHub and you want OpenCode to start with that context.

1. Copy the canonical `https://github.com/owner/repository/issues/123` or
   `https://github.com/owner/repository/pull/123` URL.
2. Run the command from the Command Palette and paste the URL.
3. Complete VS Code's normal GitHub sign-in prompt if it appears.
4. Choose the recommended isolated worktree or the current checkout.

The isolated choice is listed first because it gives implementation work its
own Workbench-owned branch and checkout. Workbench does not merge, push, or
publish the result automatically.

Before the isolated window opens, Workbench durably hands its compact admitted
context receipt to that linked worktree. The new window therefore shows what
GitHub snapshot was admitted without persisting the issue body or patch bytes a
second time. Evidence recorded in that standalone session remains with it;
returning evidence to an original comparison or Fusion workflow applies to runs
created by **OpenCode: Compare Models**.

## What is handed off

Workbench reads GitHub through VS Code's `github` authentication provider. It
does not implement OAuth, ask you to paste a token, or save the authentication
session. The credential is sent only as an in-memory authorization header to
`api.github.com` during the explicit command.

The attached `github-handoff.md` contains:

- issue or pull-request title, state, author, timestamps, labels, assignees,
  comment count, and body;
- pull-request base/head names and change totals;
- pull-request changed-file names, statuses, counts, and available REST patch
  excerpts;
- the active editor selection, only when you explicitly selected text; and
- exact coverage, omission, limit, and redaction notes.

Comment bodies, review conversations, checks, and repository secrets are not
collected. GitHub content is labeled as untrusted data, not as instructions.
Sensitive-looking tokens, authorization headers, credential assignments, URL
userinfo, and unsafe control characters are redacted before handoff.

## Limits and partial coverage

The command stays bounded even for very large issues and pull requests:

| Context | Limit |
| --- | ---: |
| Title | 1,024 bytes |
| Issue or pull-request body | 65,536 bytes |
| Labels / assignees | 50 / 20 |
| Changed files | First 100 files |
| Patch per changed file | 12,288 bytes |
| All included patches | 196,608 bytes |
| Optional editor selection | 102,400 bytes |
| GitHub metadata response | 1 MiB |
| GitHub changed-files response | 4 MiB |
| Each API request | 15 seconds |

Title, body, and patch clipping is reported as truncated, binary or unavailable
patches are reported as unavailable, and omitted changed files are counted.
The context receipt is marked **explicit** whenever the snapshot is partial.
An oversized editor selection or API response fails with a visible error
instead of being silently shortened.

## Native GitHub surfaces

The context handoff only needs VS Code's GitHub authentication provider. If the
**GitHub Pull Requests and Issues** extension is also installed, Workbench
feature-detects its view and offers native follow-up actions after admission.
For a pull request, GitHub Pull Requests and Issues 0.126.0 or newer can open
the PR changes directly in VS Code through its documented URI handler.
Otherwise the OpenCode handoff still works and no PR-changes action is shown.

Authentication failures, missing/private resources, rate limits, timeouts,
malformed responses, and oversized responses are reported without including
the access token or GitHub's remote error body.

For the underlying platform behavior, see the [VS Code authentication
API](https://code.visualstudio.com/api/references/vscode-api#authentication),
GitHub's [Issues REST API](https://docs.github.com/en/rest/issues/issues), and
[Pull request files REST API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files).
