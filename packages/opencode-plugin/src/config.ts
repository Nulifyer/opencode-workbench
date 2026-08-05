export function configureNativeLsp(config: { lsp?: unknown }): void {
  if (config.lsp === undefined) config.lsp = {}
}

export function configureGoalCommand(config: { command?: Record<string, unknown> }, template: string, unlimitedTemplate: string): void {
  config.command ??= {}
  if (config.command.goal === undefined) {
    config.command.goal = {
      description: "Set or view the long-running session goal",
      template,
    }
  }
  if (config.command["goal-unlimited"] === undefined) {
    config.command["goal-unlimited"] = {
      description: "Create a goal without token, duration, or turn limits",
      template: unlimitedTemplate,
    }
  }
}
