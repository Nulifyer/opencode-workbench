import { parseHostMessage } from "@opencode-workbench/shared"
import type { ChatSnapshot, MessageBundle, MessagePart, WebviewToHostMessage } from "@opencode-workbench/shared"

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: WebviewToHostMessage): void
  getState(): T | undefined
  setState(state: T): void
}

const vscode = acquireVsCodeApi<{ draft?: string }>()
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const messages = element<HTMLElement>("messages")
const empty = element<HTMLElement>("empty")
const draft = element<HTMLTextAreaElement>("draft")
const send = element<HTMLButtonElement>("send")
const abort = element<HTMLButtonElement>("abort")
const create = element<HTMLButtonElement>("create")
const status = element<HTMLElement>("status")
const connection = element<HTMLElement>("connection")
const title = element<HTMLElement>("session-title")
const agent = element<HTMLSelectElement>("agent")
const model = element<HTMLSelectElement>("model")
let snapshot: ChatSnapshot = { connected: false, agents: [], models: [] }

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
    return `<div class="markdown${part.type === "reasoning" ? " reasoning" : ""}">${markdown(part.text)}</div>`
  }
  if (part.type === "tool") {
    const state = part.state
    const heading = state?.title || part.tool || "tool"
    const detail = state?.error || state?.output || ""
    return `<details class="tool" ${state?.status === "running" ? "open" : ""}><summary>${escapeHtml(heading)} <span>${escapeHtml(state?.status || "")}</span></summary>${detail ? `<pre>${escapeHtml(detail)}</pre>` : ""}</details>`
  }
  return ""
}

function messageHtml(message: MessageBundle): string {
  const role = message.info.role === "user" ? "You" : "OpenCode"
  const body = message.parts.map(partHtml).join("")
  const serializedError = message.info.error ? JSON.stringify(message.info.error, null, 2) ?? String(message.info.error) : ""
  const error = serializedError ? `<pre class="message-error">${escapeHtml(serializedError)}</pre>` : ""
  return `<article class="message ${message.info.role}"><div class="role">${role}</div><div class="content">${body || "<span class=\"pending\">...</span>"}${error}</div></article>`
}

function fillSelect(select: HTMLSelectElement, options: Array<{ value: string; label: string }>, selected?: string): void {
  const html = [`<option value="">Default</option>`, ...options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)]
  select.innerHTML = html.join("")
  select.value = selected || ""
}

function render(): void {
  const session = snapshot.session
  connection.textContent = snapshot.connected ? "connected" : "offline"
  connection.className = `pill ${snapshot.connected ? "online" : "offline"}`
  title.textContent = session?.title || "No session"
  empty.hidden = Boolean(session)
  messages.hidden = !session
  draft.disabled = !session
  send.disabled = !session || !snapshot.connected || session.status.type === "busy" || session.status.type === "retry"
  abort.disabled = !session || session.status.type === "idle"
  status.textContent = session?.status.type || "idle"
  fillSelect(agent, snapshot.agents.map((item) => ({ value: item.name, label: item.name })), session?.agent)
  fillSelect(model, snapshot.models.map((item) => ({ value: `${item.providerID}/${item.id}`, label: `${item.providerID} / ${item.name}` })), session?.model)
  agent.disabled = !session
  model.disabled = !session
  if (!session) {
    messages.replaceChildren()
    return
  }
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
  messages.innerHTML = session.messages.map(messageHtml).join("")
  if (draft.value !== session.draft) draft.value = session.draft
  if (nearBottom) messages.scrollTop = messages.scrollHeight
}

function post(message: WebviewToHostMessage): void {
  vscode.postMessage(message)
}

draft.addEventListener("input", () => {
  vscode.setState({ draft: draft.value })
  post({ type: "setDraft", draft: draft.value })
})
draft.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    send.click()
  }
})
send.addEventListener("click", () => {
  if (!draft.value.trim()) return
  post({ type: "send", text: draft.value, agent: agent.value || undefined, model: model.value || undefined })
})
abort.addEventListener("click", () => post({ type: "abort" }))
create.addEventListener("click", () => post({ type: "createSession" }))
agent.addEventListener("change", () => post({ type: "setPreference", agent: agent.value, model: model.value }))
model.addEventListener("change", () => post({ type: "setPreference", agent: agent.value, model: model.value }))
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

draft.value = vscode.getState()?.draft || ""
post({ type: "ready", draft: draft.value })
