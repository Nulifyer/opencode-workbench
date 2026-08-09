import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.2"

const root = dirname(dirname(dirname(dirname(fromFileUrl(import.meta.url)))))
const version = "0.3.0-dev.20990101.t000000"
const output = join(root, "dist", `opencode-workbench-vscode-${version}.vsix`)

async function command(args: string[], env?: Record<string, string>): Promise<void> {
  const result = await new Deno.Command(Deno.execPath(), { cwd: root, args, env, stdout: "piped", stderr: "piped" }).output()
  if (!result.success) {
    const detail = new TextDecoder().decode(result.stderr) || new TextDecoder().decode(result.stdout)
    throw new Error(`Command failed (${args.join(" ")}):\n${detail}`)
  }
}

async function zipEntries(file: string, wanted: Set<string>): Promise<Map<string, Uint8Array>> {
  const yauzl = await import("npm:yauzl@3.4.0") as unknown as {
    open(path: string, options: { lazyEntries: boolean }, callback: (error: Error | null, zip: {
      readEntry(): void
      close(): void
      on(event: string, callback: (...args: any[]) => void): void
      openReadStream(entry: unknown, callback: (error: Error | null, stream: {
        on(event: string, callback: (...args: any[]) => void): void
      }) => void): void
    }) => void): void
  }
  return await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) {
        reject(error)
        return
      }
      const values = new Map<string, Uint8Array>()
      zip.on("error", reject)
      zip.on("end", () => resolve(values))
      zip.on("entry", (entry: { fileName: string }) => {
        if (!wanted.has(entry.fileName)) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError)
            return
          }
          const chunks: Uint8Array[] = []
          stream.on("data", (chunk: Uint8Array) => chunks.push(chunk))
          stream.on("error", reject)
          stream.on("end", () => {
            const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
            const content = new Uint8Array(length)
            let offset = 0
            for (const chunk of chunks) {
              content.set(chunk, offset)
              offset += chunk.length
            }
            values.set(entry.fileName, content)
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
}

Deno.test("packages the override version, root README, and managed plugin", async () => {
  await Deno.remove(output).catch(() => undefined)
  try {
    await command(["task", "build"])
    await command(["run", "-A", join(root, "scripts", "package.ts")], { OPENCODE_WORKBENCH_PACKAGE_VERSION: version })
    const names = new Set(["extension/package.json", "extension/readme.md", "extension/dist/opencode-plugin.js"])
    const entries = await zipEntries(output, names)
    const manifest = JSON.parse(new TextDecoder().decode(entries.get("extension/package.json"))) as { version?: string }
    if (manifest.version !== version) throw new Error(`Packaged version was ${manifest.version ?? "missing"}`)
    const readme = new TextDecoder().decode(entries.get("extension/readme.md"))
    if (!readme.startsWith("# OpenCode Workbench") || !readme.includes("OpenCode still owns the models, agents, tools, sessions, permissions, and")) {
      throw new Error("VSIX did not contain the repository README")
    }
    if (!entries.get("extension/dist/opencode-plugin.js")?.length) throw new Error("VSIX did not contain the managed OpenCode plugin")
  } finally {
    await Deno.remove(output).catch(() => undefined)
  }
})
