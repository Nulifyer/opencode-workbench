import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"
import { localDevelopmentVersion } from "./local-version.ts"

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const manifest = JSON.parse(await Deno.readTextFile(join(root, "package.json"))) as { version: string }
const extensionManifest = JSON.parse(await Deno.readTextFile(join(root, "packages", "vscode-extension", "package.json"))) as {
  name: string
  publisher: string
}
const extensionID = `${extensionManifest.publisher}.${extensionManifest.name}`
const legacyExtensionID = "opencode-workbench.opencode-workbench-vscode"
const version = localDevelopmentVersion(manifest.version)
const vsix = join(root, "dist", `opencode-workbench-vscode-${version}.vsix`)

async function code(
  args: string[],
  stderr: "inherit" | "null" = "inherit",
  stdout: "inherit" | "piped" = "inherit",
): Promise<Deno.CommandOutput> {
  if (Deno.build.os !== "windows") return await new Deno.Command("code", { args, stdout, stderr }).output()
  const env = Object.fromEntries(args.map((value, index) => [`OPENCODE_WORKBENCH_CODE_ARG_${index}`, value]))
  const commandLine = [`"code.cmd"`, ...args.map((_, index) => `"%OPENCODE_WORKBENCH_CODE_ARG_${index}%"`)].join(" ")
  return await new Deno.Command(Deno.env.get("ComSpec") || "cmd.exe", {
    args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
    env,
    stdout,
    stderr,
  }).output()
}

const packaged = await new Deno.Command(Deno.execPath(), {
  cwd: root,
  args: ["run", "-A", join(root, "scripts", "package.ts")],
  env: { OPENCODE_WORKBENCH_PACKAGE_VERSION: version },
  stdout: "inherit",
  stderr: "inherit",
}).output()
if (!packaged.success) Deno.exit(packaged.code || 1)

const installed = await code(["--install-extension", vsix, "--force"])
if (!installed.success) Deno.exit(installed.code || 1)

const listed = await code(["--list-extensions", "--show-versions"], "null", "piped")
if (!listed.success || !new TextDecoder().decode(listed.stdout).split(/\r?\n/).includes(`${extensionID}@${version}`)) {
  throw new Error(`VS Code did not report installed extension ${extensionID}@${version}`)
}
if (legacyExtensionID !== extensionID) await code(["--uninstall-extension", legacyExtensionID], "null")

console.log(`Installed OpenCode Workbench ${version} (local development build)`)
