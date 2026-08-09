import type { PromptFilePart } from "../opencode-client.js"

export class PromptDispatcher {
  readonly sendGenerations = new Map<string, number>()
  readonly drainingQueues = new Set<string>()
  readonly sendingPrompts = new Map<string, string>()
  readonly retryingSessions = new Set<string>()
  readonly steeringPrompts = new Set<string>()
  readonly promptFiles = new Map<string, PromptFilePart[]>()
  readonly promptAgents = new Map<string, string[]>()

  dispose(): void {
    this.sendGenerations.clear(); this.drainingQueues.clear(); this.sendingPrompts.clear(); this.retryingSessions.clear(); this.steeringPrompts.clear(); this.promptFiles.clear(); this.promptAgents.clear()
  }
}
