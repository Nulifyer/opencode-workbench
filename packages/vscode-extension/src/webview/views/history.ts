import type { ChatSnapshot, TranscriptHistoryPage, TranscriptHistoryState } from "@opencode-workbench/shared"

type SessionSnapshot = NonNullable<ChatSnapshot["session"]>

export interface HistoryPresentation {
  visible: boolean
  text: string
  actionLabel?: string
}

export function historyLoadAllLabel(history?: TranscriptHistoryState): string {
  const remaining = history ? Math.max(0, history.totalMessages - history.visibleMessages) : 0
  return remaining > 0 && !history?.sourceMayBeTruncated
    ? `Load all ${remaining.toLocaleString()} remaining`
    : "Load all older messages"
}

export function historyLoadAllProgress(loaded: number, target?: number): string {
  const safeLoaded = Math.max(0, Math.floor(loaded))
  return target === undefined
    ? `Loading all… ${safeLoaded.toLocaleString()} loaded`
    : `Loading all… ${Math.min(safeLoaded, Math.max(0, Math.floor(target))).toLocaleString()} / ${Math.max(0, Math.floor(target)).toLocaleString()}`
}

export function mergeHistoryPage(session: SessionSnapshot, page: TranscriptHistoryPage): SessionSnapshot {
  if (page.sessionID !== session.id) return session
  const current = new Map(session.messages.map((message) => [message.info.id, message]))
  const merged = page.messages.map((message) => current.get(message.info.id) ?? message)
  const seen = new Set(merged.map((message) => message.info.id))
  for (const message of session.messages) if (!seen.has(message.info.id)) {
    seen.add(message.info.id)
    merged.push(message)
  }
  return {
    ...session,
    messages: merged,
    messageRevisions: { ...page.messageRevisions, ...session.messageRevisions },
    history: {
      totalMessages: page.totalMessages,
      visibleMessages: merged.length,
      hasOlder: page.hasOlder,
      limitedBy: session.history?.limitedBy,
      sourceMayBeTruncated: page.sourceMayBeTruncated,
    },
  }
}

export function historyPresentation(history?: TranscriptHistoryState): HistoryPresentation {
  if (!history || (!history.hasOlder && !history.sourceMayBeTruncated)) return { visible: false, text: "" }
  const reason = history.limitedBy === "characters"
    ? "the transcript character limit"
    : history.limitedBy === "parts"
    ? "the transcript part limit"
    : "the transcript message limit"
  const count = history.sourceMayBeTruncated
    ? `Showing ${history.visibleMessages.toLocaleString()} messages currently loaded from OpenCode.`
    : `Showing ${history.visibleMessages.toLocaleString()} of ${history.totalMessages.toLocaleString()} messages currently loaded from OpenCode.`
  const ceiling = history.sourceMayBeTruncated
    ? history.hasOlder ? " Older server history is available on demand." : " This reload is safety-bounded; older server history may exist."
    : ""
  if (!history.hasOlder) return { visible: true, text: `${count}${ceiling}` }
  return {
    visible: true,
    text: `${count} Older messages are omitted by ${reason}.${ceiling}`,
    actionLabel: "Load older messages",
  }
}
