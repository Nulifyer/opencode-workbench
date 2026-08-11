import type { ChatSnapshot, RunComparisonRow } from "@opencode-workbench/shared"

export type InspectorTab = "activity" | "plan" | "changes" | "review" | "evidence" | "goal" | "jobs" | "lineage" | "runs" | "context" | "walkthrough" | "health"

export interface InspectorPresentation {
  signature: string
  markup: string
}

export type RunComparisonSortKey = "model" | "status" | "elapsed" | "changedFiles" | "taskOutcomes" | "diagnostics" | "verifier" | "tokens" | "cost" | "blocker"
export interface RunComparisonSort { key: RunComparisonSortKey; direction: "ascending" | "descending" }
export interface InspectorPresentationOptions { comparisonSorts?: Readonly<Record<string, RunComparisonSort>> }

const RUN_COMPARISON_COLUMNS: ReadonlyArray<{ key: RunComparisonSortKey; label: string }> = [
  { key: "model", label: "Model" },
  { key: "status", label: "Phase" },
  { key: "elapsed", label: "Elapsed" },
  { key: "changedFiles", label: "Files / diff" },
  { key: "taskOutcomes", label: "Tasks" },
  { key: "diagnostics", label: "Diagnostics" },
  { key: "verifier", label: "Verifier" },
  { key: "tokens", label: "Tokens" },
  { key: "cost", label: "Cost" },
  { key: "blocker", label: "Blocker" },
]

function missingRunComparisonValue(row: RunComparisonRow, key: RunComparisonSortKey): boolean {
  return key === "elapsed" ? row.elapsedMilliseconds === undefined
    : key === "tokens" ? row.tokens === undefined
    : key === "cost" ? row.cost === undefined
    : false
}

function compareRunComparisonRows(left: RunComparisonRow, right: RunComparisonRow, key: RunComparisonSortKey): number {
  if (key === "elapsed") return left.elapsedMilliseconds! - right.elapsedMilliseconds!
  if (key === "tokens") return left.tokens! - right.tokens!
  if (key === "cost") return left.cost! - right.cost!
  if (key === "changedFiles") return left.changedFiles - right.changedFiles || (left.additions + left.deletions) - (right.additions + right.deletions) || left.additions - right.additions
  const text = (row: RunComparisonRow): string => key === "model" ? [row.model, row.agent, row.variant].filter(Boolean).join(" / ")
    : key === "status" ? row.status
    : key === "taskOutcomes" ? row.taskOutcomes
    : key === "diagnostics" ? row.diagnostics
    : key === "verifier" ? row.verifierState ?? ""
    : row.blocker ?? row.limitation ?? ""
  return text(left).localeCompare(text(right), undefined, { numeric: true, sensitivity: "base" })
}

/** Stable, presentation-only ordering of already-recorded objective rows. */
export function sortRunComparisonRows(rows: readonly RunComparisonRow[], sort: RunComparisonSort): RunComparisonRow[] {
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const leftMissing = missingRunComparisonValue(left.row, sort.key)
    const rightMissing = missingRunComparisonValue(right.row, sort.key)
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1
    if (leftMissing) return left.index - right.index
    const compared = compareRunComparisonRows(left.row, right.row, sort.key)
    if (!compared) return left.index - right.index
    return sort.direction === "ascending" ? compared : -compared
  }).map((entry) => entry.row)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character)
}

function projectionNotice(snapshot: ChatSnapshot, keys: Array<keyof NonNullable<ChatSnapshot["projection"]>["omitted"]>): string {
  const omitted = keys.reduce((total, key) => total + (snapshot.projection?.omitted[key] ?? 0), 0)
  return omitted
    ? `<p class="placeholder projection-warning" role="status">${omitted.toLocaleString()} older item${omitted === 1 ? " is" : "s are"} hidden from this bounded view. The stored records were not deleted.</p>`
    : ""
}

function presentationData(snapshot: ChatSnapshot, tab: InspectorTab): unknown {
  const session = snapshot.session
  if (!session) return undefined
  if (tab === "activity") return [session.status, session.queue?.length, session.permissions?.length, session.questions?.length, session.todos]
  if (tab === "changes") return [session.changes, snapshot.artifacts, snapshot.reviewFindings, snapshot.evidence, snapshot.walkthroughs]
  if (tab === "context") return [session.context, session.contextReceipts, snapshot.artifacts?.filter((artifact) => artifact.kind === "context-capture")]
  if (tab === "goal") return [session.goal, snapshot.artifacts?.filter((artifact) => artifact.kind === "goal-verification")]
  if (tab === "runs") return [snapshot.runGroups, snapshot.worktrees, snapshot.runComparisons]
  if (tab === "walkthrough") return snapshot.walkthroughs
  if (tab === "jobs") return [session.delegations, snapshot.lineage, snapshot.runGroups, snapshot.worktrees, snapshot.ptys, snapshot.runComparisons]
  if (tab === "lineage") return snapshot.lineage?.map((entry) => [entry.sessionID, entry.parentID, entry.rootID, entry.status.type, entry.title])
  if (tab === "health") return [snapshot.health, snapshot.trace]
  if (tab === "plan") return snapshot.artifacts
  if (tab === "review") return [snapshot.artifacts, snapshot.reviewFindings]
  if (tab === "evidence") return snapshot.evidence
  return tab
}

function artifactMarkup(snapshot: ChatSnapshot, tab: "plan" | "review"): string {
  const allArtifacts = (snapshot.artifacts ?? []).filter((artifact) => artifact.kind === tab)
  const artifacts = allArtifacts.filter((artifact) => artifact.lifecycle === "active")
  const archived = allArtifacts.length - artifacts.length
  const bounded = projectionNotice(snapshot, tab === "review" ? ["taskArtifacts", "reviewFindings"] : ["taskArtifacts"])
  const archivedNotice = archived ? `<p class="placeholder">${archived} archived ${tab} artifact${archived === 1 ? " is" : "s are"} hidden from the active workflow.</p>` : ""
  if (!artifacts.length) {
    const action = tab === "plan"
      ? `<button type="button" data-workbench-action="plan">Plan a task</button>`
      : `<button type="button" data-workbench-action="review">Review current changes</button>`
    const explanation = tab === "plan"
      ? "Plans are created by the Plan Task flow, saved as explicit documents, then approved and handed off for implementation. Chatting normally does not create a plan artifact."
      : "Reviews are generated on demand from an exact Git diff. They are model assessments anchored to changed lines, not an automatic part of every chat."
    return `<h2>${tab === "plan" ? "Plans" : "Reviews"}</h2>${bounded}${archivedNotice}<p class="placeholder">${explanation}</p><div class="inspector-actions">${action}</div>`
  }
  const activeArtifactIDs = new Set(artifacts.map((artifact) => artifact.id))
  const activeFindings = tab === "review" ? (snapshot.reviewFindings ?? []).filter((finding) => activeArtifactIDs.has(finding.artifactID)) : []
  const reviewFilters = activeFindings.length ? `<div class="inspector-filters review-filters" role="group" aria-label="Review finding filters"><label>Severity <select data-inspector-key="review-filter:severity" data-review-filter="severity"><option value="">All severities</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label><label>Category <select data-inspector-key="review-filter:category" data-review-filter="category"><option value="">All categories</option>${[...new Set(activeFindings.map((finding) => finding.category))].sort().map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}</select></label><label>Disposition <select data-inspector-key="review-filter:disposition" data-review-filter="disposition"><option value="">All dispositions</option><option value="open">Open</option><option value="fixed">Fixed</option><option value="dismissed">Dismissed</option><option value="accepted-risk">Accepted risk</option></select></label></div><p class="placeholder filter-status" role="status" aria-live="polite" data-review-filter-status>Showing ${activeFindings.length} of ${activeFindings.length} finding${activeFindings.length === 1 ? "" : "s"}.</p>` : ""
  return `<h2>${tab === "plan" ? "Plans" : "Reviews"}</h2>${bounded}${archivedNotice}${reviewFilters}<ul class="inspector-list artifact-list">${artifacts.map((artifact) => {
    const id = escapeHtml(artifact.id)
    const action = (name: string, label: string) => `<button type="button" data-artifact-id="${id}" data-artifact-revision="${artifact.revision}" data-artifact-action="${name}">${label}</button>`
    const controls = tab === "plan"
      ? `${action("open", "Open")}${artifact.state === "ready" ? action("approve", "Approve") : ""}${["approved", "handed-off"].includes(artifact.state) ? action("handoff", "Handoff") : ""}${action("archive", "Archive")}`
      : `${action("open", "Open findings")}${action("regenerate", "Regenerate")}${action("archive", "Archive")}`
    const findings = tab === "review" ? (snapshot.reviewFindings ?? []).filter((finding) => finding.artifactID === artifact.id) : []
    const findingMarkup = findings.length ? `<ol class="review-findings">${findings.map((finding) => {
      const findingAction = (name: "open-finding" | "set-finding-disposition", label: string, disposition?: string) => `<button type="button" data-artifact-id="${id}" data-artifact-revision="${finding.artifactRevision}" data-artifact-action="${name}" data-finding-id="${escapeHtml(finding.findingID)}"${disposition ? ` data-finding-disposition="${disposition}"` : ""}>${label}</button>`
      const anchors = finding.anchors.map((anchor) => `${anchor.file}:${anchor.startLine}-${anchor.endLine}`).join(", ")
      return `<li data-review-finding="${escapeHtml(finding.findingID)}" data-review-severity="${escapeHtml(finding.severity)}" data-review-category="${escapeHtml(finding.category)}" data-review-disposition="${escapeHtml(finding.disposition)}"><strong><span class="review-severity ${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span> ${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.detail)}</p><small>${escapeHtml(finding.category)} · ${escapeHtml(finding.disposition)}${finding.stale ? " · stale diff" : ""} · ${escapeHtml(anchors)}</small><div class="inspector-actions">${findingAction("open-finding", "Open location")}${findingAction("set-finding-disposition", "Mark open", "open")}${findingAction("set-finding-disposition", "Fixed", "fixed")}${findingAction("set-finding-disposition", "Dismiss", "dismissed")}${findingAction("set-finding-disposition", "Accept risk", "accepted-risk")}</div></li>`
    }).join("")}</ol>` : tab === "review" && artifact.itemCount ? `<p class="placeholder">Finding details are outside this bounded projection. Refresh or open the review document.</p>` : ""
    return `<li data-artifact-row="${id}"><strong>${tab === "plan" ? "Implementation plan" : "OpenCode review"}</strong><small>${escapeHtml(artifact.state)}${artifact.itemCount === undefined ? "" : ` · ${artifact.itemCount} item${artifact.itemCount === 1 ? "" : "s"}`}${artifact.stale ? " · stale" : ""} · ${escapeHtml(new Date(artifact.updatedAt).toLocaleString())}</small><div class="inspector-actions">${controls}</div>${findingMarkup}</li>`
  }).join("")}</ul>`
}

function evidenceMarkup(snapshot: ChatSnapshot, formatDate: (value: number) => string): string {
  const priority: Record<string, number> = { failed: 0, warning: 1, unknown: 2, passed: 3 }
  const evidence = (snapshot.evidence ?? []).slice().sort((left, right) => (priority[left.status] ?? 4) - (priority[right.status] ?? 4) || right.observedAt - left.observedAt)
  const bounded = projectionNotice(snapshot, ["evidence"])
  if (!evidence.length) return `<h2>Evidence</h2>${bounded}<p class="placeholder">No deterministic evidence is recorded for this OpenCode session.</p><div class="inspector-actions"><button type="button" data-evidence-action="capture">Capture task evidence</button></div>`
  return `<h2>Evidence</h2>${bounded}<div class="inspector-actions"><button type="button" data-evidence-action="capture">Capture task evidence</button></div><ul class="inspector-list evidence-list">${evidence.map((entry) => `<li data-evidence-id="${escapeHtml(entry.id)}"><strong><span class="evidence-status ${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span> ${escapeHtml(entry.label)}</strong><p>${escapeHtml(entry.summary)}</p><small>${escapeHtml(entry.kind)} · ${escapeHtml(formatDate(entry.observedAt))}</small></li>`).join("")}</ul>`
}

function runComparisonMarkup(snapshot: ChatSnapshot, groupID: string, comparisonSorts: Readonly<Record<string, RunComparisonSort>> = {}): string {
  const comparison = (snapshot.runComparisons ?? []).find((candidate) => candidate.groupID === groupID)
  if (!comparison) return ""
  const artifactID = escapeHtml(comparison.artifactID)
  const sort = comparisonSorts[comparison.artifactID] ?? { key: "model", direction: "ascending" }
  const cells = sortRunComparisonRows(comparison.rows, sort).map((row) => {
    const elapsed = row.elapsedMilliseconds === undefined ? "Unknown" : `${Math.round(row.elapsedMilliseconds / 1000)}s`
    const tokens = row.tokens === undefined ? "Unknown" : row.tokens.toLocaleString()
    const cost = row.cost === undefined ? "Unknown" : `$${row.cost.toFixed(4)}`
    const action = (name: string, label: string) => `<button type="button" data-run-group="${escapeHtml(groupID)}" data-run-id="${escapeHtml(row.runID)}" data-run-action="${name}">${label}</button>`
    const run = (snapshot.runGroups ?? []).find((group) => group.id === groupID)?.runs.find((candidate) => candidate.id === row.runID)
    const available = run && run.session.sessionID !== "pending" && !run.discarded
    const choices = available ? `${action("open", "Open")}${action("diff", "Diff")}${action("review", "Review")}${run.retained ? "" : `${action("keep", "Keep")}${action("discard", "Discard")}`}` : `<span class="placeholder">Unavailable</span>`
    return `<tr data-run-id="${escapeHtml(row.runID)}"><th scope="row">${escapeHtml(row.model)}</th><td data-label="Phase">${escapeHtml(row.status)}</td><td data-label="Elapsed">${escapeHtml(elapsed)}</td><td data-label="Files / diff">${row.changedFiles} / +${row.additions} −${row.deletions}</td><td data-label="Tasks">${escapeHtml(row.taskOutcomes)}</td><td data-label="Diagnostics">${escapeHtml(row.diagnostics)}</td><td data-label="Verifier">${escapeHtml(row.verifierState ?? "Not recorded")}</td><td data-label="Tokens">${escapeHtml(tokens)}</td><td data-label="Cost">${escapeHtml(cost)}</td><td data-label="Blocker">${escapeHtml(row.blocker ?? row.limitation ?? "None")}</td><td data-label="Actions"><div class="inspector-actions">${choices}</div></td></tr>`
  }).join("")
  const options = RUN_COMPARISON_COLUMNS.map((column) => `<option value="${column.key}"${sort.key === column.key ? " selected" : ""}>${escapeHtml(column.label)}</option>`).join("")
  const headers = RUN_COMPARISON_COLUMNS.map((column) => {
    const active = sort.key === column.key
    const ariaSort = active ? sort.direction : "none"
    const indicator = !active ? "↕" : sort.direction === "ascending" ? "▲" : "▼"
    return `<th scope="col" aria-sort="${ariaSort}"><button type="button" data-inspector-key="comparison:${artifactID}:sort:${column.key}" data-comparison-artifact-id="${artifactID}" data-comparison-sort="${column.key}" aria-label="Sort by ${escapeHtml(column.label)}${active ? `, currently ${sort.direction}` : ""}">${escapeHtml(column.label)} <span aria-hidden="true">${indicator}</span></button></th>`
  }).join("")
  const directionLabel = sort.direction === "ascending" ? "Ascending" : "Descending"
  return `<div class="run-comparison${comparison.stale ? " stale" : ""}" data-artifact-id="${artifactID}"><div class="run-comparison-toolbar" role="group" aria-label="Run comparison controls"><label>Sort rows <select data-inspector-key="comparison:${artifactID}:sort-select" data-comparison-artifact-id="${artifactID}" data-comparison-sort-select>${options}</select></label><button type="button" data-inspector-key="comparison:${artifactID}:sort-direction" data-comparison-artifact-id="${artifactID}" data-comparison-sort-direction aria-label="Change sort direction; currently ${sort.direction}">${directionLabel}</button><button type="button" data-inspector-key="comparison:${artifactID}:export" data-run-group="${escapeHtml(groupID)}" data-run-action="export-comparison" data-comparison-artifact-id="${artifactID}" data-comparison-revision="${comparison.revision}">Export Markdown</button></div><table><caption>Objective run comparison refreshed ${escapeHtml(new Date(comparison.updatedAt).toLocaleString())}. No winner or score is inferred.${comparison.stale ? " Source state changed or remains active; refresh Compare before making a decision." : ""} Sorted by ${escapeHtml(RUN_COMPARISON_COLUMNS.find((column) => column.key === sort.key)?.label ?? "Model")} ${sort.direction}.</caption><thead><tr>${headers}<th scope="col">Actions</th></tr></thead><tbody>${cells}</tbody></table></div>`
}

function jobsMarkup(snapshot: ChatSnapshot): string {
  const delegations = snapshot.session?.delegations ?? []
  const runs = (snapshot.runGroups ?? []).flatMap((group) => group.runs.map((run) => ({ group, run })))
  const ptys = snapshot.ptys ?? []
  const selectedID = snapshot.session?.id
  const lineage = snapshot.lineage ?? []
  const sessionByID = new Map(lineage.map((session) => [session.sessionID, session]))
  const descendants = selectedID ? lineage.filter((candidate) => {
    if (candidate.sessionID === selectedID) return false
    const visited = new Set<string>()
    let current = candidate.parentID
    while (current && !visited.has(current)) {
      if (current === selectedID) return true
      visited.add(current)
      current = sessionByID.get(current)?.parentID
    }
    return false
  }) : []
  if (!delegations.length && !runs.length && !ptys.length && !descendants.length && !(snapshot.worktrees?.length ?? 0)) return `<h2>Jobs</h2><p class="placeholder">No delegated OpenCode sessions, isolated runs, worktrees, or native OpenCode terminals are visible.</p>`
  type Group = "Needs input" | "Running" | "Failed" | "Completed"
  type JobKind = "delegation" | "run" | "session" | "worktree" | "terminal"
  const groups = new Map<Group, string[]>([["Needs input", []], ["Running", []], ["Failed", []], ["Completed", []]])
  const jobRow = (kind: JobKind, content: string, sessionID?: string, runID?: string, exactID?: { kind: "worktree" | "pty"; id: string }): string => `<li data-job-row data-job-kind="${kind}"${sessionID ? ` data-job-session-id="${escapeHtml(sessionID)}"` : ""}${runID ? ` data-job-run-id="${escapeHtml(runID)}"` : ""}${exactID ? ` data-${exactID.kind}-id="${escapeHtml(exactID.id)}"` : ""}>${content}</li>`
  const runSessions = new Set(runs.flatMap(({ run }) => run.session.sessionID === "pending" ? [] : [run.session.sessionID]))
  const delegatedSessions = new Set(delegations.map((delegation) => delegation.sessionID))
  const presentedSessions = new Set([...runSessions, ...delegatedSessions])
  const referencedWorktrees = new Set(runs.flatMap(({ run }) => run.worktreeID ? [run.worktreeID] : []))
  for (const delegation of delegations) {
    if (runSessions.has(delegation.sessionID)) continue
    const needsInput = (snapshot.session?.questions ?? []).some((entry) => entry.sessionID === delegation.sessionID) || (snapshot.session?.permissions ?? []).some((entry) => entry.sessionID === delegation.sessionID)
    const group: Group = needsInput ? "Needs input" : delegation.status.type === "error" ? "Failed" : ["busy", "retry"].includes(delegation.status.type) ? "Running" : "Completed"
    const tool = delegation.messages.slice().reverse().flatMap((message) => message.parts).find((part) => part.type === "tool")
    const childID = escapeHtml(delegation.sessionID)
    const routeID = escapeHtml(needsInput && selectedID ? selectedID : delegation.sessionID)
    groups.get(group)!.push(jobRow("delegation", `<button type="button" data-inspector-key="job:${childID}" data-job-session="${routeID}"><strong>${escapeHtml(delegation.title)}</strong></button><small>delegation · ${escapeHtml(delegation.status.type)}${tool?.tool ? ` · ${escapeHtml(tool.tool)}` : ""} · ${delegation.messages.length} messages</small>`, delegation.sessionID))
  }
  for (const { group: runGroup, run } of runs) {
    const group: Group = run.phase === "needs-input" ? "Needs input" : ["pending", "preparing", "admitting", "working"].includes(run.phase) ? "Running" : run.phase === "failed" ? "Failed" : "Completed"
    const key = `job:${escapeHtml(runGroup.id)}:${escapeHtml(run.id)}`
    const available = run.session.sessionID !== "pending" && !run.discarded
    const needsInputRoute = sessionByID.get(run.session.sessionID)?.rootID ?? run.session.sessionID
    const control = !available ? `<strong>${escapeHtml(run.model)}</strong>`
      : run.phase === "needs-input" && needsInputRoute ? `<button type="button" data-inspector-key="${key}" data-job-session="${escapeHtml(needsInputRoute)}"><strong>${escapeHtml(run.model)}</strong></button>`
      : `<button type="button" data-inspector-key="${key}" data-run-group="${escapeHtml(runGroup.id)}" data-run-id="${escapeHtml(run.id)}" data-run-action="open"><strong>${escapeHtml(run.model)}</strong></button>`
    groups.get(group)!.push(jobRow("run", `${control}<small>run · ${escapeHtml(run.phase)} · ${escapeHtml(runGroup.title)}${run.agent ? ` · ${escapeHtml(run.agent)}` : ""}</small>${run.error ? `<p>${escapeHtml(run.error.message)}</p>` : ""}`, available ? run.session.sessionID : undefined, run.id))
  }
  for (const child of descendants) {
    if (runSessions.has(child.sessionID) || delegatedSessions.has(child.sessionID)) continue
    const needsInput = Boolean(child.questionCount || child.permissionCount || child.attention)
    const group: Group = needsInput ? "Needs input" : child.status.type === "error" ? "Failed" : ["busy", "retry"].includes(child.status.type) ? "Running" : "Completed"
    presentedSessions.add(child.sessionID)
    groups.get(group)!.push(jobRow("session", `<button type="button" data-job-session="${escapeHtml(needsInput ? child.rootID : child.sessionID)}"><strong>${escapeHtml(child.title)}</strong></button><small>OpenCode child session · ${escapeHtml(child.status.type)}${child.model ? ` · ${escapeHtml(child.model)}` : ""}${child.agent ? ` · ${escapeHtml(child.agent)}` : ""}${child.branch ? ` · ${escapeHtml(child.branch)}` : ""}${child.tokens === undefined ? "" : ` · ${child.tokens.toLocaleString()} tokens`}${child.cost === undefined ? "" : ` · $${child.cost.toFixed(4)}`}</small>`, child.sessionID))
  }
  for (const worktree of snapshot.worktrees ?? []) {
    if (referencedWorktrees.has(worktree.id) || (worktree.sessionID && presentedSessions.has(worktree.sessionID))) continue
    const jobGroup: Group = ["cleanup-pending", "retained-dirty"].includes(worktree.phase) ? "Needs input" : ["requested", "creating", "setup-running", "session-creating", "prompt-admitting"].includes(worktree.phase) ? "Running" : worktree.phase === "failed" ? "Failed" : "Completed"
    groups.get(jobGroup)!.push(jobRow("worktree", `<strong>${escapeHtml(worktree.branch)}</strong><small>isolated worktree · ${escapeHtml(worktree.phase)} · ${escapeHtml(worktree.path)}</small>${worktree.error ? `<p>${escapeHtml(worktree.error.message)}</p>` : ""}`, worktree.sessionID, undefined, { kind: "worktree", id: worktree.id }))
  }
  for (const pty of ptys) {
    const group: Group = pty.status === "running" ? "Running" : (pty.exitCode ?? 0) === 0 ? "Completed" : "Failed"
    groups.get(group)!.push(jobRow("terminal", `<strong>${escapeHtml(pty.title || pty.command)}</strong><small>OpenCode terminal · ${escapeHtml(pty.status)} · ${escapeHtml(pty.command)}${pty.args.length ? ` · ${escapeHtml(pty.args.join(" "))}` : ""} · ${escapeHtml(pty.cwd)}</small>${pty.status === "running" ? `<div class="inspector-actions"><button type="button" data-pty-id="${escapeHtml(pty.id)}" data-pty-action="cancel">Cancel</button></div>` : ""}`, undefined, undefined, { kind: "pty", id: pty.id }))
  }
  const canBackground = (delegations.some((delegation) => ["busy", "retry"].includes(delegation.status.type)) ||
    descendants.some((child) => ["busy", "retry"].includes(child.status.type))) && snapshot.session
  const filters = `<div class="inspector-filters job-filters" role="search" aria-label="Job filters"><label class="filter-wide">Search <input type="search" data-inspector-key="job-filter:text" data-job-filter="text" autocomplete="off" placeholder="Title, model, phase, or command"></label><label>Kind <select data-inspector-key="job-filter:kind" data-job-filter="kind"><option value="">All kinds</option><option value="delegation">Delegations</option><option value="run">Runs</option><option value="session">Child sessions</option><option value="worktree">Worktrees</option><option value="terminal">Terminals</option></select></label><label>Session <input type="search" data-inspector-key="job-filter:session" data-job-filter="session" autocomplete="off" spellcheck="false" placeholder="Exact or partial ID"></label><label>Run <input type="search" data-inspector-key="job-filter:run" data-job-filter="run" autocomplete="off" spellcheck="false" placeholder="Exact or partial ID"></label></div><p class="placeholder filter-status" role="status" aria-live="polite" data-job-filter-status>Showing ${[...groups.values()].reduce((total, rows) => total + rows.length, 0)} jobs.</p>`
  return `<h2>Jobs</h2>${projectionNotice(snapshot, ["lineage", "worktrees", "ptys"])}${filters}${canBackground ? `<div class="inspector-actions"><button type="button" data-job-session="${escapeHtml(snapshot.session!.id)}" data-job-action="background">Background OpenCode child sessions</button></div>` : ""}${["Needs input", "Running", "Failed", "Completed"].map((group) => {
    const rows = groups.get(group as Group)!
    return rows.length ? `<section class="job-section" data-job-group data-job-state="${group.toLowerCase().replace(" ", "-")}"><h3>${group} <span class="count-badge" data-job-group-count>${rows.length}</span></h3><ul class="inspector-list">${rows.join("")}</ul></section>` : ""
  }).join("")}`
}

function lineageMarkup(snapshot: ChatSnapshot): string {
  const lineage = snapshot.lineage ?? []
  const byID = new Map(lineage.map((session) => [session.sessionID, session]))
  const children = new Map<string, string[]>()
  for (const session of lineage) {
    if (!session.parentID || session.parentID === session.sessionID || !byID.has(session.parentID)) continue
    const values = children.get(session.parentID) ?? []
    values.push(session.sessionID)
    children.set(session.parentID, values)
  }
  for (const values of children.values()) values.sort((left, right) => (byID.get(right)?.updatedAt ?? 0) - (byID.get(left)?.updatedAt ?? 0) || left.localeCompare(right))
  const visited = new Set<string>()
  const rows: string[] = []
  const walk = (id: string, depth: number, path: ReadonlySet<string>, recoveredCycle = false): void => {
    if (visited.has(id) || depth > 100) return
    const session = byID.get(id)
    if (!session) return
    visited.add(id)
    const nextPath = new Set(path).add(id)
    const cyclicChildren = (children.get(id) ?? []).filter((child) => nextPath.has(child))
    const detail = [session.status.type, session.relation, session.model, session.agent, session.branch, session.tokens === undefined ? "" : `${session.tokens.toLocaleString()} tokens`, session.cost === undefined ? "" : `$${session.cost.toFixed(4)}`, session.shared ? "public" : "", session.archived ? "archived" : "", recoveredCycle || cyclicChildren.length ? "cycle recovered" : ""].filter(Boolean).join(" · ")
    rows.push(`<li role="treeitem" aria-level="${depth + 1}" aria-current="${session.sessionID === snapshot.session?.id ? "true" : "false"}" style="--lineage-depth:${Math.min(depth, 20)}"><button type="button" data-job-session="${escapeHtml(session.sessionID)}"><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(detail)}</small></button></li>`)
    for (const child of children.get(id) ?? []) if (!nextPath.has(child)) walk(child, depth + 1, nextPath)
  }
  const roots = lineage.filter((session) => !session.parentID || session.parentID === session.sessionID || !byID.has(session.parentID)).sort((left, right) => right.updatedAt - left.updatedAt)
  for (const root of roots) walk(root.sessionID, 0, new Set())
  for (const session of lineage) if (!visited.has(session.sessionID)) walk(session.sessionID, 0, new Set(), true)
  return `<h2>Session lineage</h2>${projectionNotice(snapshot, ["lineage"])}<p class="placeholder">Parent and child relationships come directly from OpenCode sessions; run and worktree labels are Workbench joins to those canonical IDs.</p>${rows.length ? `<ul class="lineage-tree" role="tree" aria-label="OpenCode session lineage">${rows.join("")}</ul>` : `<p class="placeholder">No sessions are available.</p>`}`
}

function healthMarkup(snapshot: ChatSnapshot, formatDate: (value: number) => string): string {
  const health = snapshot.health
  if (!health) return `<h2>Health</h2><p class="placeholder">Health data is not available yet.</p>`
  const lastEvent = health.eventStream.lastEventAt === undefined ? "None" : formatDate(health.eventStream.lastEventAt)
  const recent = snapshot.trace?.slice().reverse() ?? []
  const grouped = new Map<string, { type: string; transition?: string; timestamp: number; count: number }>()
  for (const entry of recent) {
    const key = `${entry.type}\0${entry.transition ?? ""}`
    const existing = grouped.get(key)
    if (existing) existing.count += 1
    else grouped.set(key, { type: entry.type, transition: entry.transition, timestamp: entry.timestamp, count: 1 })
  }
  const eventGroups = [...grouped.values()]
  const healthy = health.serverState === "connected" && health.eventStream.state === "connected"
  return `<h2>Health</h2><div class="health-hero ${healthy ? "healthy" : "unhealthy"}"><span class="health-indicator" aria-hidden="true"></span><div><strong>${healthy ? "OpenCode is connected" : "OpenCode needs attention"}</strong><small>${escapeHtml(health.serverState)} server · ${escapeHtml(health.eventStream.state)} event stream</small></div></div><section class="inspector-card health-summary"><h3>Runtime</h3><dl class="inspector-metrics"><dt>OpenCode</dt><dd>${escapeHtml(health.openCodeVersion ?? "Unknown")}</dd><dt>Companion</dt><dd>${escapeHtml(health.pluginState)}</dd><dt>Last event</dt><dd>${escapeHtml(lastEvent)}</dd><dt>Queue</dt><dd>${health.requestQueueDepth}</dd></dl><div class="inspector-actions health-actions" role="group" aria-label="Health actions"><button type="button" data-health-action="refresh">Refresh</button><button type="button" data-health-action="reconnect">Reconnect</button><button type="button" data-health-action="logs">Open logs</button><button type="button" data-health-action="trace">Raw trace</button></div></section><section class="trace-section"><div class="section-heading"><h3>Recent sanitized events</h3><span>${recent.length}</span></div>${eventGroups.length ? `<p class="placeholder trace-summary">${eventGroups.length} event kind${eventGroups.length === 1 ? "" : "s"} across the ${recent.length} most recent sanitized events.</p><ul class="inspector-list health-event-list">${eventGroups.map((entry) => `<li><span class="event-indicator" aria-hidden="true"></span><div><strong>${escapeHtml(entry.type)}${entry.count > 1 ? ` <span class="event-count">×${entry.count}</span>` : ""}</strong><small>Latest ${escapeHtml(formatDate(entry.timestamp))}${entry.transition ? ` · ${escapeHtml(entry.transition)}` : ""}</small></div></li>`).join("")}</ul>` : `<p class="placeholder">No trace events recorded.</p>`}</section>`
}

function activityMarkup(session: NonNullable<ChatSnapshot["session"]>): string {
  const active = session.status.type === "busy" || session.status.type === "retry"
  const completedTodos = session.todos?.filter((todo) => todo.status === "completed").length ?? 0
  return `<h2>Activity</h2><div class="activity-hero ${active ? "active" : "idle"}"><span class="activity-indicator" aria-hidden="true"></span><div><strong>${active ? "OpenCode is working" : "Session is idle"}</strong><small>${active ? "Live progress continues in this session." : "No OpenCode work is currently running."}</small></div></div><section class="inspector-card"><h3>Session summary</h3><dl class="inspector-metrics"><dt>Status</dt><dd>${active ? "Working" : escapeHtml(session.status.type)}</dd><dt>Queued</dt><dd>${session.queue?.length ?? 0}</dd><dt>Permissions</dt><dd>${session.permissions?.length ?? 0}</dd><dt>Questions</dt><dd>${session.questions?.length ?? 0}</dd><dt>Todos</dt><dd>${completedTodos}/${session.todos?.length ?? 0}</dd></dl></section>`
}

function changesMarkup(session: NonNullable<ChatSnapshot["session"]>): string {
  const changes = session.changes ?? []
  return `<h2>Changes</h2>${changes.length
    ? `<ul class="inspector-list change-list">${changes.map((change) => `<li><strong>${escapeHtml(change.file)}</strong><small>+${change.additions} −${change.deletions}${change.status ? ` · ${escapeHtml(change.status)}` : ""}</small><div class="inspector-actions"><button type="button" data-inspector-key="file:${escapeHtml(change.file)}" data-inspector-file="${escapeHtml(change.file)}">Open file</button>${change.patch ? `<button type="button" data-inspector-patch="${escapeHtml(change.file)}">Highlighted diff</button>` : ""}</div></li>`).join("")}</ul>`
    : `<p class="placeholder">OpenCode reports that this session has not changed any files. Changes made outside this session are intentionally not attributed to it.</p><div class="inspector-actions"><button type="button" data-workbench-action="refresh-session">Refresh session data</button></div>`}`
}

function auxiliaryArtifactMarkup(snapshot: ChatSnapshot, kind: "goal-verification" | "context-capture", title: string): string {
  const artifacts = (snapshot.artifacts ?? []).filter((artifact) => artifact.kind === kind && artifact.lifecycle === "active")
  if (!artifacts.length) return `<h2>${title}</h2><p class="placeholder">No active ${title.toLowerCase()} records.</p>`
  return `<h2>${title}</h2><ul class="inspector-list artifact-list">${artifacts.map((artifact) => `<li data-artifact-row="${escapeHtml(artifact.id)}"><strong>${escapeHtml(artifact.state)}</strong><small>${artifact.itemCount === undefined ? "" : `${artifact.itemCount} item${artifact.itemCount === 1 ? "" : "s"} · `}${escapeHtml(new Date(artifact.updatedAt).toLocaleString())}</small><div class="inspector-actions"><button type="button" data-artifact-id="${escapeHtml(artifact.id)}" data-artifact-revision="${artifact.revision}" data-artifact-action="open">Open metadata</button><button type="button" data-artifact-id="${escapeHtml(artifact.id)}" data-artifact-revision="${artifact.revision}" data-artifact-action="archive">Archive</button></div></li>`).join("")}</ul>`
}

function contextMarkup(snapshot: ChatSnapshot, formatDate: (value: number) => string): string {
  const session = snapshot.session!
  const context = session.context
  const receipts = session.contextReceipts ?? []
  const receiptEstimate = receipts.reduce((total, receipt) => total + (receipt.estimatedTokens ?? receipt.items.reduce((subtotal, item) => subtotal + (item.estimatedTokens ?? 0), 0)), 0)
  const reportedCount = (value: number): string => context?.usageReported === false ? "Not reported" : value.toLocaleString()
  const usage = context
    ? `<div class="context-budget"><div class="context-ring" role="meter" aria-label="OpenCode context usage" aria-valuemin="0" aria-valuemax="100"${context.usagePercent === undefined ? "" : ` aria-valuenow="${Math.round(context.usagePercent)}"`} style="--context-used:${context.usagePercent ?? 0}"><span>${context.usagePercent === undefined ? "?" : `${Math.round(context.usagePercent)}%`}</span></div><dl class="inspector-metrics"><dt>Model</dt><dd>${escapeHtml(context.model ?? "Unknown")}</dd><dt>Actual total</dt><dd>${reportedCount(context.totalTokens)}${context.usageReported === false ? "" : " tokens"}</dd><dt>Limit</dt><dd>${context.contextLimit === undefined ? "Unknown" : context.contextLimit.toLocaleString()}</dd><dt>Input</dt><dd>${reportedCount(context.inputTokens)}</dd><dt>Output</dt><dd>${reportedCount(context.outputTokens)}</dd><dt>Reasoning</dt><dd>${reportedCount(context.reasoningTokens)}</dd><dt>Cache read</dt><dd>${reportedCount(context.cacheReadTokens)}</dd><dt>Cache write</dt><dd>${reportedCount(context.cacheWriteTokens)}</dd><dt>Cost</dt><dd>$${context.cost.toFixed(4)}</dd></dl></div><p class="placeholder">${context.usageReported === false ? "OpenCode reported the model limits but did not report token usage for the latest assistant step. " : ""}<strong>Estimated receipt tokens:</strong> ${receiptEstimate.toLocaleString()}. This estimate is separate from OpenCode’s actual usage.</p>`
    : `<p class="placeholder">No token context reported.</p>`
  const receiptList = receipts.length
    ? `<ul class="inspector-list context-receipt-list">${receipts.slice().reverse().map((receipt) => `<li><details><summary>${receipt.items.length} item${receipt.items.length === 1 ? "" : "s"} · ${escapeHtml(formatDate(receipt.admittedAt))}</summary><small>Receipt ${escapeHtml(receipt.id)} · truncation ${escapeHtml(receipt.truncation)}${receipt.estimatedTokens === undefined ? "" : ` · estimated ${receipt.estimatedTokens.toLocaleString()} tokens`}</small><ul>${receipt.items.map((item) => {
      const sourceState = !item.uri ? "Source unavailable after reload" : item.revision ? "Stored revision; staleness checked when opened" : "Staleness unknown"
      const sourceAction = item.uri
        ? `<button type="button" data-context-receipt-id="${escapeHtml(receipt.id)}" data-context-receipt-item-id="${escapeHtml(item.id)}">Open source</button>`
        : ""
      return `<li><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.kind)}${item.uri ? ` · ${escapeHtml(item.uri)}` : ""}${item.range ? ` · ${item.range.startLine}:${item.range.startColumn}-${item.range.endLine}:${item.range.endColumn}` : ""}${item.revision ? ` · ${escapeHtml(item.revision)}` : ""}${item.bytes === undefined ? "" : ` · ${item.bytes.toLocaleString()} bytes`}${item.estimatedTokens === undefined ? "" : ` · estimated ${item.estimatedTokens.toLocaleString()} tokens`}${item.truncated ? " · truncated" : ""} · ${sourceState}</small>${sourceAction ? `<div class="inspector-actions">${sourceAction}</div>` : ""}</li>`
    }).join("")}</ul></details></li>`).join("")}</ul>`
    : `<p class="placeholder">No admitted context receipts.</p>`
  const captureForm = `<form class="browser-context-form" data-browser-context-form><h2>Capture browser/debug context</h2><label>Task<textarea name="task" rows="3" maxlength="20000" required placeholder="What should OpenCode do with this explicit context?"></textarea></label><fieldset><legend>Sources</legend><label><input type="checkbox" name="source" value="selection"> Current editor selection</label><label><input type="radio" name="clipboard-source" value="console"> Clipboard console output</label><label><input type="radio" name="clipboard-source" value="element"> Clipboard element metadata</label><label><input type="radio" name="clipboard-source" value="terminal-task"> Clipboard terminal/task excerpt</label><label><input type="checkbox" name="source" value="diagnostics"> Workspace diagnostics summary</label><label><input type="checkbox" name="source" value="debug"> VS Code debug state</label><label><input type="checkbox" name="source" value="screenshot"> Screenshot file (chosen after submit)</label><label><input type="checkbox" name="source" value="url"> Approved URL (not fetched)</label><input type="url" name="approvedUrl" maxlength="8192" placeholder="https://example.test/page" aria-label="Approved URL"></fieldset><p class="placeholder">Clipboard and screenshot bytes are read only after this explicit submit. Only receipt metadata is persisted; OpenCode receives the prompt payload.</p><div class="inspector-actions"><button type="submit">Attach and send with OpenCode</button></div></form>`
  return `<h2>Context</h2>${usage}${captureForm}<h2>Receipts</h2>${receiptList}${auxiliaryArtifactMarkup(snapshot, "context-capture", "Context capture history")}`
}

function goalMarkup(snapshot: ChatSnapshot): string {
  const session = snapshot.session!
  const goal = session.goal
  const current = !goal ? `<h2>Goal</h2><p class="placeholder">No goal is active. A goal is an execution contract—not a plan document. Start one with <code>/goal your objective</code>, or hand an approved plan off in Goal mode.</p><div class="inspector-actions"><button type="button" data-workbench-action="start-goal">Start a goal</button></div>`
    : `<h2>Goal</h2><p><strong>${escapeHtml(goal.objective ?? "Active goal")}</strong></p><dl class="inspector-metrics"><dt>Status</dt><dd>${escapeHtml(goal.status ?? "unknown")}</dd><dt>Turns</dt><dd>${goal.autoTurns ?? 0}${goal.maxAutoTurns ? `/${goal.maxAutoTurns}` : ""}</dd><dt>Tokens</dt><dd>${goal.tokensUsed ?? 0}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""}</dd>${goal.blocker ? `<dt>Blocker</dt><dd>${escapeHtml(goal.blocker)}</dd>` : ""}</dl>`
  return `${current}${auxiliaryArtifactMarkup(snapshot, "goal-verification", "Verification history")}`
}

function runsMarkup(snapshot: ChatSnapshot, comparisonSorts: Readonly<Record<string, RunComparisonSort>> = {}): string {
  const groups = snapshot.runGroups ?? []
  const runWorktreeIDs = new Set(groups.flatMap((group) => group.runs.flatMap((run) => run.worktreeID ? [run.worktreeID] : [])))
  const standaloneWorktrees = (snapshot.worktrees ?? []).filter((entry) => !runWorktreeIDs.has(entry.id) && entry.phase !== "removed")
  const bounded = projectionNotice(snapshot, ["runGroups", "worktrees"])
  if (!groups.length && !standaloneWorktrees.length) return `<h2>Runs</h2>${bounded}<p class="placeholder">No isolated or multi-model runs have been started. Ordinary chat work remains in the current checkout and does not appear here.</p><div class="inspector-actions"><button type="button" data-workbench-action="compare-models">Compare models in isolated runs</button></div>`
  const worktreeMarkup = standaloneWorktrees.length
    ? `<section><h3>Isolated worktrees</h3><ul class="inspector-list">${standaloneWorktrees.slice().reverse().map((entry) => `<li data-worktree-id="${escapeHtml(entry.id)}"><strong>${escapeHtml(entry.branch)}</strong><small>${escapeHtml(entry.phase)} · ${escapeHtml(entry.path)}</small>${entry.error ? `<p>${escapeHtml(entry.error.message)}</p>` : ""}</li>`).join("")}</ul></section>`
    : ""
  return `<h2>Runs</h2>${bounded}${worktreeMarkup}${groups.map((group) => {
    const groupID = escapeHtml(group.id)
    const groupAction = (name: string, label: string) => `<button type="button" data-inspector-key="run:${groupID}:${name}" data-run-group="${groupID}" data-run-action="${name}">${label}</button>`
    const runs = group.runs.map((run) => {
      const runID = escapeHtml(run.id)
      const action = (name: string, label: string) => `<button type="button" data-inspector-key="run:${groupID}:${runID}:${name}" data-run-group="${groupID}" data-run-id="${runID}" data-run-action="${name}">${label}</button>`
      const waiting = run.session.sessionID === "pending"
      const controls = waiting
        ? `<span class="run-pending-status" role="status">${run.phase === "failed" ? "Worktree unavailable; refresh this run group to recover." : "Preparing worktree…"}</span>`
        : `${action("open", "Open worktree")}${action("diff", "Native diff")}${action("review", "Review")}${!run.retained ? `${action("keep", "Keep")}${action("discard", "Discard safely")}` : ""}`
      const lifecycle = ["working", "needs-input", "admitting", "preparing"].includes(run.phase)
        ? action("cancel", "Cancel")
        : ["failed", "cancelled"].includes(run.phase) && run.session.sessionID !== "pending" ? action("retry", "Retry") : ""
      return `<li data-run-id="${runID}"><strong>${escapeHtml(run.model)}</strong><small>${escapeHtml(run.phase)} · ${escapeHtml(run.session.directory)}${run.retained ? " · kept" : ""}${run.discarded ? " · discarded" : ""}</small>${run.discarded ? "" : `<div class="inspector-actions">${controls}${lifecycle}</div>`}${run.error ? `<p>${escapeHtml(run.error.message)}</p>` : ""}</li>`
    }).join("")
    return `<section><h3>${escapeHtml(group.title)}</h3><div class="inspector-actions">${groupAction("refresh", "Refresh")}${groupAction("compare", "Compare")}${groupAction("fuse", "Fuse")}</div>${runComparisonMarkup(snapshot, group.id, comparisonSorts)}<ul class="inspector-list">${runs}</ul></section>`
  }).join("")}`
}

function walkthroughMarkup(snapshot: ChatSnapshot, formatDate: (value: number) => string): string {
  const documents = snapshot.walkthroughs ?? []
  const bounded = projectionNotice(snapshot, ["walkthroughs", "walkthroughStops"])
  if (!documents.length) return `<h2>Walkthrough</h2>${bounded}<p class="placeholder">Walkthroughs are generated on demand from a complete exact diff and link explanations back to changed lines.</p><div class="inspector-actions"><button type="button" data-workbench-action="walkthrough">Generate changes walkthrough</button></div>`
  return `<h2>Walkthrough</h2>${bounded}${documents.slice().reverse().map((document) => `<section><h3>${escapeHtml(formatDate(document.generatedAt))}</h3><small>${escapeHtml(document.coverage)} · ${escapeHtml(document.model)} · ${escapeHtml(document.diffHash.slice(0, 12))}</small><ol class="inspector-list walkthrough-list">${document.stops.map((stop) => `<li><button type="button" data-inspector-key="walkthrough:${escapeHtml(document.id)}:${escapeHtml(stop.id)}" data-walkthrough-document="${escapeHtml(document.id)}" data-walkthrough-stop="${escapeHtml(stop.id)}">${escapeHtml(stop.title)}</button><p class="walkthrough-explanation">${escapeHtml(stop.explanation)}</p><small>${escapeHtml(stop.importance)} · ${stop.anchors.length} anchor${stop.anchors.length === 1 ? "" : "s"}</small></li>`).join("")}</ol></section>`).join("")}`
}

function withoutPrimaryHeading(markup: string): string {
  return markup.replace(/^<h2>[^<]*<\/h2>/, "")
}

function workflowSection(id: string, title: string, description: string, content: string): string {
  return `<section class="inspector-workflow-section" aria-labelledby="workflow-${id}"><div class="workflow-heading"><h3 id="workflow-${id}">${title}</h3><p>${description}</p></div>${withoutPrimaryHeading(content)}</section>`
}

function changesWorkspaceMarkup(snapshot: ChatSnapshot, formatDate: (value: number) => string): string {
  const session = snapshot.session!
  return `<h2>Changes &amp; quality</h2><p class="placeholder workbench-purpose">This page starts with OpenCode’s session-scoped file diff. Review, evidence, and walkthrough records appear only after you explicitly create them from that diff.</p>${[
    workflowSection("session-changes", "Session changes", "Files OpenCode attributes to this session; unrelated workspace edits are excluded.", changesMarkup(session)),
    workflowSection("review", "Review findings", "Model assessments generated on demand from an exact captured Git diff.", artifactMarkup(snapshot, "review")),
    workflowSection("evidence", "Verification evidence", "Deterministic task, test, diagnostic, and diff observations captured for this session.", evidenceMarkup(snapshot, formatDate)),
    workflowSection("walkthrough", "Walkthrough", "An optional guided explanation anchored to the exact changed lines.", walkthroughMarkup(snapshot, formatDate)),
  ].join("")}`
}

function executionWorkspaceMarkup(snapshot: ChatSnapshot, comparisonSorts: Readonly<Record<string, RunComparisonSort>>): string {
  return `<h2>Jobs &amp; runs</h2><p class="placeholder workbench-purpose">Live delegated work, terminals, child sessions, isolated model runs, and their OpenCode ancestry share one execution view.</p>${[
    workflowSection("jobs", "Current jobs", "Delegations, child sessions, worktrees, and native OpenCode terminals grouped by state.", jobsMarkup(snapshot)),
    workflowSection("runs", "Isolated runs", "Multi-model or isolated worktrees with diff, review, comparison, keep, discard, and fusion controls.", runsMarkup(snapshot, comparisonSorts)),
    workflowSection("lineage", "Session map", "The canonical OpenCode parent/child tree behind delegated and isolated work.", lineageMarkup(snapshot)),
  ].join("")}`
}

/** Produces bounded, escaped Inspector markup while leaving focus and scroll reconciliation to the view shell. */
export function inspectorPresentation(
  snapshot: ChatSnapshot,
  tab: InspectorTab,
  formatDate: (value: number) => string = (value) => new Date(value).toLocaleString(),
  options: InspectorPresentationOptions = {},
): InspectorPresentation {
  const session = snapshot.session
  const signature = JSON.stringify([session?.id, tab, presentationData(snapshot, tab), tab === "runs" || tab === "jobs" ? options.comparisonSorts : undefined])
  if (!session) return { signature, markup: `<div class="inspector-view inspector-view-empty"><p class="placeholder">Select a session to inspect.</p></div>` }
  const markup = tab === "activity" ? activityMarkup(session)
    : tab === "plan" || tab === "review" ? artifactMarkup(snapshot, tab)
    : tab === "evidence" ? evidenceMarkup(snapshot, formatDate)
    : tab === "changes" ? changesWorkspaceMarkup(snapshot, formatDate)
    : tab === "context" ? `${contextMarkup(snapshot, formatDate)}${projectionNotice(snapshot, ["contextReceipts", "taskArtifacts"])}`
    : tab === "goal" ? `${goalMarkup(snapshot)}${projectionNotice(snapshot, ["taskArtifacts"])}`
    : tab === "jobs" ? executionWorkspaceMarkup(snapshot, options.comparisonSorts ?? {})
    : tab === "lineage" ? lineageMarkup(snapshot)
    : tab === "runs" ? runsMarkup(snapshot, options.comparisonSorts)
    : tab === "health" ? healthMarkup(snapshot, formatDate)
    : walkthroughMarkup(snapshot, formatDate)
  return { signature, markup: `<div class="inspector-view inspector-view-${tab}">${markup}</div>` }
}
