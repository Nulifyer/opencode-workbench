import type { ChatSnapshot } from "@opencode-workbench/shared"
import { sessionGroup, type SessionGroup } from "../presentation.js"

type SessionOption = ChatSnapshot["sessions"][number]

export interface SessionListOptions {
  query?: string
  empty: string
  selectedSessionID?: string
  renderLimit?: number
  now?: number
}

const SESSION_GROUPS: readonly SessionGroup[] = ["Needs input", "Working", "Completed", "Today", "Yesterday", "Previous 7 days", "Older"]
const RECENT_GROUPS: readonly SessionGroup[] = ["Needs input", "Working", "Completed", "Today", "Yesterday"]

const SESSION_ICONS = {
  question: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 13A5 5 0 1 1 8 3a5 5 0 0 1 0 10Zm-.7-3h1.4v1.4H7.3V10Zm.8-5.7c1.4 0 2.4.8 2.4 2 0 .9-.5 1.4-1.3 1.9-.6.3-.7.5-.7 1H7.2c0-1.1.3-1.5 1.2-2 .6-.4.8-.6.8-1 0-.5-.4-.8-1.1-.8-.6 0-1 .3-1.4.8l-1-.8c.6-.7 1.3-1.1 2.4-1.1Z"/></svg>`,
  permission: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.3 13 3v3.8c0 3.2-2 5.9-5 7.5-3-1.6-5-4.3-5-7.5V3l5-1.7Zm0 1.5L4.3 4v2.8c0 2.5 1.4 4.6 3.7 6 2.3-1.4 3.7-3.5 3.7-6V4L8 2.8Zm-.7 2h1.4v4H7.3v-4Zm0 5.1h1.4v1.4H7.3V9.9Z"/></svg>`,
  error: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 13A5 5 0 1 1 8 3a5 5 0 0 1 0 10ZM7.3 4.7h1.4v4.2H7.3V4.7Zm0 5.3h1.4v1.4H7.3V10Z"/></svg>`,
  retry: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.3 4V1.8h1.3v4.4H9.2V4.9h2.1A4.7 4.7 0 1 0 12.5 9h1.4A6.1 6.1 0 1 1 12.3 4Z"/></svg>`,
  completed: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 13A5 5 0 1 1 8 3a5 5 0 0 1 0 10Zm2.7-7.6 1 1-4.3 4.2-2.2-2.2 1-1 1.2 1.2 3.3-3.3Z"/></svg>`,
  queued: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h8v1.3H2V3Zm0 4h8v1.3H2V7Zm0 4h8v1.3H2V11Zm10-5h1.3v2H15v1.3h-1.7V11H12V9.3h-1.7V8H12V6Z"/></svg>`,
}

export const SESSION_COMPLETED_ICON = SESSION_ICONS.completed

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character)
}

export function sessionStatusLabel(value: SessionOption): string {
  if (value.status.type === "error") return "Error"
  if ((value.questionCount ?? 0) > 0) return value.questionCount === 1 ? "Question pending" : `${value.questionCount} questions pending`
  if ((value.permissionCount ?? 0) > 0) return value.permissionCount === 1 ? "Permission pending" : `${value.permissionCount} permissions pending`
  if ((value.attention ?? 0) > 0) return "Input needed"
  if (value.status.type === "retry") return "Retrying"
  if (value.status.type === "busy") return "Working"
  if (value.unread > 0) return "Completed"
  if ((value.queued ?? 0) > 0) return `${value.queued} queued`
  return ""
}

function sessionIndicator(value: SessionOption): string {
  let kind = ""
  let label = ""
  let icon = ""
  if (value.status.type === "error") [kind, label, icon] = ["error", "Session error", SESSION_ICONS.error]
  else if ((value.questionCount ?? 0) > 0) [kind, label, icon] = ["question", sessionStatusLabel(value), SESSION_ICONS.question]
  else if ((value.permissionCount ?? 0) > 0 || (value.attention ?? 0) > 0) [kind, label, icon] = ["permission", sessionStatusLabel(value), SESSION_ICONS.permission]
  else if (value.status.type === "retry") [kind, label, icon] = ["retry", "Retrying", SESSION_ICONS.retry]
  else if (value.status.type === "busy") [kind, label] = ["working", "Working"]
  else if (value.unread > 0) [kind, label, icon] = ["completed", "Completed; not reviewed", SESSION_ICONS.completed]
  else if ((value.queued ?? 0) > 0) [kind, label, icon] = ["queued", `${value.queued} queued`, SESSION_ICONS.queued]
  return kind
    ? `<span class="session-row-icon state-${kind}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon}</span>`
    : `<span class="session-row-icon state-idle" aria-hidden="true"></span>`
}

function relativeSessionTime(updatedAt: number | undefined, now: number): string {
  const elapsed = Math.max(0, now - (updatedAt ?? 0))
  if (elapsed < 60_000) return "now"
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h`
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}d`
}

function workspaceName(directory?: string): string {
  return directory?.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || ""
}

function sessionButton(value: SessionOption, selectedSessionID: string | undefined, tabStop: string | undefined, now: number): string {
  const detail = [workspaceName(value.directory), value.changeCount ? `${value.changeCount} changed` : "", value.todo?.total ? `${value.todo.completed}/${value.todo.total} todos` : "", value.queued ? `${value.queued} queued` : ""].filter(Boolean).join(" · ")
  const status = sessionStatusLabel(value)
  return `<button type="button" class="session-row ${value.id === selectedSessionID ? "selected" : ""}" data-session-id="${escapeHtml(value.id)}" tabindex="${value.id === tabStop ? 0 : -1}"${value.id === selectedSessionID ? ` aria-current="true"` : ""}${status ? ` title="${escapeHtml(status)}"` : ""}>${sessionIndicator(value)}<span class="session-row-copy"><span class="session-row-heading"><span class="session-row-title">${escapeHtml(value.title)}</span><time>${escapeHtml(relativeSessionTime(value.updatedAt, now))}</time></span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span></button>`
}

function compareSessions(left: SessionOption, right: SessionOption, group: SessionGroup | undefined, now: number): number {
  if (!group) {
    const priority = SESSION_GROUPS.indexOf(sessionGroup(left, now)) - SESSION_GROUPS.indexOf(sessionGroup(right, now))
    if (priority) return priority
  }
  if (!group || RECENT_GROUPS.includes(group)) return left.title.localeCompare(right.title)
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.title.localeCompare(right.title)
}

function searchText(value: SessionOption, now: number): string {
  const aliases = value.unread > 0 ? "done unread" : ""
  return `${value.title}\n${value.directory ?? ""}\n${sessionStatusLabel(value)}\n${sessionGroup(value, now)}\n${aliases}`.toLowerCase()
}

/** Renders the shared history/rail session navigation with deterministic grouping, search, and roving-tab state. */
export function sessionListMarkup(values: SessionOption[], options: SessionListOptions): string {
  const now = options.now ?? Date.now()
  const query = options.query?.trim().toLowerCase() ?? ""
  const limit = Math.max(1, Math.floor(options.renderLimit ?? 200))
  const filtered = values.filter((value) => !query || searchText(value, now).includes(query))
  const ordered = query
    ? [...filtered].sort((left, right) => compareSessions(left, right, undefined, now))
    : SESSION_GROUPS.flatMap((group) => filtered.filter((value) => sessionGroup(value, now) === group).sort((left, right) => compareSessions(left, right, group, now)))
  if (!ordered.length) return `<p class="placeholder">${escapeHtml(options.empty)}</p>`

  const visible = ordered.slice(0, limit)
  const tabStop = visible.some((value) => value.id === options.selectedSessionID) ? options.selectedSessionID : visible[0]?.id
  const more = ordered.length > visible.length ? `<button type="button" class="text-action" data-session-more>Show ${Math.min(200, ordered.length - visible.length)} more</button>` : ""
  const list = (items: SessionOption[], label: string) => `<div role="list" aria-label="${escapeHtml(label)}">${items.map((value) => `<div role="listitem">${sessionButton(value, options.selectedSessionID, tabStop, now)}</div>`).join("")}</div>`
  if (query) return `<section class="history-group"><h2>Results</h2>${list(visible, "Search results")}${more}</section>`
  return SESSION_GROUPS.map((group) => {
    const grouped = visible.filter((value) => sessionGroup(value, now) === group)
    return grouped.length ? `<section class="history-group"><h2>${group} <span>${grouped.length}</span></h2>${list(grouped, `${group} sessions`)}</section>` : ""
  }).join("") + more
}
