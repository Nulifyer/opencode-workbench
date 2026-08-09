import type { AgentOption, ChatSnapshot, CommandOption, ModelOption, ProviderOption, ResourceOption } from "@opencode-workbench/shared"

export interface CatalogPreferences {
  currentAgent?: string
  lastModel?: string
  agentModels?: Array<[string, string]>
  modelVariants?: Array<[string, string | null]>
}

export interface RuntimeCatalog {
  agents: AgentOption[]
  mentionAgents?: AgentOption[]
  providers?: ProviderOption[]
  models: ModelOption[]
  resources?: ResourceOption[]
  defaults?: { agent?: string; model?: string; variant?: string }
}

export class CatalogService {
  agents: AgentOption[] = []
  mentionAgents: AgentOption[] = []
  providers: ProviderOption[] = []
  models: ModelOption[] = []
  resources: ResourceOption[] = []
  commands: CommandOption[] = []
  defaultAgent?: string
  defaultModel?: string
  defaultVariant?: string
  currentAgent?: string
  lastModel?: string
  readonly modelVariants = new Map<string, string | undefined>()
  status: NonNullable<ChatSnapshot["catalog"]> = { status: "error" }

  constructor(preferences?: CatalogPreferences) {
    if (typeof preferences?.currentAgent === "string" && preferences.currentAgent.length <= 1_024) this.currentAgent = preferences.currentAgent
    if (typeof preferences?.lastModel === "string" && preferences.lastModel.length <= 1_024) this.lastModel = preferences.lastModel
    if (!this.lastModel) {
      const legacy = preferences?.agentModels?.find(([agent]) => agent === this.currentAgent) ?? preferences?.agentModels?.at(-1)
      if (legacy && legacy.every((value) => typeof value === "string" && value.length <= 1_024)) this.lastModel = legacy[1]
    }
    for (const entry of preferences?.modelVariants?.slice(0, 500) ?? []) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0].length > 1_024 || (entry[1] !== null && (typeof entry[1] !== "string" || entry[1].length > 1_024))) continue
      this.modelVariants.set(entry[0], entry[1] ?? undefined)
    }
  }

  validAgent(name?: string): name is string { return Boolean(name && this.agents.some((agent) => agent.name === name)) }
  validModel(value?: string): value is string { return Boolean(value && this.models.some((model) => `${model.providerID}/${model.id}` === value)) }

  modelForAgent(agent?: string): string | undefined {
    const configured = this.agents.find((candidate) => candidate.name === agent)?.model
    const value = configured ? `${configured.providerID}/${configured.modelID}` : undefined
    if (this.validModel(value)) return value
    return this.validModel(this.lastModel) ? this.lastModel : this.defaultModel
  }

  preferences(): CatalogPreferences { return { currentAgent: this.currentAgent, lastModel: this.lastModel, modelVariants: [...this.modelVariants].map(([key, value]) => [key, value ?? null]) } }

  remember(agent?: string, model?: string, variant?: string, rememberVariant = false): boolean {
    let changed = false
    if (this.validAgent(agent) && this.currentAgent !== agent) { this.currentAgent = agent; changed = true }
    if (!this.validModel(model)) return changed
    if (this.lastModel !== model) { this.lastModel = model; changed = true }
    if ((rememberVariant || variant !== undefined) && (!this.modelVariants.has(model) || this.modelVariants.get(model) !== (variant || undefined))) { this.modelVariants.set(model, variant || undefined); changed = true }
    return changed
  }

  validate(agent?: string, model?: string, variant?: string, sessionAgent?: string): void {
    if (agent && !this.validAgent(agent)) throw new Error("Unknown OpenCode agent")
    if (model && !this.validModel(model)) throw new Error("Unknown OpenCode model")
    if (!variant) return
    const effectiveAgent = agent || sessionAgent || this.currentAgent || this.defaultAgent
    const effectiveModel = model === "" ? this.modelForAgent(effectiveAgent) : model || this.modelForAgent(effectiveAgent)
    const selected = this.models.find((candidate) => `${candidate.providerID}/${candidate.id}` === effectiveModel)
    if (!selected?.variants?.includes(variant)) throw new Error("Unknown reasoning level for the selected model")
  }

  apply(catalog: RuntimeCatalog, commands: CommandOption[], error?: string): void {
    this.agents = catalog.agents; this.mentionAgents = catalog.mentionAgents ?? []; this.providers = catalog.providers ?? []; this.models = catalog.models; this.resources = catalog.resources ?? []
    this.status = error ? { status: this.models.length ? "stale" : "error", updatedAt: this.status.updatedAt, error: error.slice(0, 20_000) } : { status: "ready", updatedAt: Date.now() }
    this.defaultAgent = catalog.defaults?.agent; this.defaultModel = catalog.defaults?.model; this.defaultVariant = catalog.defaults?.variant
    if (!this.validAgent(this.currentAgent)) this.currentAgent = this.defaultAgent
    if (this.lastModel && !this.validModel(this.lastModel)) this.lastModel = undefined
    for (const [model, variant] of this.modelVariants) {
      const option = this.models.find((candidate) => `${candidate.providerID}/${candidate.id}` === model)
      if (!option || (variant && !option.variants?.includes(variant))) this.modelVariants.delete(model)
    }
    this.commands = commands
  }
}
