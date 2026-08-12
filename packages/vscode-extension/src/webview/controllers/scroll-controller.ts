export interface ScrollAnchor {
  node: HTMLElement
  viewportTop: number
  scrollTop: number
  scrollHeight: number
  messageID?: string
}
export interface ScrollViewport {
  atBottom: boolean
  scrollTop: number
}

export class ScrollController {
  private followingLatest = true

  constructor(private readonly container: HTMLElement, private readonly threshold = 80) {}
  nearBottom(): boolean {
    return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < this.threshold
  }
  observeScroll(): boolean {
    this.followingLatest = this.nearBottom()
    return this.followingLatest
  }
  capturePrependAnchor(preferred?: HTMLElement): ScrollAnchor | undefined {
    const node = preferred ?? this.container.firstElementChild
    return node instanceof HTMLElement
      ? {
        node,
        viewportTop: node.getBoundingClientRect().top,
        scrollTop: this.container.scrollTop,
        scrollHeight: this.container.scrollHeight,
        messageID: node.dataset.messageId,
      }
      : undefined
  }
  restorePrependAnchor(anchor?: ScrollAnchor): void {
    if (!anchor) return
    const node = anchor.node.isConnected
      ? anchor.node
      : anchor.messageID
      ? Array.from(this.container.querySelectorAll<HTMLElement>("[data-message-id]")).find((candidate) =>
        candidate.dataset.messageId === anchor.messageID
      )
      : undefined
    if (node) this.container.scrollTop += node.getBoundingClientRect().top - anchor.viewportTop
    else this.container.scrollTop = Math.max(0, anchor.scrollTop + this.container.scrollHeight - anchor.scrollHeight)
  }
  captureViewport(): ScrollViewport {
    return { atBottom: this.nearBottom(), scrollTop: this.container.scrollTop }
  }
  restoreViewport(viewport: ScrollViewport): void {
    this.followingLatest = viewport.atBottom
    this.container.scrollTop = viewport.atBottom ? this.container.scrollHeight : Math.max(0, viewport.scrollTop)
  }
  latest(): void {
    this.followingLatest = true
    this.container.scrollTop = this.container.scrollHeight
  }
  maintainLatest(): boolean {
    if (!this.followingLatest) return false
    this.container.scrollTop = this.container.scrollHeight
    return true
  }
  setFollowingLatest(value: boolean): void {
    this.followingLatest = value
  }
}
