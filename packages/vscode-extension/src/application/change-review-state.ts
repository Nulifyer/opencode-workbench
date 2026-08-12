import { createHash } from "node:crypto"
import type { FileChange } from "@opencode-workbench/shared"

const MAX_REVIEWED_CHANGES = 1_000
const MAX_REVIEWED_RECORD_CHARACTERS = 500_000

export interface ReviewedChangeRecord {
  sessionID: string
  file: string
  signature: string
  reviewedAt: number
}

function signature(change: FileChange): string {
  return createHash("sha256")
    .update(
      `${change.file}\0${change.status ?? "modified"}\0${change.additions}\0${change.deletions}\0${change.patch ?? ""}`,
    )
    .digest("hex")
}

function recordKey(sessionID: string, file: string): string {
  return `${sessionID}\0${file.replaceAll("\\", "/")}`
}

export class ChangeReviewState {
  private readonly reviewed = new Map<string, ReviewedChangeRecord>()

  constructor(
    records: readonly ReviewedChangeRecord[] = [],
    private readonly persist?: (records: ReviewedChangeRecord[]) => void,
  ) {
    for (const record of records.slice(-MAX_REVIEWED_CHANGES)) {
      if (
        record.sessionID && record.file && record.file.length <= 8_192 && /^[a-f0-9]{64}$/.test(record.signature) &&
        Number.isSafeInteger(record.reviewedAt) && record.reviewedAt >= 0
      ) {
        this.reviewed.set(recordKey(record.sessionID, record.file), { ...record })
      }
    }
    this.prune()
  }

  decorate(sessionID: string, changes: readonly FileChange[]): FileChange[] {
    return changes.map((change) => ({
      ...change,
      reviewed: this.reviewed.get(recordKey(sessionID, change.file))?.signature === signature(change) || undefined,
    }))
  }

  markReviewed(sessionID: string, changes: readonly FileChange[]): void {
    const reviewedAt = Date.now()
    for (const change of changes) {
      this.reviewed.set(recordKey(sessionID, change.file), {
        sessionID,
        file: change.file,
        signature: signature(change),
        reviewedAt,
      })
    }
    this.prune()
    this.persist?.([...this.reviewed.values()])
  }

  invalidate(sessionID: string, file: string): boolean {
    const changed = this.reviewed.delete(recordKey(sessionID, file))
    if (changed) this.persist?.([...this.reviewed.values()])
    return changed
  }

  private prune(): void {
    let characters = [...this.reviewed.values()].reduce(
      (total, record) => total + record.sessionID.length + record.file.length + record.signature.length,
      0,
    )
    while (this.reviewed.size > MAX_REVIEWED_CHANGES || characters > MAX_REVIEWED_RECORD_CHARACTERS) {
      const oldest = this.reviewed.keys().next().value
      if (!oldest) break
      const record = this.reviewed.get(oldest)
      characters -= record ? record.sessionID.length + record.file.length + record.signature.length : 0
      this.reviewed.delete(oldest)
    }
  }
}
