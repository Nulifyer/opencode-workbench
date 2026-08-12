import type { TranscriptHistoryPage } from "@opencode-workbench/shared"
import type { ScrollAnchor } from "./scroll-controller.js"

export type HistoryLoadMode = "page" | "all"

export class HistoryController {
  sessionID?: string
  mode?: HistoryLoadMode
  cancelled = false
  loaded = 0
  target?: number
  pagesSinceRender = 0
  anchor?: ScrollAnchor
  private readonly expanded = new Map<string, TranscriptHistoryPage>()

  get loading(): boolean {
    return this.sessionID !== undefined
  }

  begin(sessionID: string, mode: HistoryLoadMode, anchor: ScrollAnchor | undefined, target?: number): void {
    this.sessionID = sessionID
    this.mode = mode
    this.anchor = anchor
    this.target = target
    this.cancelled = false
    this.loaded = 0
    this.pagesSinceRender = 0
  }

  reset(): void {
    this.sessionID = undefined
    this.mode = undefined
    this.cancelled = false
    this.loaded = 0
    this.target = undefined
    this.pagesSinceRender = 0
    this.anchor = undefined
  }

  cancel(): void {
    this.cancelled = true
  }

  recordPage(messageCount: number): void {
    this.loaded += Math.max(0, messageCount)
    this.pagesSinceRender += 1
  }

  expandedPage(sessionID: string): TranscriptHistoryPage | undefined {
    return this.expanded.get(sessionID)
  }
  setExpandedPage(sessionID: string, page: TranscriptHistoryPage): void {
    this.expanded.set(sessionID, page)
  }
  deleteSession(sessionID: string): void {
    this.expanded.delete(sessionID)
    if (this.sessionID === sessionID) this.reset()
  }
}
