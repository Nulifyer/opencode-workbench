import type { MessageBundle, WorkbenchState } from "@opencode-workbench/shared"

export function mergeTranscripts(server: WorkbenchState["sessions"][string]["messages"], current: WorkbenchState["sessions"][string]["messages"]): MessageBundle[] {
  const merged = server.map((message) => ({ ...message, parts: message.parts.slice() }))
  for (const live of current) {
    const index = merged.findIndex((message) => message.info.id === live.info.id)
    if (index < 0) { merged.push(live); continue }
    const base = merged[index]!
    const parts = base.parts.slice()
    for (const part of live.parts) {
      const partIndex = parts.findIndex((candidate) => candidate.id === part.id)
      if (partIndex < 0) parts.push(part)
      else parts[partIndex] = part
    }
    merged[index] = { info: { ...base.info, ...live.info }, parts }
  }
  return merged
}

export class TranscriptReconciler {
  readonly revisions = new Map<string, number>()
  readonly generations = new Map<string, number>()
  readonly refreshTimers = new Map<string, NodeJS.Timeout>()
  readonly removedMessages = new Map<string, Map<string, number>>()
  readonly removedParts = new Map<string, Map<string, number>>()
  readonly messageHistories = new Map<string, { legacyMessageIDs: Set<string>; v2MessageIDs: Set<string> }>()
  readonly messageRevisions = new Map<string, Map<string, number>>()

  dispose(): void { for (const timer of this.refreshTimers.values()) clearTimeout(timer); this.refreshTimers.clear(); this.revisions.clear(); this.generations.clear(); this.removedMessages.clear(); this.removedParts.clear(); this.messageHistories.clear(); this.messageRevisions.clear() }
}
