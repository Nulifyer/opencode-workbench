import { ModalController } from "./modal-controller.js"

/** @deprecated Prefer ModalController for new modal and overlay surfaces. */
export class OverlayController {
  private readonly controller: ModalController
  constructor(root: HTMLElement, toggle?: HTMLElement) {
    this.controller = new ModalController(root, toggle)
  }
  open(focus?: HTMLElement): void {
    this.controller.show(focus)
  }
  close(restore = true): void {
    this.controller.close(restore)
  }
}
