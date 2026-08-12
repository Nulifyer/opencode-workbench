/// <reference lib="dom" />

export class ModalController {
  private returnFocus?: HTMLElement

  constructor(private readonly root: HTMLElement, private readonly toggle?: HTMLElement) {}

  get open(): boolean {
    return !this.root.hidden
  }

  show(focus?: HTMLElement, returnFocus?: HTMLElement): void {
    this.returnFocus = returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : this.toggle)
    this.root.hidden = false
    this.toggle?.setAttribute("aria-expanded", "true")
    focus?.focus()
  }

  close(restore = true): void {
    this.root.hidden = true
    this.toggle?.setAttribute("aria-expanded", "false")
    const target = this.returnFocus ?? this.toggle
    this.returnFocus = undefined
    if (restore && target?.isConnected && this.isVisible(target)) target.focus()
    else if (restore) this.toggle?.focus()
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.root.contains(target)
  }

  containPointer(event: PointerEvent, fallback?: HTMLElement): boolean {
    if (!this.open || this.contains(event.target)) return false
    event.preventDefault()
    event.stopImmediatePropagation()
    ;(fallback ??
      this.root.querySelector<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ))?.focus()
    return true
  }

  private isVisible(target: HTMLElement): boolean {
    return target.getClientRects().length > 0 && !target.closest("[hidden]")
  }
}
