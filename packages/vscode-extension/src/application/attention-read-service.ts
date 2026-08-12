import { createHash } from "node:crypto"
import type { AttentionItem } from "@opencode-workbench/shared"

export interface AttentionReadRecord {
  id: string
  fingerprint: string
  readAt: number
}

export const ATTENTION_READ_CAPACITY = 500

const FINGERPRINT = /^[a-f0-9]{64}$/

function sanitizedRecord(value: unknown): AttentionReadRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== "string" || !record.id || record.id.length > 2_048 ||
    /[\r\n]/.test(record.id)
  ) return undefined
  if (
    typeof record.fingerprint !== "string" ||
    !FINGERPRINT.test(record.fingerprint)
  ) return undefined
  if (!Number.isSafeInteger(record.readAt) || Number(record.readAt) < 0) {
    return undefined
  }
  return {
    id: record.id,
    fingerprint: record.fingerprint,
    readAt: Number(record.readAt),
  }
}

function newestFirst(
  left: AttentionReadRecord,
  right: AttentionReadRecord,
): number {
  return right.readAt - left.readAt || left.id.localeCompare(right.id)
}

/**
 * Identifies the user-visible revision of an attention item. Goal timestamps are
 * intentionally omitted: OpenCode updates the session timestamp while an
 * unchanged blocked goal remains active.
 */
export function attentionFingerprint(item: AttentionItem): string {
  const revision = [
    item.id,
    item.kind,
    item.sessionID,
    item.title,
    item.detail,
    item.target.surface,
    item.target.itemID,
    item.kind === "blocked-goal" ? undefined : item.createdAt,
  ]
  return createHash("sha256").update(JSON.stringify(revision)).digest("hex")
}

/** Keeps bounded, workspace-local acknowledgement state without mutating goals. */
export class AttentionReadService {
  private readonly records = new Map<string, AttentionReadRecord>()

  constructor(
    initial: readonly unknown[] = [],
    private readonly persist?: (records: AttentionReadRecord[]) => void,
  ) {
    const newest = new Map<string, AttentionReadRecord>()
    for (const candidate of initial) {
      const record = sanitizedRecord(candidate)
      if (!record) continue
      const previous = newest.get(record.id)
      if (!previous || record.readAt > previous.readAt) {
        newest.set(record.id, record)
      }
    }
    for (
      const record of [...newest.values()].sort(newestFirst).slice(
        0,
        ATTENTION_READ_CAPACITY,
      )
    ) {
      this.records.set(record.id, { ...record })
    }
  }

  unread(items: readonly AttentionItem[]): AttentionItem[] {
    return items.filter((item) => this.records.get(item.id)?.fingerprint !== attentionFingerprint(item))
  }

  markRead(items: readonly AttentionItem[], readAt = Date.now()): void {
    if (!Number.isSafeInteger(readAt) || readAt < 0) {
      throw new Error("Invalid attention acknowledgement timestamp")
    }
    if (!items.length) return
    for (const item of items) {
      this.records.set(item.id, {
        id: item.id,
        fingerprint: attentionFingerprint(item),
        readAt,
      })
    }
    for (const record of this.list().slice(ATTENTION_READ_CAPACITY)) {
      this.records.delete(record.id)
    }
    this.persist?.(this.list())
  }

  list(): AttentionReadRecord[] {
    return [...this.records.values()].sort(newestFirst).map((record) => ({
      ...record,
    }))
  }
}
