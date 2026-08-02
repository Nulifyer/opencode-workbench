import { build } from "esbuild"

await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    mainFields: ["module", "main"],
    external: ["vscode"],
    sourcemap: false,
  }),
  build({
    entryPoints: ["src/webview/main.ts"],
    outfile: "media/chat.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    sourcemap: false,
  }),
])
