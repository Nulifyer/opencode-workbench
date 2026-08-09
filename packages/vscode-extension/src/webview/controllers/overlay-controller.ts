export class OverlayController {
  private returnFocus?: HTMLElement
  constructor(private readonly root: HTMLElement, private readonly toggle?: HTMLElement) {}
  open(focus?: HTMLElement): void { this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : this.toggle; this.root.hidden = false; this.toggle?.setAttribute("aria-expanded", "true"); focus?.focus() }
  close(restore = true): void { this.root.hidden = true; this.toggle?.setAttribute("aria-expanded", "false"); if (restore) (this.returnFocus ?? this.toggle)?.focus(); this.returnFocus = undefined }
}
