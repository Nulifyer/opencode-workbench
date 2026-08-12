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
  Deno.remove(join(extension, "dist", "extension.cjs.map")).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }),
  Deno.remove(join(extension, "media", "chat.js.map")).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }),
])

await Promise.all([
  build({
    absWorkingDir: extension,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    mainFields: ["module", "main"],
    external: ["vscode"],
    alias: { "@opencode-workbench/shared": shared },
    sourcemap: false,
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
    sourcemap: false,
  }),
  build({
    absWorkingDir: plugin,
    entryPoints: ["src/index.ts"],
    outfile: join(dist, "opencode-plugin.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
  }),
])

const extensionBundlePath = join(extension, "dist", "extension.cjs")
const smoke = await new Deno.Command(Deno.execPath(), {
  args: [
    "eval",
    `import { createRequire, Module } from "node:module";
const load = Module._load;
const vscode = new Proxy(function() {}, {
  get: () => vscode,
  apply: () => vscode,
  construct: () => ({}),
});
Module._load = function(request, parent, isMain) {
  if (request === "vscode") return vscode;
  return load.call(this, request, parent, isMain);
};
createRequire(import.meta.url)(${JSON.stringify(extensionBundlePath)});`,
  ],
  stdout: "null",
  stderr: "piped",
}).output()
if (!smoke.success) {
  throw new Error(
    `Extension bundle failed module-load smoke test:\n${new TextDecoder().decode(smoke.stderr).slice(-4_000)}`,
  )
}

await Deno.copyFile(join(dist, "opencode-plugin.js"), join(extension, "dist", "opencode-plugin.js"))
