import { parseHostMessage } from "@opencode-workbench/shared"
import type { ChatSnapshot, MessageBundle, MessagePart, WebviewToHostMessage } from "@opencode-workbench/shared"

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: WebviewToHostMessage): void
}

const vscode = acquireVsCodeApi()
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const messages = element<HTMLElement>("messages")
const empty = element<HTMLElement>("empty")
const draft = element<HTMLTextAreaElement>("draft")
const send = element<HTMLButtonElement>("send")
const abort = element<HTMLButtonElement>("abort")
const createHeader = element<HTMLButtonElement>("create-header")
const createEmpty = element<HTMLButtonElement>("create-empty")
const status = element<HTMLElement>("status")
const connection = element<HTMLElement>("connection")
const sessionSelect = element<HTMLSelectElement>("session")
const agent = element<HTMLSelectElement>("agent")
const model = element<HTMLSelectElement>("model")
const composer = element<HTMLElement>("composer")
let snapshot: ChatSnapshot = { connected: false, sessions: [], agents: [], models: [] }
let renderedSessions = ""
let renderedSessionID: string | undefined
const renderedMessages = new Map<string, { node: HTMLElement; signature: string }>()

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character)
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function plainInline(source: string): string {
  return escapeHtml(source).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")
}

function inlineMarkdown(source: string): string {
  const token = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\))/g
  let result = ""
  let offset = 0
  for (const match of source.matchAll(token)) {
    const index = match.index ?? 0
    result += plainInline(source.slice(offset, index))
    const value = match[0]
    if (value.startsWith("`")) {
      result += `<code>${escapeHtml(value.slice(1, -1))}</code>`
    } else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)
      const label = parts?.[1]
      const target = parts?.[2]
      const url = target ? safeHttpUrl(target) : undefined
      result += label && url
        ? `<a href="#" data-url="${escapeHtml(url)}">${plainInline(label)}</a>`
        : plainInline(value)
    }
    offset = index + value.length
  }
  result += plainInline(source.slice(offset))
  return result
}

function markdown(source: string): string {
  const chunks = source.split(/(^```[^\n]*\n|^```\s*$)/m)
  let inCode = false
  let language = ""
  let output = ""
  for (const chunk of chunks) {
    if (chunk.startsWith("```")) {
      if (inCode) output += "</code></pre>"
      else {
        language = chunk.slice(3).trim()
        output += `<pre><code${language ? ` data-language="${escapeHtml(language)}"` : ""}>`
      }
      inCode = !inCode
    } else {
      output += inCode ? escapeHtml(chunk) : inlineMarkdown(chunk)
    }
  }
  if (inCode) output += "</code></pre>"
  return output
}

function partHtml(part: MessagePart): string {
  if (part.synthetic) return ""
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    return part.type === "reasoning"
      ? `<details class="reasoning"><summary>Reasoning</summary><div class="markdown">${markdown(part.text)}</div></details>`
      : `<div class="markdown">${markdown(part.text)}</div>`
  }
  if (part.type === "tool") {
    const state = part.state
    const heading = state?.title || part.tool || "tool"
    const detail = state?.error || state?.output || ""
    const toolStatus = state?.status || "pending"
    return `<details class="tool tool-${escapeHtml(toolStatus)}" ${toolStatus === "running" ? "open" : ""}><summary><span class="tool-dot" aria-hidden="true"></span><span class="tool-title">${escapeHtml(heading)}</span><span class="tool-status">${escapeHtml(toolStatus)}</span></summary>${detail ? `<pre>${escapeHtml(detail)}</pre>` : ""}</details>`
  }
  return ""
}

function messageHtml(message: MessageBundle): string {
  const role = message.info.role === "user" ? "You" : "OpenCode"
  const body = message.parts.map(partHtml).join("")
  let serializedError = ""
  try {
    serializedError = message.info.error ? JSON.stringify(message.info.error, null, 2) ?? String(message.info.error) : ""
  } catch {
    serializedError = "The server returned an unreadable error."
  }
  const error = serializedError ? `<pre class="message-error">${escapeHtml(serializedError)}</pre>` : ""
  return `<article class="message ${message.info.role}" data-message-id="${escapeHtml(message.info.id)}"><div class="message-heading">${role}</div><div class="content">${body || "<span class=\"pending\">Working…</span>"}${error}</div></article>`
}

function messageNode(html: string): HTMLElement {
  const template = document.createElement("template")
  template.innerHTML = html
  const node = template.content.firstElementChild
  if (!(node instanceof HTMLElement)) throw new Error("Could not render OpenCode message")
  return node
}

function clearMessages(): void {
  messages.replaceChildren()
  renderedMessages.clear()
  renderedSessionID = undefined
}

function renderTranscript(session: NonNullable<ChatSnapshot["session"]>): void {
  if (renderedSessionID !== session.id) {
    clearMessages()
    renderedSessionID = session.id
  }
  const expected = new Set<string>()
  session.messages.forEach((message, index) => {
    expected.add(message.info.id)
    const signature = String(session.messageRevisions[message.info.id] ?? 0)
    let rendered = renderedMessages.get(message.info.id)
    if (!rendered) {
      rendered = { node: messageNode(messageHtml(message)), signature }
      renderedMessages.set(message.info.id, rendered)
    } else if (rendered.signature !== signature) {
      const openDetails = Array.from(rendered.node.querySelectorAll("details"), (detail) => detail.open)
      const replacement = messageNode(messageHtml(message))
      Array.from(replacement.querySelectorAll("details")).forEach((detail, detailIndex) => {
        if (openDetails[detailIndex] !== undefined) detail.open = openDetails[detailIndex]!
      })
      rendered.node.replaceWith(replacement)
      rendered = { node: replacement, signature }
      renderedMessages.set(message.info.id, rendered)
    }
    const current = messages.children.item(index)
    if (current !== rendered.node) messages.insertBefore(rendered.node, current)
  })
  for (const [messageID, rendered] of renderedMessages) {
    if (expected.has(messageID)) continue
    rendered.node.remove()
    renderedMessages.delete(messageID)
  }
}

function fillSelect(select: HTMLSelectElement, defaultLabel: string, options: Array<{ value: string; label: string }>, selected?: string): void {
  const html = [`<option value="">${escapeHtml(defaultLabel)}</option>`, ...options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)]
  select.innerHTML = html.join("")
  select.value = selected || ""
}

function sessionLabel(session: ChatSnapshot["sessions"][number]): string {
  const suffix = [session.status.type !== "idle" ? session.status.type : "", session.unread ? `${session.unread} unread` : ""].filter(Boolean).join(" · ")
  return suffix ? `${session.title} — ${suffix}` : session.title
}

function fillSessions(selected?: string): void {
  const options = snapshot.sessions.map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(sessionLabel(session))}</option>`)
  const html = options.length ? options.join("") : `<option value="">No sessions</option>`
  if (html !== renderedSessions) {
    sessionSelect.innerHTML = html
    renderedSessions = html
  }
  sessionSelect.value = selected || ""
}

function resizeDraft(): void {
  draft.style.height = "auto"
  draft.style.height = `${Math.min(Math.max(draft.scrollHeight, 46), 180)}px`
}

function render(): void {
  const session = snapshot.session
  const active = session?.status.type === "busy" || session?.status.type === "retry"
  connection.textContent = snapshot.connected ? "Connected" : "Offline"
  connection.className = `connection ${snapshot.connected ? "online" : "offline"}`
  fillSessions(session?.id)
  sessionSelect.disabled = snapshot.sessions.length === 0
  createHeader.disabled = !snapshot.connected
  createEmpty.disabled = !snapshot.connected
  const emptyConversation = Boolean(session && session.messages.length === 0)
  empty.hidden = Boolean(session && !emptyConversation)
  messages.hidden = !session || emptyConversation
  createEmpty.hidden = Boolean(session)
  draft.disabled = !session
  composer.setAttribute("aria-busy", String(Boolean(active)))
  messages.setAttribute("aria-busy", String(Boolean(active)))
  send.disabled = !session || !snapshot.connected || active
  send.hidden = Boolean(active)
  abort.disabled = !session || !active
  abort.hidden = !active
  status.textContent = session ? session.status.type[0]?.toUpperCase() + session.status.type.slice(1) : snapshot.connected ? "Ready" : "Offline"
  fillSelect(agent, "Default agent", snapshot.agents.map((item) => ({ value: item.name, label: item.name })), session?.agent)
  fillSelect(model, "Default model", snapshot.models.map((item) => ({ value: `${item.providerID}/${item.id}`, label: `${item.providerID} / ${item.name}` })), session?.model)
  agent.disabled = !session
  model.disabled = !session
  if (!session) {
    clearMessages()
    draft.value = ""
    resizeDraft()
    return
  }
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
  renderTranscript(session)
  if (draft.value !== session.draft) draft.value = session.draft
  resizeDraft()
  if (nearBottom) messages.scrollTop = messages.scrollHeight
}

function post(message: WebviewToHostMessage): void {
  vscode.postMessage(message)
}

draft.addEventListener("input", () => {
  resizeDraft()
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "setDraft", sessionID, draft: draft.value })
})
draft.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    send.click()
  }
})
send.addEventListener("click", () => {
  const sessionID = snapshot.session?.id
  if (!sessionID || !draft.value.trim()) return
  post({ type: "send", sessionID, text: draft.value, agent: agent.value || undefined, model: model.value || undefined })
})
abort.addEventListener("click", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "abort", sessionID })
})
createHeader.addEventListener("click", () => post({ type: "createSession" }))
createEmpty.addEventListener("click", () => post({ type: "createSession" }))
sessionSelect.addEventListener("change", () => {
  if (sessionSelect.value) post({ type: "selectSession", sessionID: sessionSelect.value })
})
agent.addEventListener("change", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "setPreference", sessionID, agent: agent.value, model: model.value })
})
model.addEventListener("change", () => {
  const sessionID = snapshot.session?.id
  if (sessionID) post({ type: "setPreference", sessionID, agent: agent.value, model: model.value })
})
document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    const prompt = button.dataset.prompt || ""
    if (!snapshot.session) {
      post({ type: "createSession", draft: prompt })
      return
    }
    draft.value = prompt
    resizeDraft()
    post({ type: "setDraft", sessionID: snapshot.session.id, draft: draft.value })
    draft.focus()
  })
})
messages.addEventListener("click", (event) => {
  const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-url]") : undefined
  const url = anchor?.dataset.url
  if (url) post({ type: "openLink", url })
})
window.addEventListener("message", (event) => {
  const message = parseHostMessage(event.data)
  if (!message) return
  if (message.type === "error") {
    status.textContent = message.message
    status.title = message.message
    return
  }
  snapshot = message.snapshot
  render()
})

resizeDraft()
post({ type: "ready" })
