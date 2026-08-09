export interface InspectorState { inspectorOpen?: boolean; inspectorTab?: string }

export class InspectorShellController {
  open: boolean
  tab: string
  constructor(state?: InspectorState) { this.open = state?.inspectorOpen ?? false; this.tab = state?.inspectorTab ?? "activity" }
  toggle(): void { this.open = !this.open }
  close(): void { this.open = false }
  select(tab: string): void { this.tab = tab }
  persisted(): Required<InspectorState> { return { inspectorOpen: this.open, inspectorTab: this.tab } }
}
