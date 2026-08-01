import { build } from "esbuild"
import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const extension = join(root, "packages", "vscode-extension")
const shared = join(root, "packages", "shared", "src", "index.ts")
const plugin = join(root, "packages", "opencode-plugin")
const dist = join(root, "dist")

await Deno.remove(dist, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error
})
await Deno.mkdir(dist, { recursive: true })
await Deno.mkdir(join(extension, "dist"), { recursive: true })

await Promise.all([
  build({
    absWorkingDir: extension,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    alias: { "@opencode-workbench/shared": shared },
    sourcemap: true,
  }),
  build({
    absWorkingDir: extension,
    entryPoints: ["src/webview/main.ts"],
    outfile: "media/chat.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    alias: { "@opencode-workbench/shared": shared },
    sourcemap: true,
  }),
  build({
    absWorkingDir: plugin,
    entryPoints: ["src/index.ts"],
    outfile: join(dist, "opencode-plugin.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: true,
  }),
])
