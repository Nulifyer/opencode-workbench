import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

interface PackageManifest {
  version: string
  engines?: { vscode?: string }
  dependencies?: Record<string, string>
}

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const dist = join(root, "dist")
const readManifest = async (path: string): Promise<PackageManifest> => JSON.parse(await Deno.readTextFile(path))
const rootManifest = await readManifest(join(root, "package.json"))
const extensionManifest = await readManifest(join(root, "packages", "vscode-extension", "package.json"))
const pluginManifest = await readManifest(join(root, "packages", "opencode-plugin", "package.json"))

if (rootManifest.version !== extensionManifest.version || rootManifest.version !== pluginManifest.version) {
  throw new Error("Root, extension, and plugin versions must match")
}
const opencodeVersion = rootManifest.dependencies?.["@opencode-ai/plugin"]
if (!opencodeVersion || !/^\d+\.\d+\.\d+$/.test(opencodeVersion) ||
  pluginManifest.dependencies?.["@opencode-ai/plugin"] !== opencodeVersion) {
  throw new Error("Root and plugin must use the same exact @opencode-ai/plugin version")
}
const nextOpenCodeMajor = `${Number(opencodeVersion.split(".", 1)[0]) + 1}.0.0`
const tag = Deno.env.get("GITHUB_REF_NAME")
if (tag && tag !== `v${rootManifest.version}`) {
  throw new Error(`Tag ${tag} does not match package version ${rootManifest.version}`)
}

const names = ["opencode-plugin.js", `opencode-workbench-vscode-${rootManifest.version}.vsix`]
const assets = []
for (const name of names) {
  const bytes = await Deno.readFile(join(dist, name))
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  const sha256 = Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")
  assets.push({ name, bytes: bytes.byteLength, sha256 })
}

const release = {
  schemaVersion: 1,
  version: rootManifest.version,
  protocolVersion: 1,
  compatibility: {
    minimumOpenCode: opencodeVersion,
    maximumOpenCodeExclusive: nextOpenCodeMajor,
    minimumVSCode: (extensionManifest.engines?.vscode ?? "^1.95.0").replace(/^\^/, ""),
  },
  assets,
}
await Deno.writeTextFile(join(dist, "release.json"), `${JSON.stringify(release, null, 2)}\n`)
await Deno.writeTextFile(join(dist, "SHA256SUMS"), `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`)
