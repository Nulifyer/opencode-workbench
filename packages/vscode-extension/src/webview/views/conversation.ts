/// <reference lib="dom" />

import {
  type ChatSnapshot,
  isNativeCompactionContinuationMessage,
  type MessageBundle,
} from "@opencode-workbench/shared"
import { activityCollapsed, activityWorking, turnContent } from "../presentation.js"
import { type ScrollAnchor, ScrollController, type ScrollViewport } from "../controllers/scroll-controller.js"

type Session = NonNullable<ChatSnapshot["session"]>

export interface ConversationEntry {
  message: MessageBundle
  live: boolean
}

export interface ProjectedConversationEntry extends ConversationEntry {
  revisionKey: string
}

export interface ProjectedConversationTurn {
  key: string
  assistantOnly: boolean
  entries: ConversationEntry[]
  displayEntries: ProjectedConversationEntry[]
  firstAssistant: number
  contentSignature: string
  finalTextPartKeys: string[]
  hasActivity: boolean
  working: boolean
}

interface CachedClassification {
  signature: string
  hasActivity: boolean
  finalTextPartKeys: string[]
}

export interface ConversationTurnGroup {
  key: string
  assistantOnly: boolean
  entries: ConversationEntry[]
}

function visibleReasoningOnly(message: MessageBundle): boolean {
  const visible = message.parts.filter((part) =>
    !part.synthetic && part.type !== "step-start" && part.type !== "step-finish"
  )
  return message.info.role === "assistant" && visible.length > 0 && visible.every((part) => part.type === "reasoning")
}

function groupedConversationTurns(
  session: Session,
  active: boolean,
): { turns: ConversationTurnGroup[]; lastAssistantID?: string } {
  let lastAssistantID: string | undefined
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index]?.info.role !== "assistant") continue
    lastAssistantID = session.messages[index]!.info.id
    break
  }

  const grouped = new Map<string, ConversationEntry[]>()
  const order: string[] = []
  let turnKey: string | undefined
  for (const message of session.messages) {
    if (isNativeCompactionContinuationMessage(message)) continue
    if (message.info.role === "user") {
      turnKey = `user:${message.info.id}`
      order.push(turnKey)
      grouped.set(turnKey, [])
    } else if (!turnKey) {
      turnKey = `assistant:${message.info.id}`
      order.push(turnKey)
      grouped.set(turnKey, [])
    }
    const live = message.info.role === "assistant" && active && !message.info.time?.completed &&
      message.info.id === lastAssistantID
    grouped.get(turnKey!)!.push({ message, live })
  }
  return {
    lastAssistantID,
    turns: order.map((key) => ({ key, assistantOnly: key.startsWith("assistant:"), entries: grouped.get(key)! })),
  }
}

/** Uses the same lightweight turn boundaries as the rendered conversation. */
export function conversationTurnGroups(session: Session): ConversationTurnGroup[] {
  return groupedConversationTurns(session, false).turns
}

function projectConversationTurnsWithCache(
  session: Session,
  active: boolean,
  classifications?: Map<string, CachedClassification>,
): ProjectedConversationTurn[] {
  const grouped = groupedConversationTurns(session, active)
  return grouped.turns.map(({ key, assistantOnly, entries }) => {
    const displayEntries: ProjectedConversationEntry[] = []
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      if (!visibleReasoningOnly(entry.message)) {
        displayEntries.push({
          ...entry,
          revisionKey: `${entry.message.info.id}:${session.messageRevisions[entry.message.info.id] ?? 0}`,
        })
        continue
      }
      const run = [entry]
      while (index + 1 < entries.length && visibleReasoningOnly(entries[index + 1]!.message)) {
        run.push(entries[index + 1]!)
        index += 1
      }
      if (run.length === 1) {
        displayEntries.push({
          ...entry,
          revisionKey: `${entry.message.info.id}:${session.messageRevisions[entry.message.info.id] ?? 0}`,
        })
        continue
      }
      const first = run[0]!.message
      const last = run.at(-1)!.message
      displayEntries.push({
        message: {
          info: {
            id: `thoughts:${first.info.id}:${last.info.id}:${run.length}`,
            sessionID: first.info.sessionID,
            role: "assistant",
            time: { created: first.info.time?.created, completed: last.info.time?.completed },
          },
          parts: run.flatMap((item) =>
            item.message.parts.filter((part) => !part.synthetic && part.type === "reasoning")
          ),
        },
        live: run.some((item) => item.live),
        revisionKey: run.map((item) => `${item.message.info.id}:${session.messageRevisions[item.message.info.id] ?? 0}`)
          .join(","),
      })
    }

    const contentSignature = displayEntries.map((entry) => entry.revisionKey).join("|")
    const cached = classifications?.get(key)
    const content = cached?.signature === contentSignature
      ? cached
      : { signature: contentSignature, ...turnContent(displayEntries.map((entry) => entry.message)) }
    if (cached !== content) classifications?.set(key, content)
    return {
      key,
      assistantOnly,
      entries,
      displayEntries,
      firstAssistant: displayEntries.findIndex((entry) => entry.message.info.role === "assistant"),
      contentSignature,
      finalTextPartKeys: content.finalTextPartKeys,
      hasActivity: content.hasActivity,
      working: activityWorking(
        active,
        grouped.lastAssistantID,
        entries.filter((entry) => entry.message.info.role === "assistant").map((entry) => entry.message.info.id),
      ),
    }
  })
}

/** Projects transcript messages into stable turns and coalesces adjacent reasoning-only updates. */
export function projectConversationTurns(session: Session, active: boolean): ProjectedConversationTurn[] {
  return projectConversationTurnsWithCache(session, active)
}

export interface ConversationViewOptions {
  container: HTMLElement
  leadingElement?: HTMLElement
  jumpLatest: HTMLButtonElement
  jumpLatestCount: HTMLElement
  renderUser(message: MessageBundle): string
  renderAssistant(message: MessageBundle, live: boolean, finalTextParts: ReadonlySet<string>): string
  renderTiming(entries: ConversationEntry[], working: boolean): string
  renderDependencySignature?(message: MessageBundle): string
}

/** Owns incremental conversation DOM reconciliation, scroll anchoring, focus retention, and unread state. */
export class ConversationView {
  private readonly scroll: ScrollController
  private readonly turns = new Map<string, HTMLElement>()
  private readonly messages = new Map<string, { node: HTMLElement; signature: string }>()
  private readonly classifications = new Map<string, CachedClassification>()
  private readonly collapsePreferences = new Map<string, boolean>()
  private readonly sessionViewports = new Map<string, ScrollViewport>()
  private renderedSessionID?: string
  private unseenMessages = 0

  constructor(private readonly options: ConversationViewOptions) {
    this.scroll = new ScrollController(options.container)
  }

  nearBottom(): boolean {
    return this.scroll.nearBottom()
  }

  capturePrependAnchor(): ScrollAnchor | undefined {
    const firstTurn = this.options.container.querySelector<HTMLElement>(":scope > .turn") ?? undefined
    const firstMessage = firstTurn?.querySelector<HTMLElement>("[data-message-id]") ?? undefined
    return this.scroll.capturePrependAnchor(firstMessage ?? firstTurn)
  }

  restorePrependAnchor(anchor?: ScrollAnchor): void {
    this.scroll.restorePrependAnchor(anchor)
  }

  addUnseen(count: number): void {
    if (count > 0) this.unseenMessages += count
  }

  rememberActivityCollapsed(key: string, collapsed: boolean): void {
    this.collapsePreferences.set(key, collapsed)
  }

  clear(): void {
    this.rememberViewport()
    this.clearDom()
  }

  private clearDom(): void {
    this.options.container.replaceChildren(...(this.options.leadingElement ? [this.options.leadingElement] : []))
    this.turns.clear()
    this.messages.clear()
    this.classifications.clear()
    this.renderedSessionID = undefined
    this.unseenMessages = 0
    this.updateJumpLatest()
  }

  jumpToLatest(): void {
    this.scroll.latest()
    if (this.renderedSessionID) this.sessionViewports.set(this.renderedSessionID, this.scroll.captureViewport())
    this.unseenMessages = 0
    this.updateJumpLatest()
  }

  handleScroll(): void {
    if (this.nearBottom()) this.unseenMessages = 0
    if (this.renderedSessionID) this.sessionViewports.set(this.renderedSessionID, this.scroll.captureViewport())
    this.updateJumpLatest()
  }

  render(session: Session, active: boolean, forcedPrependAnchor?: ScrollAnchor): void {
    let restoredViewport: ScrollViewport | undefined
    if (this.renderedSessionID !== session.id) {
      this.rememberViewport()
      restoredViewport = this.sessionViewports.get(session.id) ?? { atBottom: true, scrollTop: 0 }
      this.clearDom()
      this.renderedSessionID = session.id
    }
    const nearBottom = restoredViewport?.atBottom ?? this.nearBottom()
    const prependAnchor = forcedPrependAnchor ?? (!nearBottom ? this.scroll.capturePrependAnchor() : undefined)
    const projectedTurns = projectConversationTurnsWithCache(session, active, this.classifications)
    const expectedMessages = new Set<string>()
    const expectedTurns = new Set<string>()
    projectedTurns.forEach((projected, turnIndex) => {
      expectedTurns.add(projected.key)
      let turn = this.turns.get(projected.key)
      if (!turn) {
        turn = document.createElement("section")
        turn.className = `turn${projected.assistantOnly ? " assistant-only" : ""}`
        this.turns.set(projected.key, turn)
      }
      const leadingOffset = this.options.leadingElement?.parentElement === this.options.container ? 1 : 0
      const expectedPosition = this.options.container.children.item(turnIndex + leadingOffset)
      if (expectedPosition !== turn) this.options.container.insertBefore(turn, expectedPosition)

      const finalTextParts = new Set(projected.finalTextPartKeys)
      const turnTiming = this.options.renderTiming(projected.entries, projected.working)
      const activityKey = `${session.id}:${projected.key}`
      let activityHeader = turn.querySelector<HTMLElement>(":scope > .turn-activity-header")
      let activityToggle = activityHeader?.querySelector<HTMLButtonElement>(".turn-activity-toggle") ?? null
      if (projected.hasActivity) {
        const wasWorking = activityToggle?.dataset.working === "true"
        const existingCollapse = activityToggle ? turn.classList.contains("activity-collapsed") : undefined
        if (projected.working) this.collapsePreferences.delete(activityKey)
        if (!activityToggle) {
          activityHeader = document.createElement("div")
          activityHeader.className = "turn-activity-header"
          activityToggle = document.createElement("button")
          activityToggle.type = "button"
          activityToggle.className = "turn-activity-toggle"
          activityToggle.dataset.turnActivity = "true"
          const divider = document.createElement("div")
          divider.className = "turn-activity-divider"
          activityHeader.append(activityToggle, divider)
        }
        turn.classList.toggle(
          "activity-collapsed",
          activityCollapsed(projected.working, wasWorking, this.collapsePreferences.get(activityKey), existingCollapse),
        )
        activityToggle.dataset.activityKey = activityKey
        activityToggle.dataset.working = String(projected.working)
        activityToggle.setAttribute("aria-disabled", String(projected.working))
        activityToggle.classList.toggle("working", projected.working)
        const timingMarkup = turnTiming ||
          `<span>Activity</span><span class="activity-chevron" aria-hidden="true">›</span>`
        if (activityToggle.dataset.renderSignature !== timingMarkup) {
          activityToggle.innerHTML = timingMarkup
          activityToggle.dataset.renderSignature = timingMarkup
        }
        activityToggle.setAttribute("aria-expanded", String(!turn.classList.contains("activity-collapsed")))
        activityToggle.title = projected.working
          ? "Work activity stays expanded while OpenCode is working"
          : turn.classList.contains("activity-collapsed")
          ? "Show work activity"
          : "Hide work activity"
        const expectedHeader = turn.children.item(projected.firstAssistant)
        if (expectedHeader !== activityHeader) turn.insertBefore(activityHeader!, expectedHeader)
      } else {
        activityHeader?.remove()
        turn.classList.remove("activity-collapsed")
      }

      const classificationSignature = `${projected.hasActivity}:${projected.finalTextPartKeys.join(",")}`
      projected.displayEntries.forEach(({ message, live, revisionKey }, messageIndex) => {
        expectedMessages.add(message.info.id)
        const delegationSignature = message.parts.flatMap((part) => {
          const delegation = session.delegations?.find((item) => item.partID === part.id)
          return delegation ? [`${part.id}:${delegation.revision}:${delegation.status.type}`] : []
        }).join(",")
        const receiptSignature = message.info.role === "user"
          ? JSON.stringify(session.contextReceipts?.find((receipt) => receipt.promptID === message.info.id) ?? null)
          : ""
        const dependencySignature = this.options.renderDependencySignature?.(message) ?? ""
        const signature = `${revisionKey}:${
          message.info.time?.completed ?? ""
        }:${live}:${classificationSignature}:${delegationSignature}:${dependencySignature}:${receiptSignature}`
        let rendered = this.messages.get(message.info.id)
        if (!rendered) {
          const html = message.info.role === "user"
            ? this.options.renderUser(message)
            : this.options.renderAssistant(message, live, finalTextParts)
          rendered = { node: this.htmlNode(html), signature }
          this.messages.set(message.info.id, rendered)
        } else if (rendered.signature !== signature) {
          const html = message.info.role === "user"
            ? this.options.renderUser(message)
            : this.options.renderAssistant(message, live, finalTextParts)
          rendered = { node: this.replaceMessage(rendered.node, html), signature }
          this.messages.set(message.info.id, rendered)
        }
        const offset = projected.hasActivity && messageIndex >= projected.firstAssistant ? 1 : 0
        const expectedMessage = turn!.children.item(messageIndex + offset)
        if (expectedMessage !== rendered.node) turn!.insertBefore(rendered.node, expectedMessage)
      })
    })

    for (const [messageID, rendered] of this.messages) {
      if (expectedMessages.has(messageID)) continue
      rendered.node.remove()
      this.messages.delete(messageID)
    }
    for (const [key, turn] of this.turns) {
      if (expectedTurns.has(key)) continue
      turn.remove()
      this.turns.delete(key)
      this.classifications.delete(key)
    }
    if (restoredViewport) {
      this.scroll.restoreViewport(restoredViewport)
      if (restoredViewport.atBottom) this.unseenMessages = 0
    } else if (prependAnchor) this.scroll.restorePrependAnchor(prependAnchor)
    if (!restoredViewport && nearBottom && !forcedPrependAnchor) {
      this.scroll.latest()
      this.unseenMessages = 0
    }
    if (this.renderedSessionID) this.sessionViewports.set(this.renderedSessionID, this.scroll.captureViewport())
    this.updateJumpLatest()
  }

  private rememberViewport(): void {
    if (this.renderedSessionID) this.sessionViewports.set(this.renderedSessionID, this.scroll.captureViewport())
  }

  private updateJumpLatest(): void {
    const show = !this.options.container.hidden && !this.nearBottom()
    this.options.jumpLatest.hidden = !show
    this.options.jumpLatestCount.textContent = show && this.unseenMessages ? String(this.unseenMessages) : ""
    this.options.jumpLatest.setAttribute(
      "aria-label",
      this.unseenMessages ? `Jump to latest message, ${this.unseenMessages} new` : "Jump to latest message",
    )
  }

  private htmlNode(html: string): HTMLElement {
    const template = document.createElement("template")
    template.innerHTML = html
    const node = template.content.firstElementChild
    if (!(node instanceof HTMLElement)) throw new Error("Could not render OpenCode message")
    return node
  }

  private replaceMessage(node: HTMLElement, html: string): HTMLElement {
    const detailStates = new Map(
      Array.from(
        node.querySelectorAll<HTMLDetailsElement>("details[data-detail-key]"),
        (detail) => [detail.dataset.detailKey || "", detail.open],
      ),
    )
    const active = document.activeElement instanceof HTMLElement && node.contains(document.activeElement)
      ? document.activeElement
      : undefined
    const focusedDetail = active?.closest<HTMLDetailsElement>("details[data-detail-key]")?.dataset.detailKey
    const focusedUrl = active?.closest<HTMLElement>("[data-url]")?.dataset.url
    const replacement = this.htmlNode(html)
    for (const detail of replacement.querySelectorAll<HTMLDetailsElement>("details[data-detail-key]")) {
      const open = detailStates.get(detail.dataset.detailKey || "")
      if (open !== undefined) detail.open = open
    }
    node.replaceWith(replacement)
    if (focusedDetail) {
      replacement.querySelector<HTMLDetailsElement>(`details[data-detail-key="${CSS.escape(focusedDetail)}"]`)
        ?.querySelector("summary")?.focus()
    } else if (focusedUrl) {
      Array.from(replacement.querySelectorAll<HTMLElement>("[data-url]")).find((candidate) =>
        candidate.dataset.url === focusedUrl
      )?.focus()
    }
    return replacement
  }
}
