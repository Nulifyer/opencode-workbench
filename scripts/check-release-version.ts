import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const manifests = await Promise.all([
  "package.json",
  "packages/vscode-extension/package.json",
  "packages/opencode-plugin/package.json",
  "packages/shared/package.json",
].map(async (path) => JSON.parse(await Deno.readTextFile(join(root, path))) as { version: string }))
const version = manifests[0].version
if (manifests.some((manifest) => manifest.version !== version)) {
  throw new Error("Root, extension, plugin, and shared versions must match")
}

const changelog = await Deno.readTextFile(join(root, "CHANGELOG.md"))
if (!new RegExp(`^## ${version.replaceAll(".", "\\.")} - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
  throw new Error(`CHANGELOG.md needs a dated ${version} release entry`)
}

async function git(args: string[]): Promise<{ success: boolean; output: string }> {
  const result = await new Deno.Command("git", { cwd: root, args, stdout: "piped", stderr: "null" }).output()
  return { success: result.success, output: new TextDecoder().decode(result.stdout).trim() }
}

const releaseTag = `v${version}`
const tagged = await git(["rev-parse", "--verify", `${releaseTag}^{commit}`])
if (tagged.success) {
  const head = await git(["rev-parse", "HEAD"])
  if (!head.success || head.output !== tagged.output) {
    throw new Error(
      `${releaseTag} already points to an older commit; bump every package version and add its changelog entry before releasing`,
    )
  }
}

const ref = Deno.env.get("GITHUB_REF_NAME")
if (ref && ref !== releaseTag) throw new Error(`Tag ${ref} does not match package version ${version}`)
