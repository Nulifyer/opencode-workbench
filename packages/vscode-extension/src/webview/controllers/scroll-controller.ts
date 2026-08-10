export interface ScrollAnchor { node: HTMLElement; offsetTop: number }
export interface ScrollViewport { atBottom: boolean; scrollTop: number }

export class ScrollController {
  constructor(private readonly container: HTMLElement, private readonly threshold = 80) {}
  nearBottom(): boolean { return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < this.threshold }
  capturePrependAnchor(): ScrollAnchor | undefined { const node = this.container.firstElementChild; return node instanceof HTMLElement ? { node, offsetTop: node.offsetTop } : undefined }
  restorePrependAnchor(anchor?: ScrollAnchor): void { if (anchor?.node.isConnected) this.container.scrollTop += anchor.node.offsetTop - anchor.offsetTop }
  captureViewport(): ScrollViewport { return { atBottom: this.nearBottom(), scrollTop: this.container.scrollTop } }
  restoreViewport(viewport: ScrollViewport): void { this.container.scrollTop = viewport.atBottom ? this.container.scrollHeight : Math.max(0, viewport.scrollTop) }
  latest(): void { this.container.scrollTop = this.container.scrollHeight }
}
