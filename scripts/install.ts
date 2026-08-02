import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const manifest = JSON.parse(await Deno.readTextFile(join(root, "package.json"))) as { version: string }
const extensionManifest = JSON.parse(await Deno.readTextFile(join(root, "packages", "vscode-extension", "package.json"))) as {
  name: string
  publisher: string
}
const extensionID = `${extensionManifest.publisher}.${extensionManifest.name}`
const legacyExtensionID = "opencode-workbench.opencode-workbench-vscode"
const vsix = join(root, "dist", `opencode-workbench-vscode-${manifest.version}.vsix`)

async function code(args: string[], stderr: "inherit" | "null" = "inherit"): Promise<Deno.CommandOutput> {
  return await new Deno.Command("code", { args, stdout: "inherit", stderr }).output()
}

const installed = await code(["--install-extension", vsix, "--force"])
if (!installed.success) Deno.exit(installed.code || 1)

const listed = await new Deno.Command("code", { args: ["--list-extensions"], stdout: "piped", stderr: "null" }).output()
if (!listed.success || !new TextDecoder().decode(listed.stdout).split(/\r?\n/).includes(extensionID)) {
  throw new Error(`VS Code did not report installed extension ${extensionID}`)
}
if (legacyExtensionID !== extensionID) await code(["--uninstall-extension", legacyExtensionID], "null")

console.log(`Installed OpenCode Workbench ${manifest.version}`)
