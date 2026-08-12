export class SettlementCoordinator {
  readonly pendingPromptSessions = new Map<string, string>()
  readonly pendingPromptTexts = new Map<string, string>()
  readonly pendingPromptFileCounts = new Map<string, number>()
  readonly sessionFailures = new Map<string, string>()
  promptAdmissionPaused = false

  pendingText(messageID: string, queued?: (sessionID: string) => string | undefined): string | undefined {
    const retained = this.pendingPromptTexts.get(messageID)
    if (retained !== undefined) return retained
    const sessionID = this.pendingPromptSessions.get(messageID)
    return sessionID ? queued?.(sessionID) : undefined
  }

  dispose(): void {
    this.pendingPromptSessions.clear()
    this.pendingPromptTexts.clear()
    this.pendingPromptFileCounts.clear()
    this.sessionFailures.clear()
  }
}
