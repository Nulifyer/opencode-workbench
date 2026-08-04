import type { SessionController } from "../session-controller.js"

export interface SessionTreeEntry {
  id: string
  title: string
  status: string
  unread: number
}

export function sessionTreeEntries(controller: SessionController): SessionTreeEntry[] {
  const state = controller.snapshot
  return controller.visibleSessionIDs().flatMap((id) => {
    const session = state.sessions[id]
    return session ? [{ id, title: session.info.title || "Untitled session", status: session.status.type, unread: session.unread }] : []
  })
}
