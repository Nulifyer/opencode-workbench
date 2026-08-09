# OpenCode Workbench

Bring your existing [OpenCode](https://opencode.ai) coding agent into VS Code.
OpenCode Workbench gives you a native place to chat, review changes, answer
permission requests, plan work, and compare approaches without replacing the
OpenCode runtime you already use.

OpenCode still owns the models, agents, tools, sessions, permissions, and
transcripts. Workbench makes those capabilities comfortable to use alongside
your editor, source control, terminal, and debugger.

## What you can do

- Work with multiple OpenCode sessions without leaving VS Code.
- Attach the file, selection, unsaved buffer, diagnostic, or other editor
  context you choose.
- See streaming answers, reasoning summaries, tool activity, changed files,
  todos, questions, and permission requests in one conversation.
- Plan first, edit the plan, and explicitly hand it off to an implementation
  session, isolated worktree, model comparison, or goal.
- Run the same task with two to five models in isolated worktrees and compare
  their observable results without an automatic “winner.”
- Review the exact current diff with walkthroughs, model-labeled findings, test
  evidence, and native VS Code diff navigation.
- Keep a bounded goal moving across turns, with limits and an independent,
  tools-disabled verifier that you choose when to apply.

Workbench does not add another model loop, provider configuration, transcript
database, terminal emulator, or browser. The normal OpenCode TUI remains
available whenever you want it.

## Before you start

You need:

- VS Code 1.106 or newer;
- a supported OpenCode 1.18.x release (1.18.11 or newer);
- a trusted workspace folder; and
- at least one model provider configured in OpenCode.

If OpenCode is new to you, install and configure it from the
[OpenCode website](https://opencode.ai), then confirm that `opencode` runs in a
terminal before opening Workbench.

## Install

Install **OpenCode Workbench** from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=nulifyer.opencode-workbench),
or install the VSIX from the latest
[GitHub release](https://github.com/Nulifyer/opencode-workbench/releases/latest).

The extension ID is `nulifyer.opencode-workbench`.

## Five-minute start

1. Open the folder you want OpenCode to work in.
2. Open the OpenCode icon in VS Code's Secondary Side Bar, or run
   **OpenCode: Open Chat** from the Command Palette.
3. Choose **New session**.
4. Select an agent and model at the bottom of the chat.
5. Describe the task and press `Enter`. Use `Shift+Enter` for a new line.

Workbench starts in **managed mode**. It finds your installed `opencode`
executable, starts a private authenticated server for this VS Code window, and
loads the companion features without changing your OpenCode configuration.

Open **OpenCode: Open Chat in Editor** when you want a wider conversation with
the session and run rail. Your sidebar and editor surfaces stay synchronized.

The header switches sessions and opens **Needs Attention** or the Inspector.
The conversation stays in the center, while the composer at the bottom owns
the exact draft, model, agent, permission mode, and attachments for that
session. Editor mode adds a rail for sessions and model runs; the Inspector is
a separate panel for activity, changes, context receipts, goals, runs, and
walkthroughs.

## Everyday workflows

### Ask, build, and follow up

Start with ordinary prompts such as:

```text
Explain how authentication works in this project.
Fix the failing parser test and show me what changed.
Review the current changes for correctness and missing tests.
```

If a session is already working, the send menu lets you decide what the new
instruction means:

- **Steer current work** delivers it at OpenCode's next safe boundary.
- **Follow up after completion** queues it for the next turn.
- **Replace queued instruction** stops the current work and admits the new
  instruction next.

Workbench keeps each session's draft and pending context separate. Background
status, unread indicators, and **Needs Attention** help you move between active
sessions without losing your place.

### Give OpenCode the right context

Use the paperclip, `@` file search, or **OpenCode: Add to Chat** from an editor
or Explorer context menu for files, folders, selections, unsaved buffers,
notebooks, MCP resources, images, PDFs, and pasted text.

Run **OpenCode: Attach Browser/Debug Context** when you explicitly want to add
a repository diagnostic summary, bounded VS Code debug metadata, a screenshot,
one approved HTTP(S) URL, or one clipboard excerpt that you identify as console
output, element metadata, or terminal/task text. Workbench sends the full
approved URL to OpenCode but does not fetch it; the durable receipt keeps only a
sanitized URL identity, without credentials, query, or fragment.

The composer shows what will be sent. After admission, the conversation keeps
a compact receipt describing the context—not a hidden copy of its contents.

When OpenCode asks for permission, read the exact operation and choose whether
to allow it once, allow the shown scope, or reject it. Incomplete or truncated
permission detail cannot be approved.

### Plan before implementation

Run **OpenCode: Plan Task** or use the Plan-first action in Workbench. A
read-only OpenCode session prepares an untitled Markdown plan that you can edit
without writing it into the repository.

When it is ready, run **OpenCode: Handoff Approved Plan** and choose where the
work should continue:

- the current checkout;
- a new isolated worktree;
- a two-to-five-model comparison; or
- the active session goal.

If you start editing while OpenCode is still preparing its answer, your draft
is preserved and the generated plan opens separately for comparison.

### Start from a GitHub issue or pull request

Run **OpenCode: Handoff GitHub Issue or Pull Request** and paste a canonical
GitHub URL. Workbench uses VS Code's existing GitHub sign-in to read a bounded
snapshot of the title, metadata, body, and—for pull requests—changed files and
available patch excerpts. It does not ask for or store a separate token.

The recommended choice starts the task in an isolated worktree. The attached
context document states any body, file, or patch limits and any
sensitive-looking values that were redacted; the context receipt marks a
partial snapshot explicitly. If GitHub Pull Requests and Issues is installed,
Workbench can offer its native view or PR-changes surface after the handoff.
See [GitHub handoff](docs/guides/github-handoff.md) for the exact contents,
limits, and privacy behavior.

### Compare isolated approaches

Use **OpenCode: Compare Models** to run one prompt in separate Git worktrees.
Each run has its own OpenCode session, branch, status, and diff. The comparison
shows elapsed time, changed files, diff totals, recorded tasks and diagnostics,
goal/verifier state, and any reliable usage data. Missing evidence is labeled
rather than guessed.

Run **OpenCode: Fuse Run Approaches** when you want OpenCode to synthesize the
recorded approaches. Fusion starts in a fresh isolated worktree with bounded
source records; it does not merge, cherry-pick, push, or publish a result.

If an isolated run opens in another VS Code window, its compact context receipt
goes with it and recorded evidence can return to the original comparison. This
continuity uses private, bounded metadata in the repository's Git data; it does
not copy the prompt, attachments, task output, or source files.

You decide which result to keep. Workbench never merges, cherry-picks, pushes,
or publishes a run automatically. Dirty worktrees are retained until you deal
with their changes explicitly.

### Understand and review changes

Use these commands from the Command Palette:

- **OpenCode: Generate Changes Walkthrough** explains an exact diff as an
  ordered tour.
- **OpenCode: Review Changes** creates separately labeled model findings.
- **OpenCode: Run Task and Capture Evidence** records a task exit result and
  the current VS Code diagnostics for the selected session.
- **OpenCode: Open Run Native Diff** opens an isolated result in VS Code's diff
  editor.

Walkthrough and review links are tied to an exact diff and hunk. Workbench asks
you to regenerate them when the repository changes instead of navigating with
stale locations. Untracked files are included in working-tree reviews.

### Keep a goal moving

Create a goal with `/goal <objective>`. The companion plugin can continue an
active goal when a turn would otherwise stop, while respecting token, duration,
and auto-turn limits. `/goal-unlimited <objective>` is an explicit choice to
remove those limits.

Use the Goal inspector or `/goal edit`, `/goal pause`, `/goal resume`, and
`/goal cancel` to stay in control. **OpenCode: Verify Active Goal** runs a
bounded independent verifier with no tools and no automatic approval. Its
verdict is advisory until you apply it, and a result produced against an older
goal revision is rejected.

## Managed and external servers

Managed mode is recommended for most people. Every VS Code window gets its own
loopback server and temporary credentials, and the process stops with the
window.

Choose `external` for `opencodeWorkbench.serverMode` only when you already run
an OpenCode server yourself. Start that server with authentication, set
`opencodeWorkbench.serverUrl` and `opencodeWorkbench.serverUsername`, then run
**OpenCode: Set External Server Password**. The password goes to VS Code Secret
Storage, never workspace settings.

Plain HTTP is accepted only for numeric loopback addresses. Remote servers must
use HTTPS. Companion-plugin features are shown as unavailable when an external
server does not advertise them.

## Useful settings

| Setting | Default | What it changes |
| --- | --- | --- |
| `opencodeWorkbench.serverMode` | `managed` | Use Workbench's private server or your external server. |
| `opencodeWorkbench.executablePath` | Empty | Use a specific OpenCode executable instead of searching `PATH`. |
| `opencodeWorkbench.managedServerStartupTimeout` | `120` | Allow more startup time on slower systems. |
| `opencodeWorkbench.serverUrl` | `http://127.0.0.1:4096` | Address of an external OpenCode server. |
| `opencodeWorkbench.enterBehavior` | `send` | Make Enter send or insert a new line. Ctrl/Cmd+Enter always sends. |

## Privacy and safety

- Managed servers listen only on loopback and use temporary random credentials.
- The chat webview has no network access.
- Workspace bridge operations are allowlisted, bounded, and contained to the
  selected workspace root.
- Workbench never stores complete prompts, attachment bytes, unsaved-buffer
  contents, screenshots, provider secrets, or GitHub credentials in its
  metadata.
- Isolated windows exchange only bounded receipt and evidence metadata through
  a private file in the repository's shared Git data, with owner-only
  permissions where the OS supports them. The file expires old records and
  never appears as an untracked worktree file.
- Preferences require approval, skills remain staged candidates, and
  destructive actions still use OpenCode's normal permission safeguards.
- Worktree creation, cleanup, branch deletion, session deletion, and result
  integration remain separate user actions.

## Troubleshooting

**Workbench cannot find OpenCode**

Run `opencode --version` in a terminal opened from VS Code. If VS Code has a
different `PATH`, set the absolute `opencodeWorkbench.executablePath` and reload
the window.

**The server takes too long to start**

Increase `opencodeWorkbench.managedServerStartupTimeout`, especially when
antivirus or endpoint protection scans new processes.

**Models are missing**

OpenCode supplies the model catalog. Confirm the provider works in the normal
OpenCode TUI, then run **OpenCode: Refresh**. Workbench does not infer provider
subscriptions or invent unavailable models.

**A session or run needs input**

Open **Needs Attention** and select the permission, question, failed run, or
connection problem. **OpenCode: Show Health Center** reports the current server,
plugin, protocol, event-stream, and queue state. The sanitized trace command is
available when a bug report needs lifecycle detail without prompt contents.

**An isolated worktree will not delete**

Workbench retains dirty worktrees deliberately. Commit, move, or discard the
changes yourself, then run **OpenCode: Remove Worktree**. After removal, run
**OpenCode: Delete Removed Worktree Branch** if you also want to delete its
branch.

## More documentation

- [Changelog](CHANGELOG.md) — user-visible additions, fixes, and security work.
- [Testing strategy](TESTING.md) — contributor commands and release gates.
- [Extension design](packages/vscode-extension/DESIGN.md) — architecture,
  protocol, persistence, and trust boundaries.
- [GitHub handoff](docs/guides/github-handoff.md) — native sign-in, attached
  context, explicit limits, and isolated implementation.
- [Architecture decisions](docs/adr/) — native integration and contract
  decisions.
- [Skill lifecycle](SKILL-LIFECYCLE.md) — how skill candidates are reviewed and
  activated.

Development requires Deno 2.9 or newer. Contributors can start with
`deno task check`, `deno task test:synthetic`, and `deno task package`; the full
matrix and feature checklist live in [TESTING.md](TESTING.md).
