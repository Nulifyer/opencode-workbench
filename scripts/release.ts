import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

interface PackageManifest {
  name?: string
  publisher?: string
  version: string
  engines?: { vscode?: string }
  dependencies?: Record<string, string>
  compatibility?: { minimumOpenCode?: string }
}

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const dist = join(root, "dist")
const readManifest = async (path: string): Promise<PackageManifest> => JSON.parse(await Deno.readTextFile(path))
const rootManifest = await readManifest(join(root, "package.json"))
const extensionManifest = await readManifest(join(root, "packages", "vscode-extension", "package.json"))
const pluginManifest = await readManifest(join(root, "packages", "opencode-plugin", "package.json"))
const sharedManifest = await readManifest(join(root, "packages", "shared", "package.json"))

if (rootManifest.version !== extensionManifest.version || rootManifest.version !== pluginManifest.version ||
  rootManifest.version !== sharedManifest.version) {
  throw new Error("Root, extension, plugin, and shared versions must match")
}
const opencodeVersion = rootManifest.dependencies?.["@opencode-ai/plugin"]
if (!opencodeVersion || !/^\d+\.\d+\.\d+$/.test(opencodeVersion) ||
  pluginManifest.dependencies?.["@opencode-ai/plugin"] !== opencodeVersion) {
  throw new Error("Root and plugin must use the same exact @opencode-ai/plugin version")
}
const minimumOpenCode = rootManifest.compatibility?.minimumOpenCode
if (!minimumOpenCode || !/^\d+\.\d+\.\d+$/.test(minimumOpenCode)) {
  throw new Error("Root compatibility.minimumOpenCode must be an exact semantic version")
}
const versionParts = (version: string): number[] => version.split(".").map(Number)
const compareVersions = (left: string, right: string): number => {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}
const minimumMajor = versionParts(minimumOpenCode)[0]
if (minimumMajor !== versionParts(opencodeVersion)[0] || compareVersions(minimumOpenCode, opencodeVersion) > 0) {
  throw new Error("Minimum OpenCode version must share the build dependency major and not exceed its version")
}
const nextOpenCodeMajor = `${minimumMajor + 1}.0.0`
const extensionID = `${extensionManifest.publisher ?? ""}.${extensionManifest.name ?? ""}`
if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(extensionID)) {
  throw new Error("VS Code extension publisher and name must form a valid Marketplace identifier")
}
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
    minimumOpenCode,
    maximumOpenCodeExclusive: nextOpenCodeMajor,
    minimumVSCode: (extensionManifest.engines?.vscode ?? "^1.95.0").replace(/^\^/, ""),
  },
  vscodeExtension: { id: extensionID },
  assets,
}
await Deno.writeTextFile(join(dist, "release.json"), `${JSON.stringify(release, null, 2)}\n`)
await Deno.writeTextFile(join(dist, "SHA256SUMS"), `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`)
