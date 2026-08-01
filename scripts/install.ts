import { basename, dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

const root = dirname(dirname(fromFileUrl(import.meta.url)))
const manifest = JSON.parse(await Deno.readTextFile(join(root, "package.json"))) as { version: string }
const extensionManifest = JSON.parse(await Deno.readTextFile(join(root, "packages", "vscode-extension", "package.json"))) as {
  name: string
  publisher: string
}
const extensionID = `${extensionManifest.publisher}.${extensionManifest.name}`
const legacyExtensionID = "opencode-workbench.opencode-workbench-vscode"
const home = Deno.env.get("HOME")
if (!home) throw new Error("HOME is required")

const installRoot = join(home, ".local", "lib", "opencode-workbench")
const versionRoot = join(installRoot, manifest.version)
await Deno.mkdir(versionRoot, { recursive: true, mode: 0o755 })
await Deno.copyFile(join(root, "dist", "opencode-plugin.js"), join(versionRoot, "opencode-plugin.js"))

const temporaryLink = join(installRoot, `.current-${crypto.randomUUID()}`)
await Deno.symlink(manifest.version, temporaryLink, { type: "dir" })
const current = join(installRoot, "current")
let previousVersion: string | undefined
try {
  const info = await Deno.lstat(current)
  if (!info.isSymlink) throw new Error(`Refusing to replace non-symlink path: ${current}`)
  previousVersion = basename(await Deno.realPath(current))
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error
}
const configRoot = join(home, ".config", "opencode-workbench")
const environmentPath = join(configRoot, "server.env")
await Deno.mkdir(configRoot, { recursive: true, mode: 0o700 })
try {
  const info = await Deno.lstat(environmentPath)
  if (!info.isFile || info.isSymlink || (info.mode !== null && (info.mode & 0o077) !== 0)) {
    throw new Error(`Server environment must be an owner-only regular file: ${environmentPath}`)
  }
  const contents = await Deno.readTextFile(environmentPath)
  if (!/^OPENCODE_SERVER_USERNAME=[A-Za-z0-9._-]{1,64}\nOPENCODE_SERVER_PASSWORD=[A-Za-z0-9._~-]{32,256}\n$/.test(contents)) {
    throw new Error(`Server environment is invalid: ${environmentPath}`)
  }
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, "0")).join("")
  await Deno.writeTextFile(environmentPath, `OPENCODE_SERVER_USERNAME=opencode\nOPENCODE_SERVER_PASSWORD=${secret}\n`, {
    createNew: true,
    mode: 0o600,
  })
}

const vsix = join(root, "dist", `opencode-workbench-vscode-${manifest.version}.vsix`)
await Deno.copyFile(vsix, join(versionRoot, `opencode-workbench-vscode-${manifest.version}.vsix`))
async function installVsix(path: string): Promise<boolean> {
  const result = await new Deno.Command("code", {
    args: ["--install-extension", path, "--force"],
    stdout: "inherit",
    stderr: "inherit",
  }).output()
  return result.success
}

async function uninstallExtension(extension: string): Promise<void> {
  const listed = await new Deno.Command("code", { args: ["--list-extensions"], stdout: "piped", stderr: "null" }).output()
  if (!listed.success || !new TextDecoder().decode(listed.stdout).split(/\r?\n/).includes(extension)) return
  const result = await new Deno.Command("code", {
    args: ["--uninstall-extension", extension],
    stdout: "inherit",
    stderr: "inherit",
  }).output()
  if (!result.success) throw new Error(`Could not uninstall extension ${extension}`)
}

async function extensionIDForVersion(version: string): Promise<string> {
  try {
    const release = JSON.parse(await Deno.readTextFile(join(installRoot, version, "release.json"))) as {
      vscodeExtension?: { id?: string }
    }
    if (release.vscodeExtension?.id) return release.vscodeExtension.id
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return version.startsWith("0.1.") ? legacyExtensionID : extensionID
}

async function restorePreviousSelection(): Promise<void> {
  if (!previousVersion) {
    await Deno.remove(current).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    })
    return
  }
  const restoreLink = join(installRoot, `.restore-${crypto.randomUUID()}`)
  await Deno.symlink(previousVersion, restoreLink, { type: "dir" })
  await Deno.rename(restoreLink, current)
}

async function restorePreviousExtension(): Promise<string | undefined> {
  if (!previousVersion || previousVersion === manifest.version) return previousVersion ? extensionIDForVersion(previousVersion) : undefined
  const previousVsix = join(installRoot, previousVersion, `opencode-workbench-vscode-${previousVersion}.vsix`)
  try {
    await Deno.stat(previousVsix)
    if (!await installVsix(previousVsix)) throw new Error(`Could not restore OpenCode Workbench ${previousVersion}`)
    return await extensionIDForVersion(previousVersion)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
    return undefined
  }
}

const result = await installVsix(vsix)
if (!result) {
  const previousExtensionID = await restorePreviousExtension()
  if (!previousVersion || previousExtensionID !== extensionID) await uninstallExtension(extensionID)
  await Deno.remove(temporaryLink).catch(() => undefined)
  Deno.exit(1)
}
let switched = false
try {
  await Deno.rename(temporaryLink, current)
  switched = true
  if (legacyExtensionID !== extensionID) await uninstallExtension(legacyExtensionID)
} catch (error) {
  if (switched) await restorePreviousSelection()
  const previousExtensionID = await restorePreviousExtension()
  if (!previousVersion || previousExtensionID !== extensionID) await uninstallExtension(extensionID)
  await Deno.remove(temporaryLink).catch(() => undefined)
  throw error
}

console.log(`Installed OpenCode Workbench ${manifest.version}`)
