/// <reference lib="dom" />

import {
  type ChatSnapshot,
  MULTI_RUN_DEFAULT_CONCURRENCY,
  MULTI_RUN_MAX_CANDIDATES,
  MULTI_RUN_MAX_CONCURRENCY,
} from "@opencode-workbench/shared"
import { ModalController } from "./modal-controller.js"

type Model = ChatSnapshot["models"][number]
type Providers = ChatSnapshot["providers"]

export interface MultiRunElements {
  root: HTMLElement
  search: HTMLInputElement
  options: HTMLElement
  selectVisible: HTMLButtonElement
  clear: HTMLButtonElement
  count: HTMLElement
  disclosure: HTMLElement
  concurrency: HTMLInputElement
  start: HTMLButtonElement
}

export type MultiRunOwnerValidation = "valid" | "missing" | "session-changed" | "draft-changed"

export class MultiRunController {
  private readonly selection = new Set<string>()
  private readonly modal: ModalController
  private owner?: { sessionID: string; draft: string }
  private models: Model[] = []
  private providers: Providers
  private connected = false
  private catalogSignature = ""

  constructor(private readonly elements: MultiRunElements, private readonly escapeHtml: (value: string) => string) {
    this.modal = new ModalController(elements.root)
  }

  get open(): boolean {
    return this.modal.open
  }
  get values(): string[] {
    return [...this.selection]
  }

  show(
    input: {
      sessionID: string
      draft: string
      preferred?: string
      models: Model[]
      providers?: Providers
      connected: boolean
      returnFocus?: HTMLElement
    },
  ): void {
    this.owner = { sessionID: input.sessionID, draft: input.draft }
    this.models = input.models
    this.providers = input.providers
    this.connected = input.connected
    this.catalogSignature = this.signature(input.models, input.providers, input.connected)
    this.selection.clear()
    if (input.preferred && this.models.some((item) => `${item.providerID}/${item.id}` === input.preferred)) {
      this.selection.add(input.preferred)
    }
    this.elements.search.value = ""
    this.elements.concurrency.value = String(MULTI_RUN_DEFAULT_CONCURRENCY)
    this.modal.show(undefined, input.returnFocus)
    this.render()
    requestAnimationFrame(() => this.elements.search.focus())
  }

  close(restoreFocus = true): void {
    this.owner = undefined
    this.modal.close(restoreFocus)
  }

  validateOwner(sessionID: string | undefined, draft: string): MultiRunOwnerValidation {
    if (!this.owner || !sessionID) return "missing"
    if (this.owner.sessionID !== sessionID) return "session-changed"
    return this.owner.draft === draft ? "valid" : "draft-changed"
  }

  reconcile(models: Model[], providers: Providers, connected: boolean): void {
    const signature = this.signature(models, providers, connected)
    if (signature === this.catalogSignature) return
    this.catalogSignature = signature
    this.models = models
    this.providers = providers
    this.connected = connected
    this.render()
  }

  visibleOptions(): Model[] {
    const query = this.elements.search.value.trim().toLowerCase()
    return this.models
      .filter((item) => !query || `${item.name}\n${item.providerID}\n${item.id}`.toLowerCase().includes(query))
      .sort((left, right) =>
        left.providerID.localeCompare(right.providerID, undefined, { numeric: true }) ||
        left.name.localeCompare(right.name, undefined, { numeric: true })
      )
      .slice(0, 500)
  }

  render(): void {
    if (!this.open) return
    const catalogValues = new Set(this.models.map((item) => `${item.providerID}/${item.id}`))
    for (const value of this.selection) if (!catalogValues.has(value)) this.selection.delete(value)
    const visible = this.visibleOptions()
    const groups = new Map<string, Model[]>()
    for (const item of visible) groups.set(item.providerID, [...(groups.get(item.providerID) ?? []), item])
    this.elements.options.innerHTML = visible.length
      ? [...groups].map(([providerID, items]) => {
        const provider = this.providers?.find((candidate) => candidate.id === providerID)?.name ?? providerID
        return `<div role="group" aria-label="${this.escapeHtml(provider)}"><div class="multi-model-provider">${
          this.escapeHtml(provider)
        }</div>${
          items.map((item) => {
            const value = `${item.providerID}/${item.id}`
            const limits = item.contextLimit ? `${Math.round(item.contextLimit / 1_000)}k context` : ""
            return `<label class="multi-model-option"><input type="checkbox" data-multi-model-value="${
              this.escapeHtml(value)
            }"${this.selection.has(value) ? " checked" : ""}><span>${this.escapeHtml(item.name)}</span><small>${
              this.escapeHtml(limits)
            }</small></label>`
          }).join("")
        }</div>`
      }).join("")
      : `<p class="placeholder" role="status">No matching models.</p>`
    this.optionInputs().forEach((input, index) => {
      input.tabIndex = index === 0 ? 0 : -1
    })
    this.syncControls(visible)
  }

  syncControls(visible = this.visibleOptions()): void {
    const count = this.selection.size
    this.elements.concurrency.max = String(MULTI_RUN_MAX_CONCURRENCY)
    const requested = Math.trunc(Number(this.elements.concurrency.value)) || MULTI_RUN_DEFAULT_CONCURRENCY
    const concurrency = Math.max(1, Math.min(MULTI_RUN_MAX_CONCURRENCY, requested))
    const effective = Math.min(count, concurrency)
    this.elements.concurrency.value = String(concurrency)
    this.elements.count.textContent = `${count} selected`
    this.elements.disclosure.classList.toggle("warning", count > MULTI_RUN_DEFAULT_CONCURRENCY)
    this.elements.disclosure.textContent = count > MULTI_RUN_DEFAULT_CONCURRENCY
      ? `${count} peer runs selected. Above the default concurrency of ${MULTI_RUN_DEFAULT_CONCURRENCY}; up to ${effective} run together${
        count > effective ? ` and ${count - effective} queue` : ""
      }. This increases provider usage.`
      : count > 1
      ? `${count} peer sessions and worktrees; up to ${effective} run together. Review provider usage before starting.`
      : "Select at least two models. Every candidate is a peer and runs in an isolated worktree."
    this.elements.start.disabled = count < 2 || count > MULTI_RUN_MAX_CANDIDATES || !this.connected
    this.elements.selectVisible.disabled =
      !visible.some((item) => !this.selection.has(`${item.providerID}/${item.id}`)) || count >= MULTI_RUN_MAX_CANDIDATES
    this.elements.clear.disabled = count === 0
  }

  change(input: HTMLInputElement): void {
    const value = input.dataset.multiModelValue
    if (!value) return
    if (input.checked) {
      if (this.selection.size >= MULTI_RUN_MAX_CANDIDATES) input.checked = false
      else this.selection.add(value)
    } else this.selection.delete(value)
    for (const candidate of this.optionInputs()) candidate.tabIndex = candidate === input ? 0 : -1
    this.syncControls()
  }

  navigate(event: KeyboardEvent): boolean {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false
    const inputs = this.optionInputs()
    if (!inputs.length) return false
    const current = event.target instanceof HTMLInputElement ? inputs.indexOf(event.target) : -1
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
      ? inputs.length - 1
      : event.key === "ArrowDown"
      ? (current + 1 + inputs.length) % inputs.length
      : (current - 1 + inputs.length) % inputs.length
    event.preventDefault()
    inputs.forEach((input, index) => {
      input.tabIndex = index === next ? 0 : -1
    })
    inputs[next]?.focus()
    return true
  }

  selectAllVisible(): void {
    for (const item of this.visibleOptions()) {
      if (this.selection.size >= MULTI_RUN_MAX_CANDIDATES) break
      this.selection.add(`${item.providerID}/${item.id}`)
    }
    this.render()
  }

  clear(): void {
    this.selection.clear()
    this.render()
  }

  requestedConcurrency(): number {
    return Math.max(
      1,
      Math.min(
        MULTI_RUN_MAX_CONCURRENCY,
        this.selection.size,
        Math.trunc(Number(this.elements.concurrency.value)) || MULTI_RUN_DEFAULT_CONCURRENCY,
      ),
    )
  }

  containPointer(event: PointerEvent): boolean {
    return this.modal.containPointer(event, this.elements.search)
  }

  private optionInputs(): HTMLInputElement[] {
    return [...this.elements.options.querySelectorAll<HTMLInputElement>("input[data-multi-model-value]")]
  }

  private signature(models: Model[], providers: Providers, connected: boolean): string {
    return JSON.stringify([
      connected,
      models.map((item) => [item.providerID, item.id, item.name, item.contextLimit]),
      providers?.map((item) => [item.id, item.name]),
    ])
  }
}
