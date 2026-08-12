/// <reference lib="dom" />

import type { ChatSnapshot } from "@opencode-workbench/shared"

type SessionSnapshot = NonNullable<ChatSnapshot["session"]>

export interface WorkspaceDurationValues {
  session: number
  goal: number
  outside: number
}

export class MetricsController {
  constructor(private readonly root: HTMLElement) {}

  liveDuration(seconds: number | undefined, sampledAt: number | undefined, running: boolean): number {
    if (seconds === undefined) return 0
    return running && sampledAt !== undefined
      ? seconds + Math.max(0, Math.floor(Date.now() / 1_000) - sampledAt)
      : seconds
  }

  durationValues(session: SessionSnapshot): WorkspaceDurationValues {
    const history = session.goalHistory ?? session.goal?.archivedGoals ?? []
    const sessionSeconds = this.liveDuration(
      session.metrics?.timeUsedSeconds,
      session.metrics?.sampledAt,
      session.archived !== true,
    )
    const goalSeconds = this.liveDuration(
      session.goal?.timeUsedSeconds,
      session.goal?.sampledAt,
      session.goal?.status === "active",
    )
    const accountedSeconds = history.reduce((total, entry) => total + entry.timeUsedSeconds, 0) + goalSeconds
    return { session: sessionSeconds, goal: goalSeconds, outside: Math.max(0, sessionSeconds - accountedSeconds) }
  }

  sync(session: SessionSnapshot, format: (seconds: number, detailed?: boolean) => string): WorkspaceDurationValues {
    const durations = this.durationValues(session)
    for (const target of this.root.querySelectorAll<HTMLElement>("[data-workspace-duration]")) {
      const key = target.dataset.workspaceDuration as keyof WorkspaceDurationValues
      if (!(key in durations)) continue
      target.textContent = format(durations[key], target.dataset.durationDetailed === "true")
    }
    return durations
  }
}
