import type { ChatSnapshot } from "@opencode-workbench/shared"

export class WorkbenchWebviewStore {
  private value: ChatSnapshot = {
    connected: false,
    connectionState: "connecting",
    sessions: [],
    agents: [],
    models: [],
  }
  private revision = 0
  get snapshot(): ChatSnapshot {
    return this.value
  }
  get snapshotRevision(): number {
    return this.revision
  }
  replace(next: ChatSnapshot): ChatSnapshot {
    this.value = next
    this.revision += 1
    return this.value
  }
}
