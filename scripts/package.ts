import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const extension = join(root, "packages", "vscode-extension")
const manifest = JSON.parse(await Deno.readTextFile(join(root, "package.json"))) as { version: string }
const overrideVersion = Deno.env.get("OPENCODE_WORKBENCH_PACKAGE_VERSION")
if (overrideVersion && !/^\d+\.\d+\.\d+-dev\.\d{8}\.t\d{6}$/.test(overrideVersion)) throw new Error(`Invalid local package version: ${overrideVersion}`)
const packageVersion = overrideVersion ?? manifest.version
const output = join(root, "dist", `opencode-workbench-vscode-${packageVersion}.vsix`)
const packagedReadme = join(extension, ".marketplace-readme.md")
await Deno.copyFile(join(root, "README.md"), packagedReadme)
const command = new Deno.Command(Deno.execPath(), {
  cwd: extension,
  args: [
    "run",
    "-A",
    join(root, "node_modules", "@vscode", "vsce", "vsce"),
    "package",
    ...(overrideVersion ? [overrideVersion, "--no-update-package-json"] : []),
    "--no-dependencies",
    "--readme-path",
    ".marketplace-readme.md",
    "--out",
    output,
  ],
  stdout: "inherit",
  stderr: "inherit",
})
const result = await command.output().finally(() => Deno.remove(packagedReadme))
if (!result.success) Deno.exit(result.code)
