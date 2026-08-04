import { configureNativeLsp } from "../src/config.ts"
import * as PluginModule from "../src/index.ts"

Deno.test("plugin entry exports only plugin factories", () => {
  const exports = Object.keys(PluginModule)
  if (exports.join(",") !== "default") throw new Error(`Plugin entry exposed non-plugin exports: ${exports.join(", ")}`)
  if (typeof PluginModule.default !== "object" || PluginModule.default.id !== "opencode-workbench" || typeof PluginModule.default.server !== "function") {
    throw new Error("Plugin entry does not use the isolated OpenCode server-module contract")
  }
})

Deno.test("native LSP defaults on without overriding explicit configuration", () => {
  const omitted: { lsp?: unknown } = {}
  configureNativeLsp(omitted)
  if (!omitted.lsp || typeof omitted.lsp !== "object") throw new Error("Omitted native LSP configuration was not enabled")

  const disabled: { lsp?: unknown } = { lsp: false }
  configureNativeLsp(disabled)
  if (disabled.lsp !== false) throw new Error("Explicit native LSP disable was overridden")

  const custom = { lsp: { deno: { disabled: true } } }
  const configured = custom.lsp
  configureNativeLsp(custom)
  if (custom.lsp !== configured) throw new Error("Custom native LSP configuration was replaced")
})
