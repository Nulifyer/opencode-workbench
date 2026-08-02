# Skill Development and Memory Lifecycle

## Purpose

OpenCode Workbench should support a Hermes-style improvement loop without
introducing a second agent runtime or allowing an agent to modify its durable
instructions without review. OpenCode remains responsible for model execution,
sessions, tools, and skill discovery. Workbench records bounded evidence,
coordinates drafting and review, activates approved skill packages, reloads the
OpenCode workspace, and returns the user to the same session.

The intended product behavior is:

1. Workbench notices repeated workflows, corrections, and failures.
2. The agent may propose a new skill or a change to an existing skill.
3. Workbench generates an isolated draft through OpenCode.
4. The user reviews the complete package diff.
5. Workbench atomically activates the approved version.
6. Workbench reloads OpenCode and restores the selected session.
7. Later evidence can propose revisions, merges, or retirement.

## Design Invariants

- An agent may propose a change. Workbench may activate an approved version;
  terminal maintenance may install an approved version only as pending restart.
- The global `skill-development` skill provides the lifecycle in every OpenCode
  instance, but it uses only tools and host capabilities actually available in
  that instance.
- Activation never occurs inside the proposing tool call. The tool call must
  return and the current agent turn must reach a terminal state first.
- No proposal, draft, or approval may silently resend a user prompt.
- Every active skill version must correspond to an approved immutable draft.
- Every update must identify the exact base version it was generated from.
- Project skills affect only their project. Global activation must not silently
  restart other VS Code windows.
- OpenCode's installed version defines the accepted skill package format.
  Workbench must not treat one historical `SKILL.md` layout as universal.
- Failed activation must restore the previous package and reload the previous
  state before prompt admission resumes.
- A terminal instance without a tested reload host may install an approved
  package as pending restart, but it must not restart itself or call the package
  active before a later instance verifies discovery.
- Memory values, evidence, generated drafts, and skill files are untrusted data.
  They never override system, developer, permission, or current user intent.

## Non-Goals

- Workbench does not implement a model loop, vector database, or autonomous
  background agent runtime.
- Workbench does not infer durable personal preferences from ordinary chat.
- Workbench does not install a skill merely because the agent generated it.
- Workbench does not resume a partially executing model turn after reload.
- Workbench does not execute generated scripts during structural validation.

## Concepts

### Preference Memory

Preference memory stores explicit user choices such as communication style,
tooling, and project workflow. Approved preferences are injected into the next
user message by the companion plugin. Preference changes do not require an
OpenCode reload.

Global and project preferences use the same `(category, key)` identity. An
approved project preference overrides the matching global preference. New
approval supersedes the previous value deterministically. Forgetting removes
the value from the next injection and replaces its persisted value with the
forgotten marker.

### Episodic Evidence

Episodic evidence records bounded facts about task outcomes. It is not a copy of
the transcript or raw tool output. A record may include:

- Event kind and normalized subject.
- Project scope.
- Session, message, and tool-call references.
- A stable error or workflow fingerprint.
- Outcome classification.
- A bounded user-approved summary when more context is needed.

Evidence references remain useful while the referenced session exists. A draft
must include a self-contained rationale because session retention is not
guaranteed.

### Procedural Memory

An active skill package is procedural memory. It contains reusable instructions
and any OpenCode-supported package files. Procedural memory is versioned,
reviewed, reloadable, and reversible.

### Candidate

A candidate describes a possible procedural change. Candidate kinds are:

- `create`: Add a new skill.
- `update`: Change an existing skill.
- `merge`: Replace overlapping skills with one package.
- `split`: Replace one oversized skill with focused packages.
- `move`: Change project or global scope.
- `retire`: Remove an obsolete skill from discovery.

### Global Skill Routing

The global `skill-development` skill coordinates evidence, proposals, review,
activation state, and later improvement. It delegates package writing, current
schema rules, discovery paths, and direct validation to `skill-maintenance`.

The trigger boundary is intentional:

- `skill-development` handles repeated workflows, recurring failures, user
  corrections, and evidence-backed improvement suggestions.
- `skill-maintenance` handles explicit one-off creation, editing, auditing,
  merging, archiving, and deletion, and package work delegated by
  `skill-development`.

A skill file supplies instructions rather than executable capabilities. It must
inspect the current tool catalog and never simulate a missing candidate,
memory, activation, reload, or bridge tool with shell commands.

## State Model

Candidates use these states:

```text
proposed
drafting
review
changes-requested
approved
activating
pending-reload
verifying
active
failed
rejected
superseded
retired
```

Allowed transitions are:

```text
proposed -> drafting | rejected
drafting -> review | failed
review -> approved | changes-requested | rejected
changes-requested -> drafting | rejected
approved -> activating
activating -> pending-reload | verifying | failed
pending-reload -> verifying | failed
verifying -> active | failed
failed -> drafting | approved | pending-reload | rejected
active -> superseded | retired
```

`approved` means the exact immutable artifact version was approved. Editing an
approved artifact creates another draft version and returns the candidate to
`review`.

Workbench normally moves from `activating` through `verifying` without a user
visible pause. Terminal installation without a reload host stops at
`pending-reload` until the user restarts OpenCode and requests verification.

## Durable Records

The plugin state schema must migrate from version 1 without discarding existing
preferences, evidence, or staged candidates. A candidate record should contain:

```ts
interface SkillCandidate {
  id: string
  scope: Scope
  kind: "create" | "update" | "merge" | "split" | "move" | "retire"
  name: string
  rationale: string
  evidenceIDs: string[]
  status: SkillCandidateStatus
  provenance: Provenance
  createdAt: number
  updatedAt: number
  target?: SkillTarget
  draftVersion?: string
  approvedVersion?: string
  activeVersion?: string
  failure?: ActivationFailure
}

interface SkillTarget {
  scope: "global" | "project"
  identifier: string
  expectedBaseDigest?: string
}
```

Draft versions are immutable manifests:

```ts
interface SkillDraftManifest {
  candidateID: string
  version: string
  createdAt: number
  openCodeVersion: string
  formatAdapter: string
  scope: Scope
  kind: SkillCandidateKind
  target: SkillTarget
  baseDigest?: string
  packageDigest: string
  files: Array<{ path: string; digest: string; bytes: number }>
  validation: ValidationReport
}
```

## Storage Layout

Plugin metadata remains under the owner-only Workbench data directory:

```text
$XDG_DATA_HOME/opencode-workbench/
  plugin/state.json
  skill-drafts/<candidate-id>/<version>/
    manifest.json
    package/
  skill-backups/<activation-id>/
    manifest.json
    package/
  activation-locks/
```

The default root is `~/.local/share/opencode-workbench` when `XDG_DATA_HOME` is
unset. Drafts and backups use mode `0700` directories and `0600` files where the
platform supports POSIX modes. State and manifests retain size limits and atomic
locking.

Active destinations are resolved by the version-specific OpenCode skill format
adapter. Candidate input cannot provide an arbitrary filesystem destination.

## Evidence Collection and Proposal Policy

The companion plugin should collect both legacy OpenCode events and durable
`session.next.*` events. Equivalent events must normalize to the same evidence
shape. Event storage remains bounded and deduplicated.

Proposal prompts should use aggregate signals rather than one isolated failure.
Recommended default thresholds are:

- The same workflow fingerprint succeeds in at least three sessions.
- The same failure fingerprint occurs at least three times.
- The user corrects the same behavior twice.
- The user explicitly asks to make a workflow reusable.

Thresholds create a suggestion opportunity, not an automatic model call. The
agent may also call `skill_candidate_propose` explicitly during a turn. The tool
stores metadata and returns normally; it cannot draft, write, reload, or
activate a skill.

Workbench presents proposals after the owning root session becomes idle. It
must not interrupt permission or question handling.

## Proposal UX

A proposal card contains:

- Candidate kind and proposed name.
- Project or global scope.
- Concise rationale.
- Evidence count and inspectable references.
- Existing skills that may overlap.
- Actions: **Generate draft**, **Later**, **Reject**, and **Never suggest this**.

`Never suggest this` creates an explicit suppression preference keyed by the
candidate fingerprint. It does not add an implicit memory.

## Draft Generation

Draft generation runs in a dedicated OpenCode child session using a skill-author
agent. This uses OpenCode's model loop and provider configuration. It does not
create another runtime.

The skill-author receives:

- The candidate and bounded evidence summaries.
- Explicitly selected transcript excerpts, when approved by the user.
- The current package for updates.
- The installed OpenCode version and format-adapter guidance.
- Destination scope without an arbitrary destination path.
- Validation constraints and package size limits.

Generated files are written only to the candidate's quarantine directory. The
skill-author cannot write directly to active global or project skill paths.

Drafting may be cancelled. A cancelled child session leaves the last complete
immutable draft available for inspection but never marks it approved.

## Skill Format Adapters

Workbench must define an adapter interface around current OpenCode behavior:

```ts
interface SkillFormatAdapter {
  id: string
  supports(openCodeVersion: string): boolean
  discoverTargets(scope: Scope): Promise<SkillTarget[]>
  inspect(target: SkillTarget): Promise<InstalledSkillPackage | undefined>
  validate(files: DraftFile[]): Promise<ValidationReport>
  install(files: DraftFile[], target: SkillTarget): Promise<InstalledPackage>
  remove(target: SkillTarget): Promise<InstalledPackage | undefined>
  verify(client: OpenCodeClient, target: SkillTarget, digest: string): Promise<void>
}
```

Adapters must preserve supported unknown frontmatter and package files during an
update. Unsupported OpenCode versions disable activation while retaining draft
review and export.

## Validation

Validation runs before review and again immediately before activation. It must
check:

- OpenCode-version-specific package structure and metadata.
- Required files and fields.
- UTF-8 decoding, path normalization, and case collisions.
- File count, individual file size, and aggregate package size.
- Symlinks, path traversal, devices, sockets, and other unsupported entries.
- Duplicate skill identifiers and overlapping destinations.
- Referenced scripts or assets that are missing from the package.
- Permission and tool declarations that differ from the installed version.
- Stale base digest for edits, moves, merges, splits, and retirement.

Static validation never claims that generated instructions are correct. The
review UI must distinguish structural validation from optional behavioral smoke
tests. Smoke tests use an isolated OpenCode session and require separate consent
when they can invoke paid models or tools.

## Review UX

The review surface shows the entire package, including deleted and binary files.
It includes:

- Candidate rationale and evidence.
- New, changed, and removed files.
- Unified text diffs.
- Metadata and permission changes.
- Structural validation results.
- Optional smoke-test results and cost.
- Base and draft digests.
- Exact project or global scope.

Available actions are:

- **Approve & activate**.
- **Edit draft**.
- **Request revision**.
- **Reject**.
- **Export draft**.

Global activation uses a modal confirmation because it affects future sessions
outside the current project. Project activation uses an inline confirmation
unless permissions or executable package content materially expand.

## Activation Boundary

Activation is a Workbench host operation, not an OpenCode tool. It may start
only when the root session is idle. If the session is busy, the user chooses:

```text
Activate after response
Stop response and activate
Later
```

The default is **Activate after response**. Local prompt admission pauses while
activation is pending. Existing queued prompts retain their order and private
attachment payloads in the extension host.

## Activation Transaction

Workbench performs these steps under a scope-specific activation lock:

1. Re-read candidate state and require status `approved`.
2. Re-run structural validation.
3. Compare the current target digest with the draft's base digest.
4. Snapshot the selected session ID and local composer state.
5. Copy the current active package into an activation backup.
6. Install or remove the package atomically.
7. Reload the OpenCode workspace instance.
8. Reconnect the event stream and reconcile sessions and catalogs.
9. Re-select the previous session ID.
10. Verify that OpenCode discovers the expected package version or removal.
11. Resume local prompt admission.
12. Mark the candidate `active`, `superseded`, or `retired` as appropriate.

The activation result is recorded before the UI reports success. Success means
OpenCode verified the activated package, not merely that filesystem writes
completed.

## OpenCode Reload Strategy

For ordinary skill changes, Workbench should first use workspace-instance
reload:

```text
POST /instance/dispose
controller.reconnect()
controller.reconcile()
controller.select(previousSessionID)
```

Managed Workbench exposes `vscode_request_opencode_reload` to OpenCode. This is
a deferred request rather than a synchronous restart operation. After an
approved change is installed, the tool returns a `scheduled` receipt. Workbench
pauses new prompt admission and waits for a terminal status event from the
requesting session before starting reload. The permission
`vscode.reload_opencode` always requires explicit approval and is excluded from
session Auto mode.

A full managed-server restart is reserved for changes that instance disposal
cannot load, including companion plugin code or process environment changes.
External mode may dispose a workspace instance when supported but cannot assume
authority to restart the external process.

The UI uses the single phrase **Reloading OpenCode**. Internal reload strategy is
shown only in diagnostics.

Terminal OpenCode instances must not kill, replace, dispose, or relaunch
themselves from inside a model tool call. Without a documented and tested native
reload host, terminal activation ends in `pending-reload` and instructs the user
to quit and restart OpenCode. A later instance verifies the installed package
before changing state to `active`.

If no companion-plugin tools are available, the global `skill-development`
skill falls back to reviewed manual work through `skill-maintenance`. Candidate
and evidence state remains conversational, and the agent must not claim that it
was persisted.

Before activation ships, integration tests must prove that the supported
OpenCode version range:

- Discovers created and updated skill packages after instance disposal.
- Stops discovering retired skills.
- Retains the existing session and transcript.
- Makes the new skill available on the next turn in that session.
- Preserves provider authentication and workspace bridge affinity.

If any supported version fails these checks, its adapter must use a tested full
managed-server restart or disable automatic activation.

## Session Continuity

Reload restores:

- The selected session ID and transcript.
- Agent, model, and variant preferences.
- Composer draft and context attachments.
- Local queued prompts.
- Root-session auto-approval mode.
- Pending navigation and editor context where still valid.

Reload does not resume a partially executing generation. It does not replay the
last prompt. After successful activation, Workbench shows:

```text
Skill activated successfully.

Continue conversation
Retry failed step
View skill
```

**Continue conversation** focuses the restored composer. **Retry failed step**
constructs a visible draft from the original request and requires another send
action. It never submits automatically.

## Rollback

Any failure after the active package changes begins rollback:

1. Restore the backup or remove the newly created package.
2. Reload OpenCode again.
3. Verify the previous catalog state.
4. Restore the selected session and local composer state.
5. Mark activation `failed` with a bounded diagnostic.

If rollback verification also fails, prompt admission remains paused and the UI
shows a recovery action with backup location and manual instructions. Workbench
must not repeatedly restart OpenCode. One activation permits one activation
reload and one rollback reload.

## Global Skills and Multiple Windows

Global package activation uses a global lock and expected digest. The current
window reloads and verifies immediately. Other managed windows receive a
`reload required` marker through the shared state file or registry and reload
only after their active turn reaches idle. Workbench never forcibly interrupts
another window.

Concurrent edits use optimistic concurrency. If another process changes the
target after draft generation, activation fails with `Skill changed since this
draft was generated` and returns the candidate to review.

## Protocol Additions

The shared host/webview protocol should add bounded messages for:

- Candidate summaries and state changes.
- Evidence summaries and on-demand detail.
- Draft manifests and validation reports.
- File-by-file diff retrieval.
- Draft generation, cancellation, revision, and export.
- Approval, rejection, and deferred activation.
- Activation progress, success, rollback, and recovery.
- Global reload-required notifications.

Large draft files and diffs must remain extension-host data. Webview snapshots
contain summaries and request bounded detail on demand.

## Permissions

New permission families should distinguish intent:

```text
skill_candidate.read
skill_candidate.propose
skill_candidate.reject
skill_draft.generate
skill_draft.read
skill_draft.export
skill.activate.project
skill.activate.global
skill.retire.project
skill.retire.global
skill.install.pending-reload
skill.verify
```

Model tools may request candidate and draft permissions. Activation and
retirement permissions are host-only user actions and are never auto-approved
through session Auto mode.

## Observability

Workbench records bounded local lifecycle diagnostics:

- Candidate and draft IDs.
- State transitions and timestamps.
- OpenCode and adapter versions.
- Package and base digests.
- Reload strategy and duration.
- Catalog verification result.
- Rollback result.

Logs never contain managed credentials, raw preference values, unrestricted
transcripts, attachment payloads, or complete generated skill contents.

## Delivery Phases

### Phase 1: State and Inspection

- Migrate plugin state.
- Normalize legacy and v2 evidence.
- Add candidate kinds, versions, and target digests.
- Add candidate and evidence UI without drafting or activation.

### Phase 2: Quarantined Drafts

- Add version-specific format adapters.
- Add skill-author child sessions.
- Store immutable draft packages and manifests.
- Add validation, diff review, revisions, and export.

### Phase 3: Project Activation

- Add the activation lock and transaction.
- Implement project package install, reload, verification, and rollback.
- Restore the same session and local composer state.
- Keep global activation disabled.

### Phase 4: Global Activation

- Add global locks and cross-window reload-required state.
- Add explicit global confirmation and rollback.
- Verify behavior across managed and external server modes.

### Phase 5: Improvement Loop

- Aggregate repeated evidence fingerprints.
- Add optional proposal thresholds and suppression preferences.
- Record active skill usage and failures.
- Propose revisions, merges, splits, and retirement.

## Acceptance Criteria

The feature is complete when all of these behaviors are verified:

- An agent proposal cannot modify an active skill or restart OpenCode.
- A draft remains isolated until the user approves its exact digest.
- Updates fail safely when their base skill changed concurrently.
- Activation waits for an idle turn and pauses local prompt admission.
- Project activation reloads OpenCode and restores the same selected session.
- Terminal installation without a reload host reports `pending-reload`, does
  not attempt self-restart, and becomes active only after later verification.
- The activated skill is available on the next turn without replaying a prompt.
- Failed verification restores and verifies the previous package.
- Global activation does not interrupt another active VS Code window.
- Preference memory takes effect on the next message without a reload.
- Legacy and v2 OpenCode events produce equivalent bounded evidence.
- Unsupported OpenCode skill formats can be reviewed and exported but not
  activated automatically.
- The global `skill-development` and `skill-maintenance` descriptions do not
  compete for explicit maintenance and evidence-backed improvement requests.
