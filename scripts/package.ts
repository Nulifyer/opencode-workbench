import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const manifest = JSON.parse(await Deno.readTextFile(join(root, "package.json"))) as { version: string }
const output = join(root, "dist", `opencode-workbench-vscode-${manifest.version}.vsix`)
const command = new Deno.Command(Deno.execPath(), {
  cwd: join(root, "packages", "vscode-extension"),
  args: ["run", "-A", "npm:@vscode/vsce@3.6.0", "package", "--no-dependencies", "--out", output],
  stdout: "inherit",
  stderr: "inherit",
})
const result = await command.output()
if (!result.success) Deno.exit(result.code)
