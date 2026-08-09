import type { ChatSnapshot } from "@opencode-workbench/shared"

export type InspectorTab = "activity" | "changes" | "context" | "goal" | "runs" | "walkthrough"

export interface InspectorPresentation {
  signature: string
  markup: string
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
  if (tab === "changes") return session.changes
  if (tab === "context") return [session.context, session.contextReceipts]
  if (tab === "goal") return session.goal
  if (tab === "runs") return [snapshot.runGroups, snapshot.worktrees]
  return snapshot.walkthroughs
}

function activityMarkup(session: NonNullable<ChatSnapshot["session"]>): string {
  const active = session.status.type === "busy" || session.status.type === "retry"
  const completedTodos = session.todos?.filter((todo) => todo.status === "completed").length ?? 0
  return `<h2>Activity</h2><dl class="inspector-metrics"><dt>Session</dt><dd>${active ? "Working" : escapeHtml(session.status.type)}</dd><dt>Queued</dt><dd>${session.queue?.length ?? 0}</dd><dt>Permissions</dt><dd>${session.permissions?.length ?? 0}</dd><dt>Questions</dt><dd>${session.questions?.length ?? 0}</dd><dt>Todos</dt><dd>${completedTodos}/${session.todos?.length ?? 0}</dd></dl>`
}

function changesMarkup(session: NonNullable<ChatSnapshot["session"]>): string {
  const changes = session.changes ?? []
  return `<h2>Changes</h2>${changes.length
    ? `<ul class="inspector-list">${changes.map((change) => `<li><button type="button" data-inspector-key="file:${escapeHtml(change.file)}" data-inspector-file="${escapeHtml(change.file)}">${escapeHtml(change.file)}</button><small>+${change.additions} −${change.deletions}${change.status ? ` · ${escapeHtml(change.status)}` : ""}</small></li>`).join("")}</ul>`
    : `<p class="placeholder">No reported changes.</p>`}`
}

function contextMarkup(session: NonNullable<ChatSnapshot["session"]>, formatDate: (value: number) => string): string {
  const context = session.context
  const receipts = session.contextReceipts ?? []
  const usage = context
    ? `<dl class="inspector-metrics"><dt>Model</dt><dd>${escapeHtml(context.model ?? "Unknown")}</dd><dt>Tokens</dt><dd>${context.totalTokens.toLocaleString()}</dd><dt>Usage</dt><dd>${context.usagePercent === undefined ? "Unknown" : `${Math.round(context.usagePercent)}%`}</dd><dt>Cost</dt><dd>$${context.cost.toFixed(4)}</dd></dl>`
    : `<p class="placeholder">No token context reported.</p>`
  const receiptList = receipts.length
    ? `<ul class="inspector-list">${receipts.slice().reverse().map((receipt) => `<li>${receipt.items.length} item${receipt.items.length === 1 ? "" : "s"}<small>${escapeHtml(formatDate(receipt.admittedAt))} · ${escapeHtml(receipt.truncation)}</small></li>`).join("")}</ul>`
    : `<p class="placeholder">No admitted context receipts.</p>`
  return `<h2>Context</h2>${usage}<h2>Receipts</h2>${receiptList}`
}

function goalMarkup(session: NonNullable<ChatSnapshot["session"]>): string {
  const goal = session.goal
  if (!goal) return `<h2>Goal</h2><p class="placeholder">No active goal.</p>`
  return `<h2>Goal</h2><p><strong>${escapeHtml(goal.objective ?? "Active goal")}</strong></p><dl class="inspector-metrics"><dt>Status</dt><dd>${escapeHtml(goal.status ?? "unknown")}</dd><dt>Turns</dt><dd>${goal.autoTurns ?? 0}${goal.maxAutoTurns ? `/${goal.maxAutoTurns}` : ""}</dd><dt>Tokens</dt><dd>${goal.tokensUsed ?? 0}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""}</dd>${goal.blocker ? `<dt>Blocker</dt><dd>${escapeHtml(goal.blocker)}</dd>` : ""}</dl>`
}

function runsMarkup(snapshot: ChatSnapshot): string {
  const groups = snapshot.runGroups ?? []
  const runWorktreeIDs = new Set(groups.flatMap((group) => group.runs.flatMap((run) => run.worktreeID ? [run.worktreeID] : [])))
  const standaloneWorktrees = (snapshot.worktrees ?? []).filter((entry) => !runWorktreeIDs.has(entry.id) && entry.phase !== "removed")
  const bounded = projectionNotice(snapshot, ["runGroups", "worktrees"])
  if (!groups.length && !standaloneWorktrees.length) return `<h2>Runs</h2>${bounded}<p class="placeholder">This workspace has no visible isolated worktrees or run groups.</p>`
  const worktreeMarkup = standaloneWorktrees.length
    ? `<section><h3>Isolated worktrees</h3><ul class="inspector-list">${standaloneWorktrees.slice().reverse().map((entry) => `<li data-worktree-id="${escapeHtml(entry.id)}"><strong>${escapeHtml(entry.branch)}</strong><small>${escapeHtml(entry.phase)} · ${escapeHtml(entry.path)}</small>${entry.error ? `<p>${escapeHtml(entry.error.message)}</p>` : ""}</li>`).join("")}</ul></section>`
    : ""
  return `<h2>Runs</h2>${bounded}${worktreeMarkup}${groups.map((group) => {
    const groupID = escapeHtml(group.id)
    const groupAction = (name: string, label: string) => `<button type="button" data-inspector-key="run:${groupID}:${name}" data-run-group="${groupID}" data-run-action="${name}">${label}</button>`
    const runs = group.runs.map((run) => {
      const runID = escapeHtml(run.id)
      const action = (name: string, label: string) => `<button type="button" data-inspector-key="run:${groupID}:${runID}:${name}" data-run-group="${groupID}" data-run-id="${runID}" data-run-action="${name}">${label}</button>`
      const waiting = run.session.directory === "pending"
      const controls = waiting
        ? `<span class="run-pending-status" role="status">${run.phase === "failed" ? "Worktree unavailable; refresh this run group to recover." : "Preparing worktree…"}</span>`
        : `${action("open", "Open worktree")}${action("diff", "Native diff")}${action("review", "Review")}${!run.retained ? `${action("keep", "Keep")}${action("discard", "Discard safely")}` : ""}`
      const lifecycle = ["working", "needs-input", "admitting", "preparing"].includes(run.phase)
        ? action("cancel", "Cancel")
        : ["failed", "cancelled"].includes(run.phase) && run.session.sessionID !== "pending" ? action("retry", "Retry") : ""
      return `<li data-run-id="${runID}"><strong>${escapeHtml(run.model)}</strong><small>${escapeHtml(run.phase)} · ${escapeHtml(run.session.directory)}${run.retained ? " · kept" : ""}${run.discarded ? " · discarded" : ""}</small>${run.discarded ? "" : `<div class="inspector-actions">${controls}${lifecycle}</div>`}${run.error ? `<p>${escapeHtml(run.error.message)}</p>` : ""}</li>`
    }).join("")
    return `<section><h3>${escapeHtml(group.title)}</h3><div class="inspector-actions">${groupAction("refresh", "Refresh")}${groupAction("compare", "Compare")}${groupAction("fuse", "Fuse")}</div><ul class="inspector-list">${runs}</ul></section>`
  }).join("")}`
}

function walkthroughMarkup(snapshot: ChatSnapshot, formatDate: (value: number) => string): string {
  const documents = snapshot.walkthroughs ?? []
  const bounded = projectionNotice(snapshot, ["walkthroughs", "walkthroughStops"])
  if (!documents.length) return `<h2>Walkthrough</h2>${bounded}<p class="placeholder">Generate a walkthrough after a complete diff snapshot is available.</p>`
  return `<h2>Walkthrough</h2>${bounded}${documents.slice().reverse().map((document) => `<section><h3>${escapeHtml(formatDate(document.generatedAt))}</h3><small>${escapeHtml(document.coverage)} · ${escapeHtml(document.model)} · ${escapeHtml(document.diffHash.slice(0, 12))}</small><ol class="inspector-list walkthrough-list">${document.stops.map((stop) => `<li><button type="button" data-inspector-key="walkthrough:${escapeHtml(document.id)}:${escapeHtml(stop.id)}" data-walkthrough-document="${escapeHtml(document.id)}" data-walkthrough-stop="${escapeHtml(stop.id)}">${escapeHtml(stop.title)}</button><p class="walkthrough-explanation">${escapeHtml(stop.explanation)}</p><small>${escapeHtml(stop.importance)} · ${stop.anchors.length} anchor${stop.anchors.length === 1 ? "" : "s"}</small></li>`).join("")}</ol></section>`).join("")}`
}

/** Produces bounded, escaped Inspector markup while leaving focus and scroll reconciliation to the view shell. */
export function inspectorPresentation(
  snapshot: ChatSnapshot,
  tab: InspectorTab,
  formatDate: (value: number) => string = (value) => new Date(value).toLocaleString(),
): InspectorPresentation {
  const session = snapshot.session
  const signature = JSON.stringify([session?.id, tab, presentationData(snapshot, tab)])
  if (!session) return { signature, markup: `<p class="placeholder">Select a session to inspect.</p>` }
  const markup = tab === "activity" ? activityMarkup(session)
    : tab === "changes" ? changesMarkup(session)
    : tab === "context" ? `${contextMarkup(session, formatDate)}${projectionNotice(snapshot, ["contextReceipts"])}`
    : tab === "goal" ? goalMarkup(session)
    : tab === "runs" ? runsMarkup(snapshot)
    : walkthroughMarkup(snapshot, formatDate)
  return { signature, markup }
}
