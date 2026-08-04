export function configureNativeLsp(config: { lsp?: unknown }): void {
  if (config.lsp === undefined) config.lsp = {}
}
