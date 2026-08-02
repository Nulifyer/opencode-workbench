import { execFile as execFileCallback, spawn, type ChildProcessByStdio } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constants as fsConstants, promises as fs } from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import { pathToFileURL } from "node:url"
import { parse, printParseErrorCode } from "jsonc-parser"
import type { OpenCodeConnection } from "./opencode-client.js"

const MINIMUM_VERSION = [1, 18, 11] as const
const MAXIMUM_VERSION = [2, 0, 0] as const
const STARTUP_TIMEOUT = 15_000
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>

export interface ManagedServerOptions {
  directory: string
  extensionPath: string
  executablePath?: string
  bridgeID?: string
  output?: { appendLine(value: string): void }
  onRestart?(connection: OpenCodeConnection): void
  onFailure?(message: string): void
}

export function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return undefined
  const version = match.slice(1, 4).map(Number) as [number, number, number]
  return version.every(Number.isSafeInteger) ? version : undefined
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

export function supportedVersion(value: string): boolean {
  const version = parseVersion(value)
  return Boolean(version && compareVersion(version, MINIMUM_VERSION) >= 0 && compareVersion(version, MAXIMUM_VERSION) < 0)
}

export function parseListeningAddress(line: string): string | undefined {
  const match = /^opencode server listening on http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(line.trim())
  if (!match) return undefined
  const port = Number(match[1])
  return port >= 1 && port <= 65_535 ? `http://127.0.0.1:${port}` : undefined
}

export function managedConfigContent(existing: string | undefined, pluginUrl: string): string {
  const errors: Array<{ error: number; offset: number; length: number }> = []
  const parsed = existing?.trim() ? parse(existing, errors, { allowTrailingComma: true, disallowComments: false }) : {}
  if (errors.length) throw new Error(`OPENCODE_CONFIG_CONTENT is invalid: ${printParseErrorCode(errors[0]!.error)}`)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("OPENCODE_CONFIG_CONTENT must contain an object")
  const config = parsed as Record<string, unknown>
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error("OPENCODE_CONFIG_CONTENT plugin must be an array")
  const plugins = (config.plugin ?? []) as unknown[]
  const validPlugin = (value: unknown): boolean => typeof value === "string" || (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" &&
    typeof value[1] === "object" && value[1] !== null && !Array.isArray(value[1]))
  if (!plugins.every(validPlugin)) throw new Error("OPENCODE_CONFIG_CONTENT plugin entries must be URLs or [URL, options] tuples")
  const matches = (value: unknown) => value === pluginUrl || (Array.isArray(value) && value[0] === pluginUrl)
  return JSON.stringify({ ...config, plugin: plugins.some(matches) ? plugins : [...plugins, pluginUrl] })
}

async function executableCandidate(candidate: string): Promise<string | undefined> {
  try {
    const resolved = await fs.realpath(candidate)
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return undefined
    if (process.platform !== "win32") await fs.access(resolved, fsConstants.X_OK)
    return resolved
  } catch {
    return undefined
  }
}

export async function resolveOpenCodeExecutable(configured?: string): Promise<string> {
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("Managed OpenCode executable path must be absolute")
    const resolved = await executableCandidate(configured)
    if (!resolved) throw new Error(`OpenCode executable is unavailable: ${configured}`)
    return resolved
  }
  const names = process.platform === "win32" ? ["opencode.exe", "opencode.cmd", "opencode.bat"] : ["opencode"]
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue
    for (const name of names) {
      const resolved = await executableCandidate(path.join(directory, name))
      if (resolved) return resolved
    }
  }
  throw new Error("OpenCode executable was not found on VS Code's PATH")
}

function runVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCallback(executable, ["--version"], { timeout: 5_000, maxBuffer: 4_096, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Could not run OpenCode: ${error.message}`))
      else {
        const value = `${stdout}${stderr}`.trim()
        if (!supportedVersion(value)) reject(new Error(`Unsupported OpenCode version: ${value || "unknown"}; expected 1.18.11 or newer within major version 1`))
        else resolve(value)
      }
    })
  })
}

async function packagedPlugin(extensionPath: string): Promise<string> {
  const root = await fs.realpath(extensionPath)
  const plugin = await fs.realpath(path.join(root, "dist", "opencode-plugin.js"))
  const relative = path.relative(root, plugin)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !(await fs.stat(plugin)).isFile()) {
    throw new Error("Packaged OpenCode plugin is outside the extension installation")
  }
  return pathToFileURL(plugin).href
}

function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

async function probe(connection: OpenCodeConnection): Promise<void> {
  const health = new URL("/global/health", connection.baseUrl)
  const unauthenticated = await fetch(health, { signal: AbortSignal.timeout(5_000) })
  if (unauthenticated.status !== 401) throw new Error("Managed OpenCode server did not enforce authentication")
  const authenticated = await fetch(health, { headers: { Authorization: authorization(connection.username, connection.password) }, signal: AbortSignal.timeout(5_000) })
  if (!authenticated.ok) throw new Error(`Managed OpenCode health check failed (${authenticated.status})`)
  const config = new URL("/config", connection.baseUrl)
  config.searchParams.set("directory", connection.directory)
  const configured = await fetch(config, { headers: { Authorization: authorization(connection.username, connection.password) }, signal: AbortSignal.timeout(5_000) })
  if (!configured.ok) throw new Error(`Managed OpenCode configuration check failed (${configured.status})`)
}

function stopped(child: ServerProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once("exit", () => resolve()))
}

export class ManagedOpenCodeServer {
  private child?: ServerProcess
  private stopping = false
  private restartCount = 0
  private restartTimer?: NodeJS.Timeout
  private generation = 0
  private password = ""

  constructor(private readonly options: ManagedServerOptions) {}

  async start(): Promise<OpenCodeConnection> {
    this.stopping = false
    return await this.startProcess(false)
  }

  private async startProcess(restart: boolean): Promise<OpenCodeConnection> {
    const generation = ++this.generation
    const executable = await resolveOpenCodeExecutable(this.options.executablePath)
    const version = await runVersion(executable)
    const pluginUrl = await packagedPlugin(this.options.extensionPath)
    const username = `workbench-${randomBytes(16).toString("hex")}`
    const password = randomBytes(32).toString("base64url")
    this.password = password
    const env = {
      ...process.env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      ...(this.options.bridgeID ? { OPENCODE_WORKBENCH_BRIDGE_ID: this.options.bridgeID } : {}),
      OPENCODE_CONFIG_CONTENT: managedConfigContent(process.env.OPENCODE_CONFIG_CONTENT, pluginUrl),
    }
    this.options.output?.appendLine(`Starting OpenCode ${version} for ${this.options.directory}`)
    const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: this.options.directory,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.child = child
    let settled = false
    const connection = await new Promise<OpenCodeConnection>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Managed OpenCode server did not become ready within 15 seconds")), STARTUP_TIMEOUT)
      const buffers = { stdout: "", stderr: "" }
      const sensitive = [username, password, authorization(username, password), process.env.OPENCODE_CONFIG_CONTENT,
        ...Object.entries(process.env).filter(([key, value]) => value && /(?:TOKEN|KEY|SECRET|PASSWORD|AUTH)/i.test(key)).map(([, value]) => value),
      ].filter((value): value is string => typeof value === "string" && value.length >= 4).sort((left, right) => right.length - left.length).slice(0, 200)
      let loggedLines = 0
      const redact = (value: string) => sensitive.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), value)
      const finish = (error?: Error, value?: OpenCodeConnection) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value!)
      }
      const lines = (chunk: Buffer, source: "stdout" | "stderr") => {
        const text = buffers[source] + chunk.toString("utf8")
        const values = text.split(/\r?\n/)
        buffers[source] = values.pop()?.slice(-8_192) ?? ""
        for (const line of values) {
          const baseUrl = parseListeningAddress(line)
          if (baseUrl) {
            finish(undefined, { baseUrl, username, password, directory: this.options.directory })
          } else if (line.trim() && loggedLines < 1_000) {
            loggedLines += 1
            this.options.output?.appendLine(`${source}: ${redact(line.slice(0, 4_096))}`)
            if (loggedLines === 1_000) this.options.output?.appendLine("Further managed server output was suppressed")
          }
        }
      }
      child.stdout.on("data", (chunk: Buffer) => lines(chunk, "stdout"))
      child.stderr.on("data", (chunk: Buffer) => lines(chunk, "stderr"))
      child.once("error", (error) => finish(new Error(`Could not start managed OpenCode server: ${error.message}`)))
      child.once("exit", (code, signal) => finish(new Error(`Managed OpenCode server exited before startup (${signal ?? code ?? "unknown"})`)))
    }).catch(async (error) => {
      await this.terminate(child)
      throw error
    })
    if (generation !== this.generation || this.stopping) {
      await this.terminate(child)
      throw new Error("Managed OpenCode startup was cancelled")
    }
    await probe(connection).catch(async (error) => {
      await this.terminate(child)
      throw error
    })
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Managed OpenCode server exited during readiness checks")
    child.once("exit", () => this.unexpectedExit(generation))
    this.options.output?.appendLine(`Managed OpenCode server ready at ${connection.baseUrl}`)
    if (restart) this.options.onRestart?.(connection)
    return connection
  }

  private unexpectedExit(generation: number): void {
    if (this.stopping || generation !== this.generation) return
    this.scheduleRestart()
  }

  private scheduleRestart(lastError?: unknown): void {
    if (this.stopping) return
    if (this.restartCount >= 3) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : ""
      this.options.onFailure?.(`Managed OpenCode server stopped after three restart attempts${detail}`)
      return
    }
    const delay = 1_000 * 2 ** this.restartCount
    this.restartCount += 1
    this.options.output?.appendLine(`Managed OpenCode server exited; restarting in ${delay / 1_000}s`)
    this.restartTimer = setTimeout(() => void this.startProcess(true).catch((error) => this.scheduleRestart(error)), delay)
  }

  private async terminate(child: ServerProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGTERM")
    await Promise.race([stopped(child), new Promise((resolve) => setTimeout(resolve, 3_000))])
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.generation += 1
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const child = this.child
    this.child = undefined
    this.password = ""
    if (child) await this.terminate(child)
  }

  dispose(): void {
    void this.stop()
  }
}
