import { createHash } from "node:crypto"
import path from "node:path"
import * as vscode from "vscode"
import type { FileChange } from "@opencode-workbench/shared"
import { patchTextPair } from "./patch-text.js"
import { ChangeReviewState, type ReviewedChangeRecord } from "./change-review-state.js"

export type { ReviewedChangeRecord } from "./change-review-state.js"

const REVIEW_SCHEME = "opencode-workbench-review"
const MAX_REVIEW_DOCUMENTS = 200
const MAX_REVIEW_DOCUMENT_CHARACTERS = 20_000_000

export interface NativeChangeReviewEntry {
  file: string
  uri: vscode.Uri
  currentText: string
  patch: string
  patchAlreadyApplied: boolean
  status?: FileChange["status"]
}

function safeReviewPath(file: string, side: "before" | "proposed"): string {
  const normalized = file.replaceAll("\\", "/").replace(/^\/+/, "")
  const safe = normalized.split("/").filter((part) => part && part !== "." && part !== "..").join("/") || "change.txt"
  return `/${side}/${safe}`
}

class ReviewDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>()

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? ""
  }

  document(file: string, side: "before" | "proposed", content: string): vscode.Uri {
    const id = createHash("sha256").update(`${file}\0${side}\0${content}`).digest("hex").slice(0, 24)
    const uri = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: safeReviewPath(file, side), query: `id=${id}` })
    const key = uri.toString()
    this.content.delete(key)
    this.content.set(key, content)
    let characters = [...this.content.values()].reduce((total, value) => total + value.length, 0)
    while (this.content.size > MAX_REVIEW_DOCUMENTS || characters > MAX_REVIEW_DOCUMENT_CHARACTERS) {
      const oldest = this.content.keys().next().value
      if (!oldest) break
      characters -= this.content.get(oldest)?.length ?? 0
      this.content.delete(oldest)
    }
    return uri
  }

  clear(): void {
    this.content.clear()
  }
}

export class ChangeReviewService implements vscode.Disposable {
  private readonly documents = new ReviewDocumentProvider()
  private readonly providerRegistration: vscode.Disposable
  private readonly reviewed: ChangeReviewState

  constructor(
    records: readonly ReviewedChangeRecord[] = [],
    persist?: (records: ReviewedChangeRecord[]) => void,
  ) {
    this.reviewed = new ChangeReviewState(records, persist)
    this.providerRegistration = vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, this.documents)
  }

  decorate(sessionID: string, changes: readonly FileChange[]): FileChange[] {
    return this.reviewed.decorate(sessionID, changes)
  }

  markReviewed(sessionID: string, changes: readonly FileChange[]): void {
    this.reviewed.markReviewed(sessionID, changes)
  }

  invalidate(sessionID: string, file: string): boolean {
    return this.reviewed.invalidate(sessionID, file)
  }

  async openFile(entry: NativeChangeReviewEntry): Promise<void> {
    const pair = patchTextPair(entry.currentText, entry.patch, entry.patchAlreadyApplied)
    const original = this.documents.document(entry.file, "before", pair.original)
    const modified = entry.patchAlreadyApplied && entry.status !== "deleted"
      ? entry.uri
      : this.documents.document(entry.file, "proposed", pair.modified)
    await vscode.commands.executeCommand(
      "vscode.diff",
      original,
      modified,
      `${path.basename(entry.file)} — OpenCode change`,
      { preview: true },
    )
  }

  async openSession(title: string, entries: readonly NativeChangeReviewEntry[]): Promise<string[]> {
    const resources: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = []
    const stale: string[] = []
    for (const entry of entries) {
      try {
        const pair = patchTextPair(entry.currentText, entry.patch, entry.patchAlreadyApplied)
        const original = this.documents.document(entry.file, "before", pair.original)
        const modified = entry.patchAlreadyApplied && entry.status !== "deleted"
          ? entry.uri
          : this.documents.document(entry.file, "proposed", pair.modified)
        resources.push([entry.uri, original, modified])
      } catch {
        stale.push(entry.file)
      }
    }
    if (!resources.length) return stale
    await vscode.commands.executeCommand("vscode.changes", title, resources)
    return stale
  }

  async openTimeline(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document, { preview: true })
    await vscode.commands.executeCommand("timeline.focus")
  }

  dispose(): void {
    this.providerRegistration.dispose()
    this.documents.clear()
  }
}
