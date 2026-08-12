/// <reference lib="dom" />

export class FocusController {
  trapTab(
    event: KeyboardEvent,
    root: HTMLElement,
    selector = "button:not([disabled]):not(.overlay-backdrop), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
  ): boolean {
    if (event.key !== "Tab" || root.hidden) return false
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(selector))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return false
    const active = document.activeElement
    if (!root.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
      return true
    }
    return false
  }
}
